# HOWLOW wallet and ledger

## What is true, and what is a cache

`wallet_entries` is the truth. It is an append-only ledger: each row is one
money movement, signed, with the balance it produced.

`wallets.available_minor` is a **cache** of the current balance. It exists so
that reading a balance is one indexed row rather than a sum over a table that
grows for the life of the account. It is maintained in the same transaction as
the entry that changed it — never in a separate one — so the two cannot diverge
without a bug, which is exactly what reconciliation looks for.

The integrity invariant:

```
SUM(wallet_entries.amount_minor) = wallets.available_minor
                                 + wallets.reserved_minor
```

`reserved_minor` holds money committed to an in-flight operation. Nothing
places holds until Phase 5, so through Phase 3 it stays `0` and the invariant
reduces to the sum equalling `available_minor`.

## Money

Money is an integer count of **minor units** — cents — everywhere:

| Layer      | Representation                       |
| ---------- | ------------------------------------ |
| PostgreSQL | `bigint`                             |
| TypeScript | `bigint`                             |
| JSON       | decimal **string**, e.g. `"1250000"` |

No floating-point value ever touches a monetary amount. `parseFloat` is a lint
error, and the `pg` driver's BIGINT and NUMERIC parsers are replaced so a
balance arrives as a string rather than becoming a lossy `number` on the way in.

The wire format is a string because JSON has no integer type wide enough. A
balance can exceed 2^53, and `JSON.parse` would silently round it — so the API
never emits `{"availableMinor": 125000}`. It emits `{"availableMinor":
"125000"}`, and the client decides whether to widen it to `BigInt` or only
display it. `tests/db/wallet.test.ts` asserts this with a balance of 2^53 + 1.

## One code path moves money

Every movement — a deposit, a bid fee, a refund, a finance adjustment — goes
through `applyMovement` in `apps/api/src/modules/wallet/ledger.ts`:

1. Reject a non-positive amount. The **direction comes from the entry type**,
   never from the sign of the amount, so a credit cannot be booked as a debit by
   passing a negative number.
2. Lock the wallet row.
3. Read the authoritative balance under that lock.
4. Replay an earlier result if this operation carries a key that has been used.
5. Refuse a debit against a frozen wallet.
6. Compute the new balance in `bigint` arithmetic.
7. Update the cached balance.
8. Append the ledger entry.
9. Write the audit row.

All of 7–9 are in the caller's transaction. There is no ordering in which a
crash leaves a balance without the entry that explains it.

**Nothing outside `modules/wallet` may write wallet SQL.** Not a controller, not
a Telegram handler, not payment code, not an admin tool. That is a lint rule
(`WALLET_INTERNALS_PATTERN` in `eslint.config.js`) rather than a convention, and
`tests/architecture.test.ts` proves the rule rejects a violation from each
scope. It is what makes "no balance change without its ledger entry" a property
of the system: there is exactly one place a balance can change.

## Locking

Every movement takes **exactly one lock**: `SELECT ... FOR UPDATE` on the wallet
row, by primary key, held to the end of the transaction.

That single lock is what makes the arithmetic safe. The balance read under it
already reflects every movement that committed earlier, so two concurrent debits
cannot both read the same balance, both pass their own sufficiency check, and
together overdraw the wallet. The second queues on the lock and reads what the
first left behind.

An advisory lock is deliberately **not** used. The wallet row is the subject
being serialised, so locking the row itself cannot be forgotten or misnamed, and
holding both kinds of lock for one subject would give the same wallet two lock
namespaces that no reviewer could keep straight.

### Why this cannot deadlock against later phases

No wallet operation acquires a further lock while holding a wallet row lock: the
wallet lock is always the **last** lock a transaction takes. A Phase 5 bidding
transaction that locks the auction and then the bidder's wallet therefore has a
strictly ordered pair, and no path exists that could take them the other way
round.

The one rule this module asks of its callers: **a transaction that must move two
wallets locks them in ascending wallet-id order.**

### Constraints behind the lock

The lock is the first line, not the only one. `wallets_available_non_negative`
and `wallet_entries_balance_non_negative` are the database's own last word on
overdrafts, and `wallet_entries_amount_non_zero` refuses an entry that records
nothing. If application logic ever gets it wrong, the write fails rather than
the balance going wrong.

## Ledger order

`wallet_entries.seq` is the wallet's movement number, assigned under the lock as
`wallets.version + 1`. It is the ledger's authoritative order, and it is
gap-free.

It is not `created_at`. `created_at` defaults to `now()`, which in PostgreSQL is
the **transaction start** time, so two concurrent movements can carry timestamps
in the opposite order from the order their balances were computed in. Replaying
by `created_at` therefore disagreed with the `balance_after_minor` values a
correctly serialised ledger had recorded, and reconciliation reported healthy
wallets as broken. The concurrency suite caught it; the fix was to have the
ledger record its order rather than infer it from a clock.

`seq` is also what pagination keysets on — simpler than a timestamp keyset and
strictly correct where two entries share a transaction start.

## Idempotency

A movement may carry an `idempotencyKey`. Replaying it returns the stored entry
instead of applying the operation again; a key reused for a _different_ movement
(different type, currency or amount) is refused with `IDEMPOTENCY_CONFLICT`,
because replaying the stored result would answer for the wrong request.

This is enforced by the ledger's own unique `(wallet_id, idempotency_key)`
index, not by a separate bookkeeping table: the idempotency record and the money
movement are the same row in the same transaction, so no window exists where one
is committed without the other. Under the wallet lock, a concurrent duplicate
cannot slip past the check either — it waits, then finds the committed entry.

Over HTTP, a finance adjustment picks the key up from an `Idempotency-Key`
header. Tooling that times out and retries must not double someone's balance.

## Corrections

The ledger is append-only, enforced by the `wallet_entries_append_only` trigger
against `UPDATE` and `DELETE`. Correcting a mistake means writing a
**compensating entry**, never editing history — a refund is a new credit
referencing what it refunds, and the original debit stays exactly as it was.

## Reconciliation

`reconcileWallet` proves a wallet's cached balance still equals its ledger.
**It detects; it never repairs.**

A wallet whose cache disagrees with its ledger is evidence of a bug. Silently
rewriting the balance would destroy that evidence, and could just as easily move
the wallet further from the truth — the code that produced the discrepancy is,
by definition, code we do not currently trust. Discrepancies are reported,
audited under `wallet.reconciliation_failed`, and logged; a human decides what
the correcting entry should be.

Three independent checks, because they fail in different ways:

| Check                  | Catches                                                |
| ---------------------- | ------------------------------------------------------ |
| Drift                  | a balance changed without its entry                    |
| Running-balance breaks | an entry recording a balance the replay disagrees with |
| Sequence gaps          | an entry removed along with the balance it produced    |

The first two can both come out clean if a row is deleted together with its
balance; a gap in `seq` cannot be hidden that way, which is why it is checked
separately.

Each wallet is read in a single `REPEATABLE READ` read-only snapshot. Taken
separately, the sum and the cached balance could straddle a committed movement
and report drift on a perfectly healthy wallet — and a false alarm on a live
wallet makes the whole report worthless. It is also cheaper than locking the
wallet and stalling real money movements behind an audit.

`reconcileAllWallets` sweeps every wallet in id-ordered batches, each in its own
short snapshot, and returns **only** the inconsistent ones. A report listing
every healthy wallet would bury the one that matters.

The worker runs it nightly at 03:00 UTC as `wallet.reconcile`. The scheduler is
upserted under a fixed job id, so a restart re-registers the same job rather
than stacking a second sweep on the first.

## Freezing

A freeze is a **financial control**, not an account suspension.

| Control                | Stops       | Belongs to    |
| ---------------------- | ----------- | ------------- |
| Wallet freeze          | debits only | wallet module |
| `users.status` suspend | signing in  | auth module   |

A frozen wallet still receives money, and its owner keeps sign-in and full
access to their history. Conflating the two would mean fraud review had to lock
people out of reading their own ledger. `wallets_freeze_consistent` makes the
reason mandatory: an unexplained freeze on someone's money is not something
anyone should be able to leave behind.

## Error codes

Every wallet failure carries a stable code in `details.walletError`. Callers and
channels branch on that, never on a message, and a raw PostgreSQL exception
never reaches a client.

| Code                            | HTTP | Meaning                                       |
| ------------------------------- | ---- | --------------------------------------------- |
| `WALLET_NOT_FOUND`              | 404  | no wallet for that id or user                 |
| `WALLET_FROZEN`                 | 403  | debits are blocked                            |
| `INVALID_AMOUNT`                | 422  | zero, negative, or a type not yet implemented |
| `INSUFFICIENT_FUNDS`            | 402  | the debit exceeds the balance                 |
| `DUPLICATE_OPERATION`           | 409  | the operation has already been applied        |
| `IDEMPOTENCY_CONFLICT`          | 409  | the key was reused with different details     |
| `LEDGER_INTEGRITY_ERROR`        | 500  | an integrity check failed                     |
| `UNAUTHORIZED_WALLET_OPERATION` | 403  | the actor may not perform that operation      |
| `CURRENCY_MISMATCH`             | 422  | the operation's currency is not the wallet's  |

`INSUFFICIENT_FUNDS` deliberately omits the balance from its public message. A
caller who can attempt a debit can already read the wallet, but an error string
is the wrong place to disclose it.

## Authorization

Finance operations assert the actor's role **inside the module**, not only in
the HTTP middleware in front of them. The middleware protects one route; the
module protects the operation, whichever channel or worker reaches it — so a
route added in a later phase without a role gate still cannot move someone's
money.

| Operation             | Roles                                 |
| --------------------- | ------------------------------------- |
| Read own wallet       | the owner                             |
| `adminCredit`/`Debit` | `finance`, `admin` (or `super_admin`) |
| Freeze / unfreeze     | `finance`, `admin` (or `super_admin`) |
| Reconciliation report | `finance`, `support_agent`, `admin`   |

Reading a report changes nothing, so a support agent may see one while
investigating; only finance may act on it.

## API

All amounts are decimal strings of minor units.

### `GET /api/v1/me/wallet`

```json
{
  "id": "…",
  "currency": "ETB",
  "availableMinor": "125000",
  "reservedMinor": "0",
  "totalMinor": "125000",
  "frozen": false,
  "frozenReason": null,
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

### `GET /api/v1/me/wallet/transactions?limit=20&cursor=…`

```json
{
  "entries": [
    {
      "id": "…",
      "seq": "3",
      "type": "bid_fee",
      "currency": "ETB",
      "amountMinor": "-500",
      "balanceAfterMinor": "124500",
      "referenceType": "bid",
      "referenceId": "…",
      "memo": null,
      "createdAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "nextCursor": "c2VxOjM"
}
```

`nextCursor` is opaque: an encoded ledger position, not an offset. The ledger
only grows at the head, so an offset would shift under a reader between pages
and show one entry twice or skip another. `null` means there are no older
entries.

### Finance routes

```
POST /api/v1/admin/wallets/:publicId/credit
POST /api/v1/admin/wallets/:publicId/debit
POST /api/v1/admin/wallets/:publicId/freeze
POST /api/v1/admin/wallets/:publicId/unfreeze
GET  /api/v1/admin/wallets/:publicId/reconciliation
```

`:publicId` resolves as a wallet id first and then as a user id. Both are
`gen_random_uuid()` values from disjoint tables, so one identifier cannot mean
two wallets, and an operator who looked someone up by phone is spared having to
find the wallet's own id first.

A credit or debit body:

```json
{
  "amountMinor": "5000",
  "currency": "ETB",
  "reason": "Support case 4821 refund"
}
```

The amount must be positive — the direction comes from the endpoint — and the
reason is mandatory and becomes the entry's memo. Send an `Idempotency-Key`
header on a retryable request.

## Channels

The website's `/wallet` page and Telegram's `/wallet` command read the same
wallet through the same module functions. Neither computes a balance of its own,
and neither holds wallet logic: the controllers read the caller, validate the
request shape and serialise what comes back. `/wallet` in a chat and
`/me/wallet` in a browser cannot disagree, because there is one wallet and one
ledger behind both — asserted in `tests/db/wallet-parity.test.ts`.

The wallet is created in the same transaction that activates an account, so it
exists from the moment the account is usable. Creation is idempotent and settled
by the unique `(user_id, currency)` index, so it composes safely with the
module's own create-on-first-read for accounts that predate this phase — and
concurrent first reads produce one wallet, not ten.

## Observability

Nine events, each written to `audit_logs` and the structured log:

```
wallet.created            wallet.credited          wallet.debited
wallet.refunded           wallet.admin_credited    wallet.admin_debited
wallet.frozen             wallet.unfrozen          wallet.reconciliation_failed
```

Audit details are always assembled by the module from wallet facts — ids,
amounts, entry types — and never forwarded from a caller's request body, so no
secret can reach an audit row by arriving under an unexpected key. Passwords,
OTP codes, refresh and access tokens and provider credentials are never logged
by any of this.

Audit rows are written **in the movement's transaction**: a record of something
that rolled back would be a record of something that never happened.

## Testing

```bash
npm run test:db     # the wallet suites, against real PostgreSQL
```

| File                                  | Covers                                               |
| ------------------------------------- | ---------------------------------------------------- |
| `tests/db/wallet-concurrency.test.ts` | overdraw, lost updates, races, the lock itself       |
| `tests/db/wallet.test.ts`             | ledger, idempotency, money representation, paging    |
| `tests/db/wallet-admin.test.ts`       | adjustments, freezing, reconciliation, authorization |
| `tests/db/wallet-parity.test.ts`      | one wallet and one ledger across both channels       |

These run against real PostgreSQL because a mock cannot demonstrate that a row
lock serialises anything, and an assertion about locking that does not actually
run two transactions at once asserts nothing.

The concurrency tests are **driven, not hoped for**. The overdraw test has one
transaction apply its debit and hold the lock uncommitted while a second tries
the same, so the dangerous overlap happens on every run. Another holds the
wallet row locked from outside and shows a movement making no progress until the
lock is released — direct evidence that the lock, and not the connection pool,
is doing the work.

Both were checked against a deliberately broken build: with `FOR UPDATE`
removed, five of the seven concurrency tests fail on every run. A test that
passes either way proves nothing.
