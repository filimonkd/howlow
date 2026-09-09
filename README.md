# HOWLOW

HOWLOW is a lowest-unique-bid auction platform with **two first-class clients** —
a **website** and a **Telegram bot** — sitting on **one backend**.

> Telegram is not a separate backend. The website is not a separate backend.
> There is one auction engine, one wallet ledger, one bidding engine, one
> `LUB_V1` implementation and one user identity, and both channels call them.

---

## Architecture

```
                 ┌──────────────┐        ┌──────────────┐
                 │   Website    │        │   Telegram   │
                 │  React 19    │        │   grammY     │
                 └──────┬───────┘        └───────┬──────┘
                        │ HTTP                   │ webhook
        ┌───────────────▼────────────────────────▼───────────────┐
        │                    apps/api                            │
        │  channels/http          channels/telegram              │
        │        └──────────┬───────────┘                        │
        │                   ▼                                    │
        │                modules/   ← all business logic         │
        │        auth · wallet · catalog · auctions · bidding    │
        │        results (LUB_V1) · payments · orders            │
        │                   │                                    │
        │                  db/   pg pool · transactions · redis  │
        └───────────────────┬────────────────────────────────────┘
                            │
        ┌───────────────────▼──────────┐    ┌──────────────────┐
        │  PostgreSQL 16               │    │  apps/worker     │
        │  financial truth             │◄───┤  auction closing │
        └──────────────────────────────┘    │  LUB_V1 runs     │
        ┌──────────────────────────────┐    │  notifications   │
        │  Redis 7                     │◄───┤  BullMQ          │
        │  cache · queues · rate limit │    └──────────────────┘
        │  never financial truth       │
        └──────────────────────────────┘
```

### The channel model

A **channel** is how a request reached HOWLOW. It is metadata — nothing more.

| A channel adapter may               | A channel adapter may never                  |
| ----------------------------------- | -------------------------------------------- |
| Parse and validate transport input  | Contain a business rule                      |
| Call a service in `modules/`        | Import `db/`, open a pool, or write SQL      |
| Format the result for its transport | Open a transaction                           |
| Import `shared/`                    | Mutate a wallet or compute an auction result |
|                                     | Import the _other_ channel                   |

These constraints are enforced by `no-restricted-imports` rules in
`eslint.config.js`, so a violation fails CI rather than sliding through review.

### Invariants

The design invariants that the code and CI defend:

- Exactly one auction engine, one `LUB_V1` implementation, one wallet ledger,
  one user identity. Telegram and web are clients of all four.
- Money is `BIGINT` minor units end to end. No floating point ever touches a
  monetary value — the `pg` driver's `number` parsers for `BIGINT`/`NUMERIC`
  are replaced in `apps/api/src/db/types.ts` so that precision cannot be lost
  silently, and `@howlow/shared` exposes `bigint` money helpers instead.
- PostgreSQL is financial truth. Redis is a cache, a rate limiter and a queue
  transport, and the system is reconstructible without it.
- Financial operations are transactional and auditable; they run through
  `withTransaction` in `apps/api/src/db/transaction.ts`.
- Auction closure is worker-driven, never triggered on a request path.
- Completed auction results are immutable, and live bid uniqueness is never
  revealed.

---

## Technology

| Area       | Choice                                             |
| ---------- | -------------------------------------------------- |
| Backend    | Node.js 22 · Express 5 · TypeScript (strict)       |
| Frontend   | React 19 · Vite 7 · Tailwind CSS 4 · TypeScript    |
| Telegram   | grammY, webhook mode                               |
| Database   | PostgreSQL 16                                      |
| Cache      | Redis 7                                            |
| Jobs       | BullMQ                                             |
| Storage    | S3-compatible (MinIO in development)               |
| Migrations | node-pg-migrate, raw SQL on money/bid/result paths |
| Shape      | Modular monolith (`apps/api`) + separate worker    |

---

## Repository structure

```
howlow/
├── apps/
│   ├── api/                    modular monolith: both channels + all modules
│   │   └── src/
│   │       ├── config/         validated environment (zod)
│   │       ├── db/             pg pool, transactions, redis, safe type parsers
│   │       ├── channels/
│   │       │   ├── http/       website API surface
│   │       │   └── telegram/   grammY webhook adapter
│   │       ├── modules/        ALL business logic lives here
│   │       ├── realtime/       SSE/WebSocket fan-out (Phase 11)
│   │       └── shared/         logger, request context
│   ├── worker/                 BullMQ consumer: auction closing, LUB_V1, jobs
│   │   └── src/{config,jobs,queues,shared}
│   └── web/                    React website
│       └── src/{app,components,lib,styles}
├── packages/
│   └── shared/                 money primitives, error taxonomy, zod schemas
├── migrations/                 raw SQL migrations (node-pg-migrate)
├── scripts/smoke.mjs           runtime verification used by CI
├── docker-compose.yml          postgres · redis · minio · mailpit
├── .github/workflows/ci.yml    lint · typecheck · test · build · migrate · smoke
└── .env.example
```

---

## Local setup

Requirements: **Node.js 22+**, **npm 10+**, **Docker** (for the backing
services).

```bash
git clone https://github.com/filimonkd/howlow.git
cd howlow
npm install

cp .env.example .env
# Generate the two secrets the API refuses to start without:
node -e "console.log('JWT_SECRET='+require('crypto').randomBytes(48).toString('base64url'))"
node -e "console.log('SESSION_SECRET='+require('crypto').randomBytes(48).toString('base64url'))"
# paste both into .env

npm run docker:up      # postgres, redis, minio, mailpit
npm run migrate:up     # apply schema
npm run dev            # api :4000 · worker · web :5173
```

Then open <http://localhost:5173>. The page reports the API's readiness,
including the live PostgreSQL and Redis checks.

### Services started by `docker compose`

| Service  | Purpose                    | Ports                                           |
| -------- | -------------------------- | ----------------------------------------------- |
| postgres | PostgreSQL 16              | `5432`                                          |
| redis    | Redis 7                    | `6379`                                          |
| minio    | S3-compatible object store | `9000` (API), `9001` (console)                  |
| mailpit  | Local SMTP + web inbox     | `1025` (SMTP), `8025` (<http://localhost:8025>) |

`minio-init` runs once to create the `howlow-dev` bucket, then exits — that is
expected, not a failure. It waits for MinIO by retrying, so `docker compose
up` never blocks on a healthcheck for it.

MinIO reports `Up` rather than `Up (healthy)`: it deliberately has no
healthcheck. See the comment in `docker-compose.yml` for why.

Only `postgres` and `redis` are required to run the application today; MinIO and
Mailpit are used from Phase 9 onward. To start just the essentials:

```bash
docker compose up -d postgres redis
```

### Docker troubleshooting

| Symptom                                                                                       | Cause and fix                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified` (Windows) | Docker Desktop's engine is not running. The CLI is installed separately, so `docker` exists either way. Launch Docker Desktop and wait for "Engine running"; `docker version` must print a **Server** section.                                                                                           |
| `wsl -l -v` lists no `docker-desktop` distro (Windows)                                        | The engine VM was never provisioned. Launching Docker Desktop creates it on first successful start; watch that window for the real error if it fails.                                                                                                                                                    |
| `mkdir /var/lib/docker/overlay2/…: read-only file system`                                     | The engine's own disk filled up or errored and remounted read-only. Free space on the host, restart Docker Desktop, and if it persists use Docker Desktop → Troubleshoot → **Clean / Purge data** to recreate the disk image. `docker system prune` will not help — it needs to write to the same store. |
| A service is unhealthy but the others are fine                                                | `docker compose logs <service>` first. Nothing in the app depends on MinIO or Mailpit yet, so those can be left stopped.                                                                                                                                                                                 |
| `Found orphan containers …`                                                                   | Containers left by an earlier version of this file. Clear them with `docker compose up -d --remove-orphans`.                                                                                                                                                                                             |

If Docker proves troublesome on Windows, running the whole stack inside WSL2 —
PostgreSQL and Redis installed natively in an Ubuntu distro — works just as well
and avoids the virtual-disk layer entirely.

---

## Environment configuration

Every variable HOWLOW reads is declared once, in
`apps/api/src/config/env.ts`, and validated with zod at startup. The process
**refuses to start** on an invalid or incomplete environment rather than
failing later on a request path. The worker imports the same contract, so both
processes agree on configuration by construction.

`.env.example` documents every variable with placeholder values. `.env` is
git-ignored. **Never commit a real secret.** `JWT_SECRET` and `SESSION_SECRET`
must each be at least 32 characters and are rejected if they still look like a
placeholder.

Enabling the Telegram channel requires `TELEGRAM_ENABLED=true` _and_ both
`TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`; the schema enforces that
pairing. While disabled, the webhook route is not mounted at all.

---

## Commands

| Command                  | What it does                                               |
| ------------------------ | ---------------------------------------------------------- |
| `npm run dev`            | API, worker and web together, all watching                 |
| `npm run dev:api`        | API only (`:4000`)                                         |
| `npm run dev:worker`     | Worker only                                                |
| `npm run dev:web`        | Website only (`:5173`, proxies `/api` to the API)          |
| `npm run build`          | Build shared → api → worker → web                          |
| `npm run start:api`      | Run the built API                                          |
| `npm run start:worker`   | Run the built worker                                       |
| `npm run lint`           | ESLint, **including the architecture boundary rules**      |
| `npm run lint:fix`       | ESLint with autofix                                        |
| `npm run typecheck`      | Build project references, then typecheck sources and tests |
| `npm test`               | Vitest, once                                               |
| `npm run test:watch`     | Vitest, watching                                           |
| `npm run format`         | Prettier, write                                            |
| `npm run format:check`   | Prettier, check only (CI gate)                             |
| `npm run check`          | format:check → lint → typecheck → test → build             |
| `npm run verify:runtime` | Boot the built API and assert Postgres + Redis are up      |
| `npm run docker:up`      | Start backing services                                     |
| `npm run docker:down`    | Stop them (keeps volumes)                                  |
| `npm run docker:reset`   | Stop them and **delete volumes**                           |

### Migrations

```bash
npm run migrate:create -- add_wallet_ledger   # scaffolds up/down SQL files
npm run migrate:up
npm run migrate:down
```

Migrations are raw SQL. See [docs/migrations.md](docs/migrations.md) for the
rules that apply to money, bid and result tables.

---

## Branch strategy

`main` is protected and is never committed to directly.

```bash
git checkout main
git pull
git checkout -b feature/phase-1-database
```

Branch names follow `feature/<phase>-<short-description>`, e.g.
`feature/phase-3-wallet`.

## Pull request workflow

```
local changes → commit → push → PR → human review → human merge
```

Before opening a PR, run `npm run check`, then `npm run verify:runtime` if the
change touches the API boot path. CI runs the same gates plus migration
verification, the smoke test and a secret scan; a PR whose CI is red is not
ready for review. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Implementation phases

| Phase | Scope                             | State       |
| ----- | --------------------------------- | ----------- |
| **0** | Project foundation                | **this PR** |
| 1     | Database + migrations             | next        |
| 2     | Authentication + unified identity | planned     |
| 3     | Wallet + ledger                   | planned     |
| 4     | Catalog + auctions                | planned     |
| 5     | Core bidding engine               | planned     |
| 6     | Auction closing + `LUB_V1`        | planned     |
| 7     | Website MVP                       | planned     |
| 8     | Telegram Bot MVP                  | planned     |
| 9     | Payments                          | planned     |
| 10    | Orders + shipping                 | planned     |
| 11    | Notifications + realtime          | planned     |
| 12    | Admin + seller + fraud            | planned     |
| 13    | Testing + security hardening      | planned     |
| 14    | Production deployment + beta      | planned     |

Phase 0 deliberately contains **no** auction, bidding, wallet, payment or
`LUB_V1` logic. It establishes the foundation those phases are built on.
