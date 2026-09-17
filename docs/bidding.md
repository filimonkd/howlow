# Bidding

The bidding engine is the most transactional part of HOWLOW. A bid moves money,
consumes a scarce allowance, and contributes to an outcome that will award a
physical item — so every rule about it is enforced by PostgreSQL inside one
transaction, and there is exactly one code path that can place one.

That path is **`bidService.submitBids()`**, in `apps/api/src/modules/bidding`.
The HTTP controller calls it. The Telegram handler calls it. Nothing else
places a bid, and the ESLint boundary rule refuses to let anything outside the
module import `bidRepository`. Two implementations would eventually disagree,
and what they would disagree about is people's money.

## The submission contract

```
POST /api/v1/auctions/:publicId/bids
Authorization: Bearer <access token>
Idempotency-Key: <8–255 characters, a UUID by convention>
Content-Type: application/json

{ "amountsMinor": ["100", "300", "700", "1300"] }
```

`201` on acceptance:

```json
{
  "auctionId": "…",
  "bids": [
    {
      "id": "…",
      "amountMinor": "100",
      "feeMinor": "500",
      "currency": "ETB",
      "channel": "web",
      "status": "submitted",
      "submittedAt": "…"
    }
  ],
  "totalFeeMinor": "2000",
  "currency": "ETB",
  "bidCount": 4,
  "bidsRemaining": 21,
  "walletBalanceMinor": "98000",
  "replayed": false,
  "submittedAt": "…"
}
```

`GET` on the same path returns the caller's own bids and allowance. There is no
endpoint anywhere that returns another bidder's amounts, or how many bidders
hold one.

**Amounts are strings.** `Number` loses precision above 2<sup>53</sup> and JSON
has no integer type, so an amount that arrived as a number could not be trusted
to be the amount that was sent. Strings all the way to PostgreSQL's `bigint`.

**`Idempotency-Key` is required, not optional.** A client that retried after a
timeout without one could not distinguish "my bids were placed" from "my bids
were not placed", and the safe assumption — retry — would charge twice.
Requiring it makes the safe assumption correct.

## Batch semantics

A single bid is a batch of one. There is no separate single-bid path, because
two paths would be two engines.

**A batch is all or nothing.** If any amount in the request is invalid, already
held, over the limit, or unaffordable, the whole request fails and nothing is
written or charged. Partial acceptance was considered and rejected: a client
that asked for four amounts and got three could not tell which three without
re-reading, and would have been charged for a submission it did not make.

The fee is `bid_fee_minor × number of bids`, charged as **one** ledger entry
for the batch — not one per bid.

## Validation

Cheap checks run before the transaction, so a malformed or ineligible request
is refused without taking the auction lock at all; in the last seconds of a
popular auction that lock is the most contended row in the platform. Everything
that matters is then re-checked inside the transaction against the locked row.

| Before the transaction                      | Inside the transaction, under the lock                            |
| ------------------------------------------- | ----------------------------------------------------------------- |
| authenticated caller                        | the auction exists and is `live`                                  |
| active account, verified phone              | database time is within `[starts_at, ends_at)`                    |
| idempotency key present and usable          | amount range and increment alignment, re-read from the locked row |
| amounts non-empty, ≤ 100, positive integers | the bid limit, against the locked participant row                 |
| no repeat inside the request                | amounts the caller already holds                                  |
| rate limits                                 | the wallet balance                                                |
|                                             | the auction still holds its inventory unit                        |

### Amount rules

For every amount:

```
amount >= min_bid_minor
amount <= max_bid_minor
(amount - min_bid_minor) % bid_increment_minor = 0
```

All in `bigint`. No amount is ever converted to a float. Alignment is measured
**from the minimum**, not from zero, so a 250..1250 auction stepping by 500
accepts 250, 750 and 1250 and refuses 500.

### Auction state

Only `live` accepts bids. `draft`, `pending_approval`, `scheduled`, `closing`,
`calculating`, `completed`, `cancelled` and `suspended` all refuse — and the
statuses that are not publicly visible refuse as `AUCTION_NOT_FOUND`, so the
response does not confirm that a draft exists.

The time window is checked **independently of the status**, because an auction
whose close job has not yet run is `live` with a past `ends_at` and must refuse
anyway. The clock is `clock_timestamp()`, read _after_ the auction lock is
taken — not `now()`, which is the transaction's start time. With `now()`, a
request that queued behind a hundred others would be judged against the moment
it began waiting, and a bidder could hold a transaction open across the
deadline and still be accepted. Reading after the lock means the bid is judged
at the moment it reached the front of the queue. A bid that arrives before the
deadline but waits past it is refused, and that is the honest answer.

No client clock decides anything.

## The duplicate rule

A bidder may not hold two valid bids at the same amount in the same auction.
**Two different bidders on the same amount is not a duplicate** — it is the
mechanism the auction runs on, since the winner is the lowest amount nobody
else matched.

The rule is `bids_valid_amount_unique_key`, a partial unique index on
`(auction_id, user_id, amount_minor) WHERE status = 'valid'`. It is the
arbiter, not a prior `SELECT`: two concurrent requests both run their check
before either inserts, so both see nothing. What protects the auction is that
the batch is inserted in **one statement** with `ON CONFLICT DO NOTHING`, and
the engine compares the rows returned against the amounts requested. Fewer
means the index rejected something, and the entire transaction is abandoned.

The `SELECT` that precedes it exists only so the common case gets a message
naming the amounts instead of a constraint violation. It can be stale the
instant it returns and nothing depends on it.

Partial, so voiding a bid frees its amount for a legitimate re-bid.

## The bid limit

`auctions.max_bids_per_user`, default 100, enforced against
`auction_participants.bid_count` — never a `COUNT(*)` over `bids`.

**One limit across both channels.** It is not 100 on the website plus 100 on
Telegram: there is one participant row per `(auction, user)` and the channel is
only written to the bid.

The participant row is taken with `INSERT … ON CONFLICT DO UPDATE`, which
returns exactly one row and — because `DO UPDATE` writes — holds it locked for
the rest of the transaction. `DO NOTHING` would return no row and take no lock;
that is the version of this that looks correct and races.

`(xmax = 0)` on the returned row distinguishes an insert from an update, which
is how `total_participants` is incremented exactly once per bidder however many
bids their first batch carried.

## Lock ordering — auction → product → wallet → participant

**This is the contract Phases 3 and 4 established, and Phase 5 honours it
exactly.**

1. **auction** — `auctions.lockForBidding`, a `SELECT … FOR UPDATE` on the
   auction row. The serialisation point. Every lifecycle transition takes this
   lock first too, which is what makes the rest of the list safe.
2. **product / inventory** — read **in the same transaction**, not locked.
3. **wallet** — taken inside `walletService.debit`, by primary key.
4. **participant** — `lockOrCreateParticipant`.

The order is the whole deadlock argument. A bid holds the auction row and then
asks for a wallet; a lifecycle transition holds the auction row and then asks
for a product. Nothing in the platform asks for them the other way round, so no
two transactions can each hold what the other wants. **Acquiring a wallet lock
before an auction lock anywhere — in this module or a future one —
reintroduces the cycle.**

Participant is listed after wallet but taken before the debit in the code. Both
are leaves in the order, they are never contended against each other by a third
party, and the limit has to be known before money moves. What matters is that
neither is ever taken before the auction.

### Why the inventory read is not locked

Phase 4 reserves one unit when an auction goes live. The only things that
release it — cancel, and the close path — are lifecycle transitions, every one
of which takes the auction row lock as its first act. The engine runs holding
that same lock, so no release can be in flight: the read is as authoritative as
a locked read would be.

Locking the product row instead would serialise every bidder in the auction
behind one row for no correctness gain, and re-reserving per bid would
double-count inventory.

A live auction holding no reservation is an inconsistency rather than a user
error, and the engine refuses to bid on it: the alternative is taking money for
something the platform cannot deliver.

### The read must be in the transaction

The inventory read passes the transaction, and that is load-bearing rather than
tidy. A read that checked out a second pool connection while the transaction
held the first would need two connections per bid, and `DATABASE_POOL_MAX`
concurrent bids would then deadlock the pool — every request holding one
connection and waiting for a second that only another request could release.
That is a production failure under exactly the load the last seconds of a
popular auction produce. It was found by a concurrency test hanging, not by
reading the code.

## The transaction

```
BEGIN
 1. claim the idempotency key            -- before any row lock
 2. lock the auction                     -- FOR UPDATE
 3. verify status and database time
 4. re-validate every amount
 5. verify the auction still holds its unit
 6. lock or create the participant row
 7. verify the bid limit
 8. insert the whole batch in one statement
 9. verify every requested bid landed    -- else DUPLICATE_AMOUNT
10. debit the fee                        -- walletService.debit, same tx
11. attach the wallet entry to the bids
12. update the participant counters
13. update the auction counters
14. write the audit row
15. store the response for replay
COMMIT
```

Anything failing rolls back everything. There are no partial batches.

## Idempotency

Request-level, in the existing `idempotency_keys` table, scope `bids.submit`.

The key is claimed as the **transaction's first act, before any row lock**.
That ordering does three things at once:

- **A retry of a committed request replays.** The key row committed with the
  batch, so the retry reads the stored response and charges nothing.
- **A retry of a _failed_ request may proceed.** The key row rolled back with
  everything else. A bid refused for insufficient funds must not burn the
  client's key — the client fixes the balance and retries the same intent.
- **A concurrent duplicate queues in the cheapest possible place.** The second
  request blocks on the uncommitted unique index entry for `(scope, key)` while
  holding no auction, wallet or participant lock.

Claiming the key in its own transaction first would make a rolled-back bid
permanently consume it, and would need a compensating write on every failure
path.

**What identifies a request** is the auction, the user and the _sorted_ amounts
— sorted because `[10, 20]` and `[20, 10]` ask for the same thing. Channel,
address and device are excluded: the same intent retried from a reconnected
phone on a different address is the same intent.

A replay answers with the **original numbers**, from a snapshot stored against
the key, while the bid rows themselves are re-read. A client that retried twice
and saw its balance drift would have no way to tell a replay from a second
charge.

Same key with different amounts, a different auction, or a different user is
`IDEMPOTENCY_CONFLICT`. Serving the first response to a client asking for
something else would be worse than refusing, because the client would believe
bids it never placed had been accepted.

There is a second, row-level backstop: `bids_idempotency_amount_unique` on
`(auction_id, user_id, idempotency_key, amount_minor)`. Phase 1's version
omitted the amount and so allowed only one bid row per key, which every batch
would have violated on its second row; migration 0013 replaces it. It is not
redundant with the duplicate index, which is partial on `status = 'valid'`: a
retried request cannot resurrect an amount that was voided in between.

## Wallet integration

Through `walletService.debit('bid_fee', …, tx)` — the Phase 3 service, in the
bid's own transaction. The bidding module never touches `wallets` or
`wallet_entries`; the ESLint boundary enforces it. The balance and its ledger
entry are written together or not at all.

The wallet's key space spans every operation on a wallet, so the bid's
idempotency key is namespaced (`bid_fee:<key>`) to keep a client reusing one
key for a bid and a deposit from colliding.

**A zero fee moves no money and writes no ledger entry.** `wallet_entries`
records movements of money, and the schema refuses a zero-value row outright
(`wallet_entries_amount_non_zero`). The balance is still read for the response.

Wallet refusals are restated in the bid vocabulary. The wallet raises errors
carrying `details.walletError`, which is right for wallet callers; a bidding
client is told to branch on `details.bidError`, so a debit refused for
insufficient funds would otherwise arrive with the correct status and no bid
code at all, and every client would fall through to a generic message on the
two failures bidders hit most. Anything that is not a bidding condition — a
currency mismatch, a ledger integrity failure — travels unchanged rather than
being dressed up as one.

## Counters

Maintained transactionally, under locks the engine already holds. They are
authoritative for the live UI; nothing is computed from events.

| Counter                                 | When                                |
| --------------------------------------- | ----------------------------------- |
| `auction_participants.bid_count`        | every accepted batch, `+ n`         |
| `auction_participants.total_fees_minor` | every accepted batch, `+ fee`       |
| `auction_participants.first_bid_at`     | set once, by `COALESCE`             |
| `auction_participants.last_bid_at`      | every accepted batch                |
| `auctions.total_bids`                   | every accepted batch, `+ n`         |
| `auctions.total_participants`           | once per bidder, on their first bid |

`auctions.total_bids` and `total_participants` are added by migration 0013.
Phase 1 put them on `auction_results`, which is the frozen record written when
an auction settles; a live page needs the same two numbers while bidding is
open. `bidding.recountAuction()` recomputes them from the rows so a test or an
operator can prove they agree — if they ever do not, the counter update and the
insert have come apart, which is a bug and not something to paper over by
recomputing on read.

## Concurrency strategy

The auction row lock serialises everything on one auction. Within that, each
resource has its own guarantee:

| Race                                  | What decides it                                                   |
| ------------------------------------- | ----------------------------------------------------------------- |
| two batches at the bid limit          | the participant row lock (and the auction lock — either suffices) |
| the same amount twice from one bidder | `bids_valid_amount_unique_key`, via the insert count              |
| the same amount from two bidders      | nothing — both succeed, by design                                 |
| two batches against one balance       | the wallet row lock inside `applyMovement`                        |
| many bidders, one auction             | the auction row lock, around the counter update                   |
| a bid across the deadline             | `clock_timestamp()` read after the lock                           |
| the same request twice at once        | the `(scope, key)` unique index on `idempotency_keys`             |

`tests/db/bidding-concurrency.test.ts` covers all seven. Every case there was
checked by deliberately removing the mechanism it exercises and confirming it
fails; with the auction and participant locks both removed, six of the thirteen
fail.

## Rate limits

Redis, through the existing limiter, applied **inside the engine** rather than
as HTTP middleware — three of the four are keyed by the auction, which is not
known until the reference has been resolved, and applying them in the service
means Telegram gets exactly the same limits without a second copy.

| Limit                       | Subject        | Budget       |
| --------------------------- | -------------- | ------------ |
| `bidSubmit`                 | user           | 60 / minute  |
| `bidSubmitPerAuction`       | user + auction | 20 / minute  |
| `bidSubmitPerIp`            | address        | 120 / minute |
| `bidSubmitPerAuctionGlobal` | auction        | 600 / minute |

Requests, not amounts: one request may legitimately carry a hundred bids. The
per-IP limit is the loosest because a household, an office or a carrier NAT
legitimately shares one address.

**None of these stands in for `max_bids_per_user`.** That is a durable rule
enforced against the participant row inside the transaction; a Redis counter
that may be lost on a restart and fails open could never be trusted with it.

### Resetting rate-limit state for tests

The limiter is production policy and is never weakened for tests. Every smoke
script calls `clearRateLimits()` (`scripts/clear-rate-limits.mjs`) before
driving the API, which deletes `ratelimit:*` and nothing else. That makes the
budget per-script rather than per-hour; it does not raise it, so a script that
grows past five registrations will see `429` again. Reuse an account or split
the script.

## The website flow

`/auctions/:reference` → the bid panel.

Bid entry takes one amount or many, separated by spaces. Reviewing shows every
amount, the count, the total fee and the wallet balance; nothing is charged
until Confirm.

**One idempotency key per intention**, minted with the confirmation and reused
for every retry of it — a double-click, a dropped response or a retry all
replay the first answer. A refusal worth retrying returns to the confirmation
holding the same key.

Refusals are mapped from `details.bidError`, with the server's own public
sentence as the fallback so an unmapped code degrades to something true.

## The Telegram flow

```
/auctions → select an auction → 💸 Place a bid
          → send "1 3 7 11 19 27 35"
          → confirmation: every amount, the count, the fee, the wallet
          → ✅ Confirm  |  ✖ Cancel
          → receipt
```

The handler sequences three updates and nothing else: no SQL, no wallet, no bid
counting, no auction rule. It calls the same `submitBids()`.

The idempotency key is minted when the confirmation is **shown**, not when
Confirm is pressed, so tapping Confirm twice replays the first submission
instead of paying for a second one.

Confirm and Cancel carry bare verbs, `bc` and `bx`. The auction, the amounts
and the key live in a server-side draft keyed by the Telegram user, so a
crafted payload cannot submit amounts the user never saw and a replayed one
cannot aim at a different auction. Drafts live in a short-TTL Redis store
(`shared/conversation.ts`): a half-finished sentence is not a bidding rule, and
nothing there is read to decide whether a bid is valid.

## Error codes

Every refusal carries a stable code in `details.bidError`. The transport `code`
decides the HTTP status; the bid code is what a client may branch on.

| `bidError`                | HTTP | Meaning                                             |
| ------------------------- | ---- | --------------------------------------------------- |
| `AUCTION_NOT_LIVE`        | 409  | not accepting bids, or holding no inventory         |
| `AUCTION_NOT_STARTED`     | 409  | live by status, before `starts_at`                  |
| `AUCTION_ENDED`           | 409  | past `ends_at` by database time                     |
| `AMOUNT_OUT_OF_RANGE`     | 400  | outside `[min, max]`                                |
| `AMOUNT_NOT_ALIGNED`      | 400  | in range, off the increment ladder                  |
| `AMOUNT_INVALID`          | 400  | not a positive integer                              |
| `TOO_MANY_AMOUNTS`        | 400  | more than 100 in one request                        |
| `DUPLICATE_AMOUNT`        | 409  | the **caller's own** amount, repeated               |
| `BID_LIMIT_EXCEEDED`      | 409  | over `max_bids_per_user`                            |
| `INSUFFICIENT_FUNDS`      | 422  | the wallet cannot cover the fee                     |
| `WALLET_FROZEN`           | 403  | debits are held                                     |
| `IDEMPOTENCY_CONFLICT`    | 409  | key reused for a different request                  |
| `IDEMPOTENCY_IN_PROGRESS` | 409  | defensive; unreachable with an in-transaction claim |
| `BIDDER_NOT_ELIGIBLE`     | 403  | inactive account or unverified phone                |
| `RATE_LIMITED`            | 429  | too many requests                                   |

No raw PostgreSQL error reaches a client. A unique violation the insert's
`ON CONFLICT` did not cover is translated to `DUPLICATE_AMOUNT` rather than
surfacing as a 500 with a constraint name.

## Live uniqueness — the absolute rule

**Nothing, anywhere, tells anyone whether an amount is unique.**

HOWLOW awards the lowest amount nobody else matched. A client that could ask
"is 27 taken?" would be handed the answer instead of playing, so:

- No API field exposes per-amount occupancy, a bidder count, or anything a
  client could difference across two responses to recover one.
- The only pre-close status is `submitted`. `valid` in the database is mapped to
  it; `won` and `not_winning` are Phase 6's to decide.
- `DUPLICATE_AMOUNT` is only ever about the caller's **own** bids. Telling
  someone their 27 collides with a stranger's would hand them the signal.
- The realtime event carries counts only — never an amount, a bid id or a user.
- The audit row deliberately omits the amounts, because `writeAuditLog` also
  emits a structured log line and a bidder's ladder in a log aggregator would
  be their whole strategy.

Both the API payloads and the built web bundle are checked for uniqueness
wording by `scripts/smoke-bidding.mjs`.

## Realtime

After the transaction commits, an aggregate event on `howlow:auction-stats`:

```json
{
  "event": "AUCTION_STATS",
  "auctionId": "…",
  "totalBids": 41,
  "totalParticipants": 12,
  "serverTime": "…"
}
```

Counts only, published after the commit — announcing bids that might roll back
would be worse than announcing them late. Its own channel, so a lifecycle
subscriber is not woken by every bid on a busy auction. Same at-most-once
contract as lifecycle events: the durable record is the committed rows, and the
publish never throws.

A replay publishes nothing: the counts did not change.

## Audit and fraud evidence

`bid.submitted`, one row per accepted submission, carrying the auction, the
actor, the bid count, the fee, the resulting count and whether it was a first
bid — and **not** the amounts.

Each bid row carries `channel`, `ip_address` (as `inet`), `device_hash` and
`request_id`, preserved for later analysis and never read to decide anything.
All four are immutable: the bid immutability trigger covers them, because if the
address on a bid could be edited afterwards, fraud review would be reading a
story rather than a record. No fraud scoring in Phase 5.

## Channel is provenance only

`web`, `telegram`, `admin`. **There is no branch on `channel` anywhere in the
bidding module.** A Telegram bid and a web bid have the same fee, the same
status, the same standing and the same limit, and Phase 6's algorithm must
reach the same answer whatever it says.

## The Phase 5 / Phase 6 boundary

Phase 5 ends at **accepted valid bids, or a rejected request**.

Not implemented here, and asserted absent by the tests and the smoke script:

- auction result calculation, and LUB_V1
- unique-amount counting or winner determination
- any write to `auction_results`
- winner orders, `NO_UNIQUE_BID` refunds, `NO_BIDS` handling

An auction may perfectly well be `live` with zero bids. The close worker may
move it to `closing`; nothing in Phase 5 determines a winner.

## Verification

| What                                | Where                                             |
| ----------------------------------- | ------------------------------------------------- |
| amount rules, without a database    | `apps/api/src/modules/bidding/validation.test.ts` |
| the engine against real PostgreSQL  | `tests/db/bidding.test.ts`                        |
| the seven concurrency races         | `tests/db/bidding-concurrency.test.ts`            |
| both channels against the built app | `npm run verify:bidding`                          |

The smoke script is the one that matters for wiring: it drives the real HTTP
endpoint and the real Telegram webhook, then asserts that a bid placed from
Telegram appears in the website's own bid list for the same account — one
engine, one limit. Module tests passing while a route was broken is a mistake
this project has made twice, and both of this phase's channel defects were
found by running the surfaces rather than reading them.
