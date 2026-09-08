# Contributing to HOWLOW

## The rule that matters most

HOWLOW has one backend serving two channels. Before writing code, decide which
layer your change belongs to:

- **A business rule?** It goes in `apps/api/src/modules/`. Both the website and
  the Telegram bot then get it for free.
- **A new way to reach an existing rule?** It goes in
  `apps/api/src/channels/http/` or `apps/api/src/channels/telegram/`, as a thin
  translation into a service call.

If you find yourself about to write SQL, open a transaction, or compute
anything about money or auction results inside `channels/`, stop — the logic
belongs in a module. ESLint will reject the import anyway.

## Working on a change

```bash
git checkout main && git pull
git checkout -b feature/phase-3-wallet
```

Branch naming: `feature/<phase>-<short-description>`.

Never commit to `main`.

## Before you push

```bash
npm run check           # format:check → lint → typecheck → test → build
npm run verify:runtime  # if you touched the API boot path
git diff                # read your own diff
```

Then check that no credential is in the diff. `.env` is git-ignored; if a
secret ever reaches a tracked file, **stop**, remove it from the working tree
and from history as appropriate, and do not push.

## Commits

Conventional commits, logically grouped:

```
chore: initialize howlow monorepo
feat(db): add initial postgres schema
feat(wallet): implement transactional wallet ledger
feat(bidding): implement atomic bid submission
fix(auction): freeze bid set before running lub v1
```

Not `changes`, `update`, or `fix stuff`.

## Pull requests

Open the PR against `main` and fill in every section of the template. Do not
merge your own PR — the workflow is
`local → commit → push → PR → human review → human merge`.

CI must be green. It runs formatting, lint (including the architecture boundary
rules), typecheck, tests, build, migration verification, a runtime smoke test,
and a secret scan.

## Code standards

- **TypeScript is strict**, including `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`. Do not widen the config to make an error go
  away.
- **Money is `bigint` minor units.** Never `number`, never a float, never a
  string that gets `parseFloat`-ed. Use the helpers in `@howlow/shared`.
- **Financial writes are transactional.** Use `withTransaction`; do not run two
  related money statements on two connections.
- **Constraints belong in the database.** Bid uniqueness, per-user bid limits
  and non-negative balances are enforced by PostgreSQL, not by an application
  check that a concurrent request can race past.
- **Raw SQL on the money, bid and result paths.** No ORM generates or hides
  those queries.
- **Errors are domain errors.** Throw `AppError` from `@howlow/shared`; only
  the HTTP channel's error handler knows about status codes.
- Prefer simple, explicit and testable code over abstraction that anticipates a
  requirement nobody has yet.

## Tests

Vitest, co-located as `*.test.ts` next to the code under test. Anything that
touches money, bid ordering or auction results needs a test that would fail if
the rule were removed.
