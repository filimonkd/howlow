# `modules/` — business logic

Every HOWLOW business rule lives here and nowhere else. A module owns its
domain types, its SQL, and its transactions.

Phase 0 ships only the `health` module. Later phases add, one module per
bounded area:

```
modules/
  auth/         identity, sessions, telegram account linking   (Phase 2)
  wallet/       the single ledger; all money mutation           (Phase 3)
  catalog/      products and sellers                            (Phase 4)
  auctions/     auction lifecycle                               (Phase 4)
  bidding/      the single bidding engine                       (Phase 5)
  results/      the single LUB_V1 implementation                (Phase 6)
  payments/     provider integrations and reconciliation        (Phase 9)
  orders/       fulfilment and shipping                         (Phase 10)
  notifications/ channel-agnostic delivery                      (Phase 11)
```

## Rules

1. A module exposes an application service through its `index.ts`. Callers
   import the barrel, never a file inside the module.
2. Both channel adapters — HTTP and Telegram — call the _same_ service
   functions with the same arguments. There is no "telegram bidding" and no
   "web wallet".
3. Modules may import `db/`, `config/`, `shared/` and other modules' barrels.
   Modules must never import anything under `channels/`.
4. Money is `bigint` minor units end to end (see `@howlow/shared`). Financial
   writes go through `withTransaction` from `db/`.
5. Anything a channel needs to display is returned as data. A module never
   formats a Telegram message or an HTTP status code.
