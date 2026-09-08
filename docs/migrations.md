# `migrations/`

Schema changes are plain SQL files applied by
[`node-pg-migrate`](https://salsita.github.io/node-pg-migrate/), newest last:

```bash
npm run migrate:create -- add_wallet_ledger   # scaffolds up/down SQL
npm run migrate:up
npm run migrate:down
```

Rules for this directory:

1. **Raw SQL only.** Money, bid and result tables are defined and changed here
   in SQL that can be read and reviewed on its own. No ORM generates them.
2. **Money columns are `BIGINT`** holding minor units, never `NUMERIC` used as
   a float and never `DOUBLE PRECISION`.
3. **Constraints are the enforcement.** Bid uniqueness, maximum bids per user
   and non-negative wallet balances are database constraints, not application
   checks that a second connection could race past.
4. **Forward-only in deployed environments.** A migration that has run in
   production is never edited; a new one corrects it.

Phase 0 ships no migrations — it wires up and verifies the runner. The initial
schema arrives in Phase 1.
