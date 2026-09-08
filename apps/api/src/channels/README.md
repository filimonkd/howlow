# `channels/` — client adapters

HOWLOW has exactly two first-class clients, and both are adapters over the same
backend:

- `http/` — the website API surface
- `telegram/` — the grammY bot, in webhook mode

## What an adapter does

Translate a transport-specific request into a call on an application service in
`modules/`, then translate the result back into a transport-specific response.
That is all.

## What an adapter must never contain

- SQL, or any import of `db/`
- transactions
- business rules of any kind
- wallet mutation
- auction lifecycle logic
- LUB_V1 calculation

Nor may a channel import another channel: `telegram/` cannot import `http/`,
and `http/` cannot import `telegram/`. Shared behaviour between channels
belongs in `modules/` or `shared/`.

These constraints are enforced by `no-restricted-imports` rules in
`eslint.config.js`, and CI fails the pull request when they are violated.
