# HOWLOW database

PostgreSQL 16 is the financial truth of HOWLOW. Redis is a cache, a rate limiter
and a queue transport, and the system is reconstructible without it.

## Money

Every monetary column is `BIGINT` holding an integer count of **minor units**.

| Amount         | Stored as  |
| -------------- | ---------- |
| ETB 1.00       | `100`      |
| ETB 27.00      | `2700`     |
| ETB 120,000.00 | `12000000` |

No `NUMERIC`, no `REAL`, no `DOUBLE PRECISION`, and no float arithmetic anywhere
on a money path. `npm run db:verify` fails the build if any column named
`*_minor` is not `BIGINT`, or if any floating-point column appears at all.

The `pg` driver returns `BIGINT` as a JavaScript `number` by default, which
silently loses whole cents above 2^53. `apps/api/src/db/types.ts` replaces that
parser so those columns arrive as strings and can only become `bigint`.

## Tables

| Group      | Tables                                                                             |
| ---------- | ---------------------------------------------------------------------------------- |
| Identity   | `users`, `user_roles`, `sessions`, `otp_challenges`                                |
| Telegram   | `telegram_accounts`, `telegram_link_tokens`                                        |
| Catalog    | `sellers`, `categories`, `products`, `product_images`                              |
| Auction    | `auctions`, `auction_participants`, `bids`, `auction_results`                      |
| Wallet     | `wallets`, `wallet_entries`                                                        |
| Commerce   | `orders`, `payments`, `payment_events`, `refunds`, `shipments`                     |
| Platform   | `idempotency_keys`, `notifications`, `telegram_outbox`, `notification_preferences` |
| Governance | `audit_logs`, `fraud_flags`                                                        |

## Rules the database enforces

These are constraints, not conventions. An application check can be raced past
by a concurrent request; a database constraint cannot.

### The duplicate-bid rule

```sql
CREATE UNIQUE INDEX bids_valid_amount_unique_key
  ON bids (auction_id, user_id, amount_minor)
  WHERE status = 'valid';
```

One user may never hold two **valid** bids at the same amount in the same
auction. It is partial, so voiding a bid frees that amount for a legitimate
re-bid. Two other users bidding the same amount is allowed — that collision is
the entire game.

### Append-only tables

`wallet_entries`, `audit_logs`, `auction_results` and `payment_events` reject
`UPDATE` and `DELETE` outright, via the `forbid_mutation()` trigger. Correcting
a ledger mistake means writing a compensating entry, never editing history.

### Immutability triggers

- **`auctions`** — once `closed`, `settled` or `cancelled`, the terms an auction
  was decided under (fee, bid range, deadlines, algorithm) cannot change. A
  `settled` auction cannot be reopened.
- **`bids`** — the auction, bidder, amount, fee, channel and time are fixed on
  insert. Only `status` may move (`valid` → `void` / `refunded`).

### Other enforced invariants

| Rule                                                    | Where                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------- |
| Auction ends after it starts                            | `auctions_time_range_ordered`                                             |
| Bid range is ordered                                    | `auctions_bid_range_ordered`                                              |
| Only `LUB_V1` decides an auction                        | `auctions_algorithm_is_lub_v1`                                            |
| At least one bid allowed per user                       | `auctions_max_bids_per_user_positive`                                     |
| Product stock never negative                            | `products_stock_non_negative`                                             |
| Wallet balances never negative                          | `wallets_available_non_negative`, `wallets_reserved_non_negative`         |
| No zero-value ledger entry                              | `wallet_entries_amount_non_zero`                                          |
| Ledger never leaves a negative balance                  | `wallet_entries_balance_non_negative`                                     |
| Order total equals the sum of its parts                 | `orders_total_is_sum_of_parts`                                            |
| A winner is all three facts or none                     | `auction_results_winner_complete`                                         |
| One result per auction, ever                            | `auction_results_auction_id_key`                                          |
| One Telegram account per user, one user per Telegram id | `telegram_accounts_user_id_key`, `telegram_accounts_telegram_user_id_key` |
| Link tokens expire and are single-use                   | `telegram_link_tokens_*`                                                  |
| Bid submission is idempotent                            | `bids_idempotency_key_unique`                                             |
| Webhook delivery is idempotent                          | `payment_events_provider_event_key`                                       |

Telegram usernames are **display information only**. They are re-assignable by
Telegram, so `telegram_user_id` is the identity and the username is deliberately
not unique.

## Commands

```bash
npm run migrate            # apply pending migrations
npm run migrate:down       # roll back the most recent migration
npm run migrate:create -- add_something   # scaffold a new SQL migration
npm run db:verify          # assert the schema is complete and money types are sound
npm run seed               # idempotent development seed data
npm run db:reset           # roll everything back, re-migrate, re-seed
npm run test:db            # constraint tests against real PostgreSQL
```

`npm test` stays fast and needs no database. `npm run test:db` needs one; CI
runs both.

## Seed data

`seeds/dev.ts` is idempotent — deterministic ids and upserts, so repeated runs
converge rather than accumulate. It creates an admin, a seller, a buyer, four
categories, four products with images, one live auction and one scheduled
auction.

**No balances are seeded.** Wallets are created at zero. Money enters a HOWLOW
wallet only through the ledger, and inventing a balance would leave a row in
`wallets` that no `wallet_entries` history explains — exactly the divergence the
ledger exists to make impossible. Passwords are likewise not seeded;
credentials arrive with Phase 2.

## Migration rules

1. **Raw SQL only** on the money, bid and result paths. No ORM generates or
   hides those queries.
2. **Constraints are the enforcement**, not application checks.
3. **Forward-only in deployed environments.** A migration that has run in
   production is never edited; a new one corrects it.
4. Every migration has a working `Down Migration`. CI proves the whole stack
   rolls back and re-applies on every pull request.
