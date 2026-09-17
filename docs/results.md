# Results — LUB_V1

HOWLOW is a **lowest-unique-bid** auction. The rule is one sentence, and every
misunderstanding of this platform starts with getting it wrong:

> The winner is the **lowest bid amount that exactly one valid bid was placed
> at.**

Not the lowest bid. The lowest bid usually loses, because low amounts are the
obvious guesses and obvious guesses collide. An amount five people chose is
worth nothing to any of them; an amount one person chose beats every higher
lonely amount and every crowded lower one.

If every amount was chosen by two or more bidders, **there is no winner**. Not
a fallback to the lowest bid, not the second-lowest unique amount, not a
tie-break on who bid first. Nobody won, and the participation fees go back.

## Worked example

Six amounts, and how many bidders chose each:

| Amount | Bidders |                  |
| -----: | ------: | ---------------- |
|      1 |       4 | crowded          |
|      2 |       7 | crowded          |
|      3 |       5 | crowded          |
|      4 |       2 | crowded          |
|  **5** |   **1** | **← the winner** |
|      6 |       3 | crowded          |

The winning amount is **5**. It is neither the lowest amount bid (1) nor the
highest lonely one; it is the lowest amount that stood alone.

## One implementation, and only one

`apps/api/src/modules/results/lubCalculator.ts` holds the only implementation
of this rule in the codebase. Nothing else computes a winner:

- no channel — the website and the bot **display** the result, never derive one
- no client — the browser has no code that counts amounts
- no admin tool, no Telegram handler, no worker

The worker decides _when_ to ask. The results module decides _what the answer
is_. A second implementation would eventually disagree with the first, and what
the two would disagree about is who won an auction people paid to enter.

`resultsRepository` is not exported from the module, and the ESLint boundary
rule refuses the import from anywhere else.

## The query

```sql
WITH lowest_unique AS MATERIALIZED (
  SELECT amount_minor
    FROM bids
   WHERE auction_id = $1
     AND status = 'valid'
   GROUP BY amount_minor
  HAVING count(*) = 1
   ORDER BY amount_minor ASC
   LIMIT 1
)
SELECT b.id, b.user_id, b.amount_minor
  FROM bids b
  JOIN lowest_unique u ON u.amount_minor = b.amount_minor
 WHERE b.auction_id = $1
   AND b.status = 'valid'
```

PostgreSQL answers this from `bids_auction_amount_idx`, a partial index on
`(auction_id, amount_minor) WHERE status = 'valid'`, so the plan is an
index-only scan and one grouping. **The bid set is never loaded into Node to
count it** — that would make the answer depend on the worker's heap rather than
on the bids.

### `AS MATERIALIZED` is load-bearing

Without it the query is **quadratic in the number of bids**, and this was found
by running the scale measurement rather than by reading the SQL.

PostgreSQL inlines a singly-referenced CTE by default. Inlined here, the
planner may put the join's _outer_ side on `bids` and the grouping aggregate on
the _inner_ side — re-running an aggregate over every bid of the auction, once
per bid of the auction. At a hundred thousand bids that is ten billion row
operations: the query does not slow down, it stops finishing.

Measured against a freshly bulk-loaded, unanalysed `bids`:

|                   | 100,000 bids                                        |
| ----------------- | --------------------------------------------------- |
| plain CTE         | **> 30,000 ms**, cancelled by the statement timeout |
| `AS MATERIALIZED` | **38 ms**                                           |

The trigger is the planner believing `bids` is small (`reltuples = 0`, the
state of any table not analysed since it was loaded). With accurate statistics
it picks the good plan on its own and both forms run in about 8 ms — which is
exactly what made this dangerous: it works in development and on a warm
database, and it hangs on the first auction after a restore or a fresh
deployment. A closing job is not a place to depend on autovacuum having caught
up.

The 100,000-bid scale test deliberately does **not** analyse the table after
seeding, so it keeps exercising the bad-estimate case and would fail again if
that word were removed.

### `count(*) = 1`, not `count(DISTINCT user_id) = 1`

These are the same number. `bids_valid_amount_unique_key` makes it impossible
for one user to hold two valid bids at one amount in one auction, so bids at an
amount and bidders at an amount are always equal. `count(*)` is written because
the rule is about bids and because it is cheaper — and if that index were ever
dropped this would become the stricter reading, which is the safer way to be
wrong.

## What takes part

Only `status = 'valid'` bids.

A **voided** bid never participated: its fee was returned, and counting it
would let a refunded bid keep denying an amount to somebody else. This can
change the winner, and a test asserts exactly that: an amount bid by two people
is not unique until one of those bids is voided, at which point it stands alone
and wins.

`channel` appears in **no clause** of the algorithm. A Telegram bid and a web
bid are the same row, and neither is favoured — which is the whole point of one
backend behind two channels.

## The four outcomes

| Outcome         | When                    | Order                      | Inventory | Fees             |
| --------------- | ----------------------- | -------------------------- | --------- | ---------------- |
| `winner`        | one amount stood alone  | **one**, `pending_payment` | **kept**  | kept             |
| `no_unique_bid` | bids exist, none unique | none                       | released  | **all returned** |
| `no_bids`       | no valid bids at all    | none                       | released  | none to return   |
| `cancelled`     | the auction was pulled  | none                       | released  | **all returned** |

`no_unique_bid` and `no_bids` are kept apart because their consequences differ
— one has fees to return and the other has none — and inferring which from
`total_valid_bids = 0` at read time would be reading a fact back out of a
statistic. The outcome is a stored column, not a derivation.

## The stored result

One immutable row per auction, in `auction_results`:

| Column                                                                       |                                                |
| ---------------------------------------------------------------------------- | ---------------------------------------------- |
| `outcome`                                                                    | which of the four                              |
| `algorithm_version`                                                          | always `LUB_V1`; a CHECK refuses anything else |
| `winning_bid_id`, `winner_user_id`, `winning_amount_minor`                   | all three together, or none                    |
| `total_bids`, `total_valid_bids`, `participant_count`, `unique_amount_count` | the frozen statistics                          |
| `frozen_bid_checksum`                                                        | the digest below                               |
| `computed_at`                                                                |                                                |

Two names differ from the system-design prose, and deliberately:
`frozen_bid_checksum` is the specification's `input_checksum`, and
`participant_count` is its `total_participants`. Both were fixed by Phase 1's
migration; renaming a column of an append-only table to match a document would
rewrite history for a synonym. The wire contract uses `checksum` and
`participantCount`.

### The statistics are counted, not quoted

`auctions.total_bids` and `auctions.total_participants` are display caches
maintained by the bidding engine — corrected by `recountAuction` when they
drift. A result that quoted them would be quoting a cache. The figures stored
with a result are counted from the bids themselves, in the same transaction, in
one round trip. A test corrupts the cache before closing and requires the
result to be right anyway.

## The checksum

A result says "the winning amount was 47". The checksum says "and here is the
fingerprint of the exact set of bids that produced it". Together they make a
result _checkable_ without anybody's bids being published.

The canonical representation is a **published contract**, because an
independent verifier has to be able to reproduce it:

- one line per **valid** bid in the auction
- each line is `<bid id>:<user id>:<amount in minor units>`
- ids are lowercase canonical UUID text; the amount is the integer, no
  separators, no sign, no decimal point
- lines ordered by **bid id ascending**
- joined by a single `\n`, with no trailing newline
- SHA-256 of the UTF-8 bytes, lowercase hex

An auction with no valid bids hashes the empty string, giving the well-known
`e3b0c442…b855`. `frozen_bid_checksum` is NOT NULL, and "no bids" is a fact
worth fingerprinting like any other.

**Why order by bid id.** The ordering must be total, stable, and independent of
anything the result depends on. `amount_minor` is not unique. `created_at` is a
`timestamptz` and two bids inserted by one statement can share it to the
microsecond. `id` is a primary key: unique by definition, fixed at insert, and
untouchable afterwards — `enforce_bid_immutability` refuses to let a bid's
identity, owner, amount or creation time change at all.

**Why those three fields.** They are the bid as evidence: which bid, whose it
was, what it was for. `status` is absent because only valid bids are in the set
at all — voiding a bid changes the set and so changes the digest, which is the
wanted behaviour. `fee_minor` and `channel` are absent because they have no
bearing on who won: a result must not appear to change because a fee schedule
was re-read or a bidder switched from the bot to the website.

**Where it is computed.** In PostgreSQL. The digest has to cover every bid, so
unlike the uniqueness question it cannot avoid touching the whole set — the
choice is _where the set is assembled_, and assembling it next to the rows
keeps it out of the Node heap. The cost, stated plainly: the aggregated text is
roughly 80 bytes per valid bid, so a 100,000-bid auction assembles about 8 MB
inside the database for the length of one query. That is the largest single
allocation in the closing path and the first thing to revisit if auctions get
an order of magnitude bigger.

## Verifying a published result

`verifyResult(auctionId)` recomputes the digest, the statistics and the winner
and reports every disagreement.

It **never writes**. A failed verification is a finding to investigate, not a
result to correct — correcting it would mean changing who won an auction after
the fact, which is the one thing this whole phase exists to make impossible.
`auction_results` is append-only in the database as well, so there is nothing
in the module that could try.

Same bids → same checksum → same winner. A bid voided, inserted or altered
after the close changes the digest, and the report says so rather than quietly
producing a different answer. A test does exactly that and requires the stored
result to be untouched afterwards.

## Performance

Measured on the development machine, worst case — every amount bid by every
bidder, so nothing is unique and the query must count every group before it can
answer — with `bids` freshly bulk-loaded and **not** analysed:

|    Bids | LUB_V1 | statistics | checksum | whole close |
| ------: | -----: | ---------: | -------: | ----------: |
|   1,000 | 1.5 ms |     1.0 ms |   1.3 ms |       17 ms |
|  10,000 | 6.6 ms |     3.6 ms |   8.7 ms |       34 ms |
| 100,000 |  76 ms |      29 ms |   102 ms |      219 ms |

No caching layer. Redis is not involved in deciding an auction and must not
become involved: the answer comes from PostgreSQL, which is the only thing
allowed to be authoritative about it. The thresholds the scale test asserts are
generous on purpose — they are a guard against an accidental sequential scan or
an N+1 creeping in, not a performance target.

## What a result may reveal

Before the close: **nothing**. There is no result row, so there is nothing to
leak — the uniqueness signal the bidding engine withholds during an auction
stays withheld right up to the moment the outcome is final. Both result
endpoints answer `404` while an auction is running.

After the close:

|                           |                                                                 |
| ------------------------- | --------------------------------------------------------------- |
| the winning amount        | **public** — the answer the auction was asking                  |
| the statistics            | **public** — they describe the crowd, not a person              |
| the checksum              | **public on purpose** — it is what lets a result be re-verified |
| who won                   | told to the winner, on their own authenticated view             |
| anyone else's amounts     | **never**, to anybody                                           |
| a participant list        | **never**                                                       |
| a per-amount distribution | **never**                                                       |

A losing bidder learns that they lost and what the winning amount was. Not who
beat them, not by how much, not what anybody else tried. This is not
politeness: a frequency table of amounts, published after the close, is still
advice about what to avoid in the next auction, and the format only works while
nobody has it.

`unique_amount_count` is the one statistic that looks like it might leak. It
says how many amounts exactly one bidder chose, across the whole auction, after
the auction is over. It names no amount and no bidder, and the auction it
describes can no longer be bid on.

`amountDistribution()` exists in the module for verification and operational
inspection — a dispute needs someone able to see the shape of an auction — and
is exposed on no surface, to anyone, ever.

## The API

```
GET /api/v1/auctions/:publicId/result
```

Public. `404` until the auction is decided.

```json
{
  "auctionId": "…",
  "outcome": "winner",
  "algorithmVersion": "LUB_V1",
  "winningAmountMinor": "4700",
  "currency": "ETB",
  "statistics": {
    "totalBids": 221,
    "totalValidBids": 218,
    "participantCount": 37,
    "uniqueAmountCount": 9
  },
  "checksum": "a1b2…",
  "computedAt": "…"
}
```

```
GET /api/v1/auctions/:publicId/result/me
Authorization: Bearer <access token>
```

Everything in it is either public or the caller's own — `won`, their bid count,
their fees, what came back, and for the winner the order awaiting payment.
There is no parameter that could make it return somebody else's.

## Events

Published after the result is committed and durable, on `howlow:auction-results`:

| Event                   | Scope                                                    |
| ----------------------- | -------------------------------------------------------- |
| `AUCTION_RESULT_READY`  | auction-wide, no user                                    |
| `AUCTION_WON`           | addressed to the winner                                  |
| `AUCTION_NOT_WON`       | addressed to each other participant of a winning auction |
| `AUCTION_NO_UNIQUE_BID` | auction-wide                                             |
| `AUCTION_NO_BIDS`       | auction-wide                                             |

Never from inside the closing transaction: a retried transaction would announce
a result twice, and a rolled-back one would announce a result that does not
exist. The durable record is the immutable row; this is fan-out, at most once,
and a publish never throws.

The `AUCTION_NOT_WON` fan-out is bounded at 1,000 participants. Above that the
addressed events are skipped and logged — a per-user publish loop is the wrong
shape at that size, the auction-wide event is enough for a client to ask for
its own outcome, and a proper outbox belongs to the notification phase.

## Not implemented here

- collecting the winner's payment, and any payment provider
- what happens when a winner does not pay
- shipping, delivery, seller payouts
- notification fan-out beyond publishing the events above
- multi-unit auctions
- **LUB_V2.** There is one algorithm. A future change of rules would be a new
  version alongside this one, never a redefinition of it, because results
  already published were computed under these.
