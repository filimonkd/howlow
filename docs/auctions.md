# HOWLOW auctions

The auction lifecycle, how it is scheduled, and the locking that keeps it
correct under concurrency.

Phase 4 owns everything up to the moment bidding stops. Bid submission is
Phase 5; result calculation is Phase 6. The [boundary](#the-phase-4--phase-5--6-boundary)
is stated explicitly at the end.

## The lifecycle

```
  draft ──submit──▶ pending_approval ──approve──▶ scheduled ──open──▶ live
    ▲                     │                                            │
    └──────reject─────────┘                                         close
                                                                       │
                                                                       ▼
                                 completed ◀──complete── calculating ◀─ closing
```

`suspended` is reachable from `pending_approval`, `scheduled` and `live`, and
resume restores whichever of those it interrupted. `cancelled` is reachable from
everything unfinished. `completed` and `cancelled` are terminal, enforced by the
transition table _and_ by a database trigger.

### The transition table

`apps/api/src/modules/auctions/transitions.ts` is the single declaration of
what an auction may do next.

| Action             | From                                                                     | To                 |
| ------------------ | ------------------------------------------------------------------------ | ------------------ |
| `submit`           | `draft`                                                                  | `pending_approval` |
| `approve`          | `pending_approval`                                                       | `scheduled`        |
| `reject`           | `pending_approval`                                                       | `draft`            |
| `open`             | `scheduled`                                                              | `live`             |
| `close`            | `live`                                                                   | `closing`          |
| `beginCalculating` | `closing`                                                                | `calculating`      |
| `complete`         | `calculating`                                                            | `completed`        |
| `suspend`          | `pending_approval`, `scheduled`, `live`                                  | `suspended`        |
| `cancel`           | `draft`, `pending_approval`, `scheduled`, `live`, `closing`, `suspended` | `cancelled`        |

Every status change goes through a lifecycle function that consults this table,
so "DRAFT → LIVE must be rejected" is a property of one table rather than a
check each caller has to remember. **No controller, Telegram handler or worker
sets a status directly** — a lint rule stops them importing the repository that
could.

Two table properties are asserted by tests because the service depends on them:
nothing moves out of a terminal state, and no action starts from the state it
targets (which is what keeps "already done" distinguishable from "legal move").

### Idempotency

A transition whose target state is already set returns `changed: false` instead
of throwing. That is what makes the whole lifecycle replay-safe: a retried job,
or the sweeper racing a scheduled job, is a no-op rather than a second effect.

`applyTransition` also carries `WHERE status = <expected>` as a final guard, so
even two transactions that both believed they should act produce one update.
The caller reads "no row" as "someone else already did it".

## Approval

A seller submits; staff decide.

- `submit` clears any previous rejection, so resubmitting after a fix is clean.
- `approve` records `approved_by` and `approved_at` and schedules the auction.
- `reject` returns the auction to `draft` with a mandatory reason the seller
  reads, and clears `submitted_at`.

A seller **cannot approve their own auction**, even holding `auction_manager`:
the service refuses when the approver created it. Otherwise the review step
would be decorative. Every decision is audited.

## Configuration and validation

Required to create an auction: product, title, description, start and end
times, minimum and maximum bid, increment, bids per user, participation fee,
winner payment window. `quantity` is always 1.

| Rule                                         | Enforced by                                |
| -------------------------------------------- | ------------------------------------------ |
| `ends_at > starts_at`                        | schema, service, CHECK                     |
| `max_bid >= min_bid`                         | schema, service, CHECK                     |
| `increment > 0`, `min_bid > 0`               | schema, service, CHECK                     |
| `(max_bid − min_bid) % increment == 0`       | schema, service, CHECK                     |
| `participation_fee >= 0`                     | schema, service, CHECK                     |
| `winner_payment_hours > 0`                   | schema, service, CHECK                     |
| `1 <= max_bids_per_user <= 1000`             | schema, service, CHECK (positive)          |
| `quantity == 1`                              | CHECK                                      |
| product exists, is active, has stock         | service                                    |
| product belongs to the seller                | service                                    |
| product not over-committed to other auctions | service, and again under lock when opening |

The divisibility rule is the subtle one. A range of 100–5050 in steps of 100
stops at 5000, so the published maximum is an amount **no bidder could ever
place**. It is refused at the request boundary for a friendly message, in the
service so every caller gets it, and by a CHECK so no code path can evade it.

A partial edit is validated against the stored values it does not change:
changing only `maxBidMinor` is still checked against the increment already
stored.

### Column naming

The specification names `participation_fee_minor` and `increment_minor`. The
schema calls them `bid_fee_minor` and `bid_increment_minor`, which is what
Phase 1 created and what the wallet ledger already books as `bid_fee`. The
existing names were kept so the ledger and the auction agree; the API exposes
`bidFeeMinor` and `bidIncrementMinor` to match.

## Term immutability

Once an auction is `live`, these are fixed: product, currency, participation
fee, minimum bid, maximum bid, increment, bids per user, start, end and
quantity.

They are what a live auction's bidders committed against, so they become
historical fact the moment bidding _can_ begin — not merely once the auction
finishes. The service refuses the edit with `AUCTION_IMMUTABLE`, and the
`auctions_enforce_immutability` trigger refuses the write independently, so a
future code path that forgets the check still cannot rewrite live terms. Both
refusals are tested.

Before `live`, the owning seller may edit according to the validation rules
above.

## Locking

**The platform's lock order is `auction → product → wallet`.**

| Operation       | Locks                                   |
| --------------- | --------------------------------------- |
| Any transition  | the auction row (`FOR UPDATE`)          |
| `open`          | then the product row, to reserve a unit |
| `cancel`        | then the product row, to release it     |
| Phase 5 bidding | the auction row, then the wallet row    |

Every transition takes the auction row lock first. Two workers that both try to
open the same auction queue there, and the second reads the status the first
committed — so "opened twice" is impossible rather than unlikely.

Phase 4 never takes a wallet lock. Phase 3 established that the wallet lock is
always **last** and that no wallet operation takes any further lock while
holding it; Phase 4 takes the auction lock first and the product lock second.
Phase 5's bidding transaction — auction, then wallet — sits inside the same
order, so the two cannot deadlock against each other.

### The rule Phase 5 must honour

> Lock the **auction** before the **wallet**. Never take an auction or product
> lock while already holding a wallet lock.

A transaction that must move two wallets locks them in ascending wallet-id
order (Phase 3's rule). A transaction that must touch two products does the
same with product ids.

## Opening

When `auction.open` runs:

1. Lock the auction row.
2. Verify the status is `scheduled`.
3. Verify the **database** clock has reached `starts_at`.
4. Reserve exactly one product unit (locking the product row).
5. Transition to `live` and record `opened_at`.
6. Audit inside the transaction; publish the lifecycle event after it commits.

**If no unit can be reserved the auction does not go live.** It is cancelled
with an auditable reason instead, because a live auction collecting
participation fees for an item nobody can be sent is the worse outcome. The
`open` result reports `cancelledForInventory` so the caller can say so.

## Closing

`auction.close` verifies the auction is `live` and that the database clock has
passed `ends_at`, then moves it to `closing` and records `closing_at`.

`closing` is the state in which bid submission is refused **by status**. That is
all Phase 4 does: no winner, no order, no fee refund, and no move to
`calculating`.

## PostgreSQL is the clock of record

`open` and `close` read `now()` from the database and refuse to act early
(`AUCTION_NOT_DUE`). A worker whose own clock runs fast cannot open an auction
before its published start time, and a browser's or Telegram client's clock is
never consulted for anything that matters.

The countdown a page or a chat message shows comes from `secondsRemaining`,
computed server-side against the same clock. The browser decrements it so the
display ticks; the anchor is never local.

## Scheduling

Three pieces in the worker, none of which holds lifecycle logic of its own —
all three call the same `open`/`close` services.

### Precise jobs

When an auction becomes `scheduled` the API publishes a channel-neutral
`AUCTION_SCHEDULED` event. The worker subscribes and enqueues two BullMQ jobs
with delays: one to open at `starts_at`, one to close at `ends_at`.

Job ids are fixed per auction (`auction-open-<id>`, `auction-close-<id>`), so
BullMQ refuses a duplicate enqueue and re-approving cannot stack a second
opening. The separator is a hyphen rather than the `auction.open:<id>` the
specification names, because BullMQ reserves the colon for its own key
namespacing and rejects a custom id containing one.

The API cannot enqueue directly: the worker depends on the API, not the other
way round.

### The safety sweeper

Every 30 seconds, the sweeper asks PostgreSQL which auctions are due to open or
close and calls the same services.

**This is what correctness rests on**, not the scheduled jobs. Redis is
explicitly not the source of truth, so a flushed queue, a worker that was down
at the wrong moment, or a delay that never fired would otherwise leave an
auction stuck. The scheduled job is a _latency_ optimisation over the sweeper —
which is why a missed `AUCTION_SCHEDULED` event is not a correctness problem.

Because the sweeper holds no lifecycle logic, it is safe for it to race a
scheduled job: whichever arrives second finds the work done.

### Boot catch-up

On boot the worker re-enqueues precise jobs for every auction already
`scheduled` or `live`, so a worker that was down while approvals happened does
not leave those auctions to the sweeper's coarser timing. The fixed job ids make
that safe to repeat.

## Lifecycle events

Published after the transaction commits, never inside it: `withTransaction` may
retry its callback, and a retried publish would announce a transition twice.

```
AUCTION_SCHEDULED  AUCTION_STARTED  AUCTION_CLOSING
AUCTION_SUSPENDED  AUCTION_RESUMED  AUCTION_CANCELLED
```

They are channel-neutral — no chat ids, no socket details, no rendering. The
website's socket layer and the Telegram notifier each subscribe and decide what
to do. Delivery is at-most-once over Redis pub/sub; the durable record of every
transition is the `audit_logs` row written inside the transaction. Phase 11 owns
guaranteed notification delivery and can add an outbox when it needs one.

## Discovery

Publicly visible statuses are `scheduled`, `live`, `closing`, `calculating` and
`completed`. A draft, a pending submission and a suspended auction are never
listed, and **never readable by id or slug** either: the public read refuses
anything outside that set with `NOT_FOUND` rather than `FORBIDDEN`, so the
answer does not confirm an unpublished auction exists at that address.

A `status` filter narrows _within_ the visible set rather than widening past it,
so a crafted query cannot surface a draft.

### What a public payload never contains

No bid count, no bidder identity, no participant count, no uniqueness signal,
no current leader, and not even the seller's id. Any of those would let a
bidder reverse-engineer the lowest unique bid, which is the one thing the format
depends on keeping private. The DTO simply has no such fields, and tests assert
their absence in the API payload and in the Telegram message.

### Pagination

Keyset, consistent with the rest of the platform. An auction listing changes
under a reader as auctions open and close, so an offset would show one auction
twice or skip another. The cursor is an opaque `<sort value>|<id>` pair matching
the ORDER BY of the sort it was issued for — a cursor is only valid for the sort
that produced it.

Sorts: `ending_soon` (default), `starting_soon`, `newest`.

**The cursor timestamp is carried as text at full microsecond precision, and is
never parsed into a `Date`.** `timestamptz` stores microseconds; a JavaScript
`Date` stores milliseconds. A cursor that passes through a `Date` therefore
names a coarser instant than the row it was taken from, and the keyset
comparison then misbehaves in whichever direction the sort runs:

| Sort direction                       | Effect of a millisecond-truncated cursor                                                                                               |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| DESC (`newest`)                      | the cursor sorts _after_ same-millisecond rows with smaller microseconds — they are skipped                                            |
| ASC (`ending_soon`, `starting_soon`) | the cursor still precedes them, including the row it came from — they repeat, and a page filled by a single millisecond never advances |

So the repositories render the value with
`to_char(<column> AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` and
compare it back as `$n::timestamptz`. `to_char` rather than `::text` because
the cast's output follows the session's `DateStyle`, and a cursor handed to a
client outlives the session that produced it. The comparison stays a plain
`(column, id) < ($n::timestamptz, $m::uuid)`, so the index is still used.

The cursor is client-supplied, so its timestamp is validated against a strict
pattern before it reaches the query: an unparseable value would otherwise
surface as a 500 rather than a 400.

Both failure modes are pinned by tests — `tests/db/catalog.test.ts` for the
descending skip, `tests/db/auction-lifecycle.test.ts` for the ascending
non-termination — and `scripts/smoke-catalog.mjs` walks every sort to the end
over HTTP with `limit=1`, which is the only place a cursor that loses precision
between the repository and the wire would show.

## Error codes

| Code                             | HTTP | Meaning                                     |
| -------------------------------- | ---- | ------------------------------------------- |
| `AUCTION_NOT_FOUND`              | 404  | unknown, or not publicly visible            |
| `AUCTION_NOT_OWNED`              | 403  | belongs to another seller                   |
| `AUCTION_SLUG_TAKEN`             | 409  | address in use                              |
| `INVALID_TRANSITION`             | 409  | not reachable from the current state        |
| `INVALID_AUCTION_CONFIG`         | 422  | a term rule was broken                      |
| `AUCTION_IMMUTABLE`              | 409  | bidding has begun; terms are fixed          |
| `PRODUCT_NOT_ELIGIBLE`           | 422  | not active, or has no stock                 |
| `PRODUCT_ALREADY_COMMITTED`      | 409  | stock already promised to other auctions    |
| `UNAUTHORIZED_AUCTION_OPERATION` | 403  | the actor may not do that                   |
| `AUCTION_NOT_DUE`                | 409  | the database clock has not reached the time |

## API

### Public

```
GET /api/v1/auctions?status&categorySlug&sellerId&sort&limit&cursor
GET /api/v1/auctions/:publicId        # uuid or slug
```

### Seller

```
GET   /api/v1/seller/auctions
POST  /api/v1/seller/auctions
GET   /api/v1/seller/auctions/:publicId
PATCH /api/v1/seller/auctions/:publicId
POST  /api/v1/seller/auctions/:publicId/submit
POST  /api/v1/seller/auctions/:publicId/cancel
```

### Staff

```
GET  /api/v1/admin/auctions/pending
GET  /api/v1/admin/auctions/:publicId
POST /api/v1/admin/auctions/:publicId/approve
POST /api/v1/admin/auctions/:publicId/reject     { reason }
POST /api/v1/admin/auctions/:publicId/suspend    { reason }
POST /api/v1/admin/auctions/:publicId/resume
POST /api/v1/admin/auctions/:publicId/cancel     { reason }
```

Every staff operation is a **named transition**. There is no endpoint that
accepts a status, so no request shape can move an auction to an arbitrary
state. Reject, suspend and cancel each require a reason of at least eight
characters — an unexplained decision against a seller's listing is not
something to leave behind.

Identifiers on the wire are uuids and slugs. There is no sequential internal id
to leak; `audit_logs.id` is the only bigint key in the schema and it is never
exposed.

## Channels

The website and the Telegram bot call the same module functions and hold no
auction logic. `/auctions` in a chat and `/api/v1/auctions` in a browser return
the same auctions with the same terms, because there is one implementation
behind both.

Telegram callback payloads carry a compact identifier and nothing else — no
status, no price, no permission, no user id. Telegram delivers whatever the
client sends, so a payload is a request rather than a fact, and every handler
re-resolves the auction and re-applies the public visibility rule server-side.
Payloads stay inside Telegram's 64-byte limit; an oversized cursor is dropped
rather than truncated, which would send the reader to the wrong page.

## Observability

Structured logs and audit rows for:

```
auction.created    auction.submitted  auction.approved   auction.rejected
auction.scheduled  auction.opened     auction.closing    auction.suspended
auction.resumed    auction.cancelled  auction.swept
inventory.reserved inventory.released inventory.reconciliation_failed
```

Audit details are assembled by the module from domain facts and never forwarded
from a request body, so no secret can reach an audit row under an unexpected
key. Rows are written **inside** the transaction that made the change: a record
of something that rolled back would be a record of something that never
happened. The request id is carried through where a channel supplies one.

## Testing

```bash
npm test                 # transition table, config rules, rendering, routing
npm run test:db          # the lifecycle and concurrency suites
npm run verify:catalog   # both channel surfaces end to end
```

The six mandatory concurrency scenarios are in
`tests/db/auction-concurrency.test.ts`:

1. two auctions cannot reserve the final unit;
2. an auction opens exactly once under ten concurrent attempts;
3. it closes exactly once under ten;
4. the sweeper and the scheduled job may race without duplicating effects;
5. a cancel and an open cannot both claim the same unit;
6. repeating any operation produces one effect.

Two of them hold a transaction open so the dangerous overlap happens on **every
run** rather than occasionally, and both were checked against deliberately
broken builds: with the auction row lock removed, three tests fail on every one
of three runs; with the product lock removed, two do. The first version of the
inventory test passed two runs out of three without the product lock, which is
why the deterministic version replaced it. A test that passes either way proves
nothing.

## The Phase 4 → Phase 5 / 6 boundary

**Phase 4 contains no bidding logic of any kind.** There is nothing that creates
a bid, counts bids, determines uniqueness, calculates a winner, debits a
participation fee or refunds one. An auction can go live with zero bids and
reach `closing` without anything being decided — tests assert that `closing`
leaves `auction_results` and `bids` empty.

What is already prepared for the next phases:

| Phase | Owns                                                   | Prepared here                                                         |
| ----- | ------------------------------------------------------ | --------------------------------------------------------------------- |
| 5     | bid submission, fee debit, per-user limits             | `live` accepts bids by status; the lock order; `acceptsBids()`        |
| 6     | `closing → calculating → completed`, `LUB_V1`, winners | both transitions declared in the table; `closing` reached and audited |
| 10    | order fulfilment                                       | the `consumed` reservation state                                      |
| 11    | guaranteed notification delivery                       | channel-neutral lifecycle events                                      |

The transitions Phase 6 needs are already in the table, so the service it adds
enforces the same previous-state rules these do — but nothing in Phase 4
performs them.
