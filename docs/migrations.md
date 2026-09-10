# `migrations/`

Schema changes are plain SQL files applied by
[`node-pg-migrate`](https://salsita.github.io/node-pg-migrate/), newest last:

```bash
npm run migrate:create -- add_wallet_ledger   # scaffolds 0011_add-wallet-ledger.sql
npm run migrate
npm run migrate:down
```

Migrations are **numbered**, not timestamped: `0001_foundation.sql`,
`0002_identity.sql`, and so on. `migrate:create` passes
`--migration-filename-format index` so a new migration continues that sequence.

This matters more than it looks. node-pg-migrate applies files in filename
order and refuses to run a migration that sorts _before_ one already applied.
A timestamp-prefixed file (`1788956251376_…`) sorts after every numbered file,
so once it has run, the next numbered migration is "preceding an already run
migration" and the whole runner stops:

```
Error: Not run migration 0010_auth is preceding already run
       migration 1788956251376_add-wallet-ledger
```

If that happens, the stray migration has to be removed from both the directory
and the tracking table:

```bash
rm migrations/<timestamp>_<name>.sql
docker compose exec postgres \
  psql -U howlow -d howlow -c "DELETE FROM pgmigrations WHERE name = '<timestamp>_<name>';"
npm run migrate
```

Only do that for a migration that made no schema changes. One that did needs
its `Down Migration` run first, with `npm run migrate:down`.

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
