# Auction closing

Closing is where an auction stops being a game and becomes a set of
obligations: somebody owes money for an item, or everybody gets their fees
back. It is the most consequential transaction in HOWLOW after a bid, and the
one people will dispute.

**The worker owns closing.** No request closes an auction. No channel closes an
auction. There is no API that could. The worker decides _when_ to ask; the
results module decides _what the answer is_; PostgreSQL decides whether the
answer may be written twice.

For the rule itself — what makes a bid win — see [results.md](results.md). This
document is about the machinery around it.

## The states

```
live ──close──▶ closing ──beginCalculating──▶ calculating ──complete──▶ completed
```

| State         | Meaning                                       |
| ------------- | --------------------------------------------- |
| `live`        | accepting bids                                |
| `closing`     | bidding has stopped; nothing has been decided |
| `calculating` | the frozen set is being counted               |
| `completed`   | the result is published and final             |

`completed` is terminal in the transition table **and** in a database trigger.
Once it commits, no code path — including the lifecycle service itself — can
move the auction again.

All four transitions live in `apps/api/src/modules/auctions/lifecycle.ts` and
consult the one transition table. The results module says _when_, never _how_.

## The freeze

**There is no freeze flag, and there must never be one.**

Bid submission requires `status = 'live'`. So bids stop the instant `close()`
commits `closing` — before anything begins counting — and the auction's status
is the single authority on whether a bid is accepted. A second flag would be a
second answer to the same question, and the two would eventually disagree about
whether a particular bid counted.

`beginCalculating` therefore freezes nothing. It records that the frozen set is
now being counted.

## The sequence

`closeAuction()` runs two transactions and then a refund pass:

```
T1   lock the auction · closing → calculating · commit
T2   lock the auction
     · count the frozen set
     · checksum it
     · run LUB_V1
     · insert auction_results
     · create the winner's order  OR  release the unit
     · audit
     · calculating → completed
     · commit
T3+  refund participation fees, one wallet per transaction
     then publish the result events
```

### Why T2 is one transaction

The result row, the winner's order or the released unit, and the auction
reaching `completed` all commit together or none of them do. Splitting any of
it would allow an auction with a winner and no order — a promise nobody is
holding.

### Why T1 is separate

So that `calculating` is a state that actually **exists in the database**. An
auction sitting in `calculating` is an auction whose closing was interrupted: a
visible alarm, and one a retry resumes from. Folded into T2, `calculating`
would never be observed and an interrupted close would be indistinguishable
from one that had not started.

### Why refunds are not in T2

Each refund takes a wallet lock — that is what the wallet module does, and
correctly. Folding _N_ refunds into the closing transaction would mean holding
the auction lock across _N_ wallet locks. For a thousand-participant auction
that is a thousand locks in one transaction, a transaction long enough to
matter, and a lock graph whose worst case is a connection pool exhausted by
closing jobs waiting on each other's wallets. Phase 5 has already demonstrated
what that failure looks like in practice: not an error, a _hang_.

So refunds run afterwards, one wallet per transaction, without the auction lock
held at all. Two things make that safe rather than merely cheaper — see
[Refunds](#refunds).

## Locking

The platform's lock order is unchanged:

```
auction → product → wallet
```

- `lockForClosing` takes the auction row with `SELECT ... FOR UPDATE`. First,
  always.
- Creating the winner's order and releasing a unit take the **product** next,
  inside the auction lock.
- Refunds take **wallets**, in their own transactions, after the auction lock
  has been released.

Never `wallet → auction`. A closing transaction and a bidding transaction take
the same locks in the same order, so they cannot deadlock against each other.

## Idempotency — where it actually lives

Running a close twice must not produce two winners, two orders or two refunds.
Three mechanisms, and **none of them is in the worker or in Redis**:

| Guarantee                         | Mechanism                                                    |
| --------------------------------- | ------------------------------------------------------------ |
| two concurrent attempts serialise | the auction row lock                                         |
| one result per auction, ever      | `auction_results_auction_id_key`, a unique index             |
| one order per won auction         | `orders_auction_id_key`, a partial unique index              |
| one refund per participant        | the wallet's entry-level idempotency, on a deterministic key |

BullMQ's job uniqueness keeps duplicate work off the queue. It is a convenience.
It is not relied on for correctness, and the concurrency suite deliberately
bypasses it — every test in `tests/db/results-concurrency.test.ts` races the
services directly. If job uniqueness were load-bearing, all of them would fail.

A replay **recomputes** the winner and then discards its own answer in favour
of the stored one. That is deliberate: the recomputation costs one query and
proves nothing, while using it would be a recalculation, and the winner of a
decided auction never changes.

## The last-second race

A bid and a close can arrive together. Both take the auction row lock, so one
of them goes first — and which one is genuinely unspecified. What is specified
is the outcome either way:

- If the bid **committed before** the freeze, it is in the frozen set the result
  was computed from. A committed bid is never silently dropped.
- If the bid arrived **after** `closing` committed, it is refused with
  `AUCTION_NOT_LIVE` and it is not in the set. A bid committed after the freeze
  never counts.

There is no third possibility. "Accepted but missing from the result" and
"refused but counted anyway" are both impossible, because the same row lock
orders the two operations and the bid's acceptance test is the auction's own
status.

`tests/db/results-concurrency.test.ts` asserts exactly this, five times over,
with the racing bid placed at an amount that would win if it counted — so
whether it counted is visible in the winner itself rather than only in a count.

## The winner does not change

**This is a core trust rule.** Once a result is committed:

- nothing recalculates a decided auction
- nothing reassigns the win to the second-lowest unique bid
- nothing updates `auction_results` — there is no UPDATE statement in the
  module, and the table has an append-only trigger

A winner who fails to pay loses their **order**, not their **win**. What
happens to the item then is a later phase's decision, and it is not made by
changing history. A test drains the winner's wallet after the close, closes
again, and requires the result to be identical — including that the other lonely
amount in the same auction was not promoted.

## Refunds

A participation fee buys a place in an auction that runs.

| Outcome         | Fees                                                         |
| --------------- | ------------------------------------------------------------ |
| `winner`        | kept — the auction ran and everyone who entered got a chance |
| `no_unique_bid` | **all returned** — the auction produced no result            |
| `no_bids`       | nothing was paid                                             |
| `cancelled`     | **all returned** — HOWLOW ended it, not the bidders          |

Refunds go through `modules/wallet`'s `refund('bid_fee_refund', …)`, which books
the credit and its ledger entry in one transaction. **No statement in the
results module writes to `wallets` or `wallet_entries`.** The rule that no
balance may change without its entry is enforced by there being one place a
balance can change.

The amount is `auction_participants.total_fees_minor` — what the participant
was actually charged, accumulated bid by bid at the rate in force when each bid
was placed. It is **never** recomputed as `bid_count × bid_fee_minor`, which
would agree today and hand somebody the wrong amount the first time a fee
changed.

### Exactly once

Every refund carries the key

```
auction-refund:<auctionId>:<userId>
```

Deterministic, and derived from nothing that could vary between attempts — no
timestamp, no request id, no attempt counter. Two passes over the same auction
compute the same key for the same person, so the second replays instead of
paying twice. Running the pass ten times books one refund.

This key format must not change once auctions have been closed with it: a new
format would make every already-refunded participant look unpaid.

### Recovery

Because refunds are split out of the closing transaction, a crash can leave an
auction correctly decided with some fees returned and some not.
`findAuctionsWithUnpaidRefunds` reads the **ledger** for decided auctions whose
participants paid a fee and have no `bid_fee_refund` entry against that auction,
and the sweeper finishes them. Nothing has to remember what it was doing,
because PostgreSQL is asked what is outstanding.

## Inventory

| Outcome         | Reservation                                              |
| --------------- | -------------------------------------------------------- |
| `winner`        | **kept** — the unit is owed to the winner                |
| everything else | **released** — an item nobody won goes back on the shelf |

Releasing goes through `modules/catalog`'s `releaseUnit`, which looks for a
_held_ reservation and returns `released: false` when there is none. A replay
therefore cannot double-release, and `products.reserved_quantity` cannot go
negative. A test runs three concurrent closes and two sequential ones on the
same no-winner auction and requires exactly one released row and a cache back
at zero.

## The worker

`apps/worker/src/jobs/auction-lifecycle.ts`.

- `runClose(auctionId)` — `close()` to stop the bidding, then `runDecide`.
  A job that fires before the database agrees the deadline has passed is
  refused by `close()` and stops there; there is nothing to decide while the
  bid set can still grow.
- `runDecide(auctionId)` — `closeAuction()` alone. Separate so a close
  interrupted between its two transactions can be resumed: such an auction
  needs this half and not the first.

`close()` is idempotent in both directions. An auction already `closing` is a
no-op, and so is one that has moved _past_ closing to `calculating` or
`completed`. That second case was found by racing four worker closes against one
auction: the fourth arrived after the first had finished the whole workflow, and
an invalid-transition error there would have had the sweeper logging failures
for work that had succeeded. `cancelled` is deliberately **not** treated as
done, because a cancelled auction never closed.

### The sweeper

Every 30 seconds, four passes:

1. auctions due to open
2. auctions due to close — `close()` then the decision
3. **auctions past bidding with no result** — a close interrupted between its
   two transactions, or one whose job never ran at all. Without this pass an
   auction could sit in `calculating` indefinitely, which is the whole reason
   that state is observable.
4. **decided auctions with fees still owed** — see [Recovery](#recovery).

Passes 3 and 4 are what make the workflow's two splits safe rather than merely
convenient. The queue lives in Redis, which is explicitly not the source of
truth: a flushed Redis, a worker that was down at the wrong moment, or a delay
that never fired must not be able to leave an auction undecided or a fee
unreturned. PostgreSQL knows what is outstanding, so the sweeper asks it and
calls the same services the scheduled jobs call.

## The audit trail

Written inside the closing transaction, so it commits with the decision.

| Action                                |                                                    |
| ------------------------------------- | -------------------------------------------------- |
| `auction.closing`                     | `live → closing`                                   |
| `auction.calculating`                 | `closing → calculating`                            |
| `auction.result_calculated`           | the decision, with the checksum and the statistics |
| `auction.winner_created`              | the winner, the winning bid, the amount            |
| `auction.no_unique_bid`               | no amount stood alone                              |
| `auction.no_bids`                     | the auction attracted none                         |
| `auction.cancelled_result_recorded`   | a result row for a pulled auction                  |
| `order.created`                       | the winner's order                                 |
| `inventory.released`                  | the unit went back                                 |
| `auction.completed`                   | `calculating → completed`                          |
| `auction.participation_fees_refunded` | one row per pass that moved money                  |

The names are the repository's lowercase-dotted convention; the system-design
document writes them in capitals (`AUCTION_RESULT_CALCULATED`). Same events.

**A replay records nothing.** Two `result_calculated` rows for one auction would
read as an auction decided twice, which is precisely what a reader of an audit
log is checking for, so only the call that inserted the result writes. A test
asserts the trail is byte-identical after a second close.

The checksum and the statistics are in the row, so the audit trail alone
answers "what was this decided from" without joining to the very result a reader
may be trying to verify.

## Verification

| What                                                                | Where                                                    |
| ------------------------------------------------------------------- | -------------------------------------------------------- |
| the seven LUB fixtures, the checksum, the four outcomes, disclosure | `tests/db/results.test.ts`                               |
| concurrency A–G, and 1k / 10k / 100k                                | `tests/db/results-concurrency.test.ts`                   |
| the result messages both channels send                              | `apps/api/src/channels/telegram/render/auctions.test.ts` |
| the whole machine                                                   | `npm run verify:results`                                 |

`verify:results` is the one that matters for wiring. It boots a real API
process and a real worker process, places bids over the HTTP endpoint, lets
three deadlines pass, and waits for the **worker's own sweeper** to decide the
auctions on its own schedule — it calls neither the calculator nor the closing
service. Then it waits for a _second_ sweep and re-counts, because two results,
two orders or two refunds is the failure this phase exists to prevent.

A winner algorithm that is right while the worker never runs it is worth
nothing, and the suites that call the services cannot see that.

## Not implemented here

- collecting the winner's payment, and any payment provider
- cancelling an order whose deadline passed, and what happens to the item
- shipping, delivery, seller payouts
- notification delivery beyond publishing the result events
- multi-unit auctions, and LUB_V2
