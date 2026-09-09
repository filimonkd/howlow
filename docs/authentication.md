# HOWLOW authentication and identity

## The identity model

There is **one** HOWLOW identity: a row in `users`, keyed by `users.id`.

The website and the Telegram bot are two channels onto that same row. A person
who uses both does not become two accounts, because Telegram never creates an
identity — it _links_ to one:

```
Telegram user id ──▶ telegram_accounts.telegram_user_id
                          │
                          ▼
                  telegram_accounts.user_id ──▶ users.id ──▶ user_roles
```

Authorization is always resolved from `users.id`. Both channels therefore reach
identical answers for the same person, and a role granted on the website applies
in the bot immediately.

### Telegram usernames are not identity

`telegram_accounts.username` is display information and is deliberately **not**
unique. Telegram re-assigns usernames when people release them, so treating a
handle as identity would turn a username change into an account takeover. Only
the numeric `telegram_user_id` identifies anyone.

## Phase 2 decisions

| Decision           | Choice                                                  |
| ------------------ | ------------------------------------------------------- |
| Primary identifier | **Phone**, E.164, unique among live accounts            |
| Email              | Optional; unique when present; not required for the MVP |
| Verification       | OTP to the phone, mandatory                             |
| Password           | **Optional**, set after the account exists              |
| Telegram accounts  | May exist with no password at all                       |
| Telegram linking   | **Website-initiated** deep link                         |
| Refresh tokens     | **Rotated on every use**, with reuse detection          |

Phone-first suits an Ethiopia-first product: phone numbers are near-universal
and email is not.

## Registration and login

```
register(phone, displayName)
   └─ creates a `pending` user, issues an OTP
verify-phone(phone, code)
   └─ activates the user, grants the `user` role, issues a session
```

Login accepts three shapes on one endpoint, discriminated by `method`:

- `otp_request` — send a code
- `otp` — sign in with that code
- `password` — sign in with a password, once one has been set

### No account enumeration

Registration, login and password reset return **the same response whether or not
the account exists**. A wrong password and an unknown phone produce the same
status, code and wording, and the password path spends comparable time in both
cases — so response timing does not distinguish them either. This is asserted by
tests rather than left as an intention.

## OTP security

| Property            | Value                                                             |
| ------------------- | ----------------------------------------------------------------- |
| Length              | 6 digits, `crypto.randomInt` (no modulo bias)                     |
| Storage             | SHA-256 of `destination:code` — never plaintext                   |
| Lifetime            | 5 minutes                                                         |
| Attempts            | 5, then the challenge is burned                                   |
| Resend cooldown     | 60 seconds                                                        |
| Sends per challenge | 5                                                                 |
| Purposes            | `phone_verify`, `login`, `password_reset` — never interchangeable |

Only one live challenge exists per destination and purpose, enforced by a
partial unique index, so a resend replaces the code rather than creating a
second one an attacker could guess against in parallel.

**Attempt counting is written on its own connection**, outside the caller's
transaction. A rejected verification unwinds that transaction, and an increment
made inside it would be rolled back — leaving the counter permanently at zero
and the code open to unlimited guessing. This was a real bug caught by the test
suite, and the test that caught it remains.

The code is returned in the API response **only when `NODE_ENV` is not
`production`**, so the flows are testable without an SMS provider. Real delivery
arrives in Phase 11.

## Passwords

Argon2id, at OWASP's parameters (19 MiB, 2 iterations, parallelism 1). The cost
is encoded in the hash, so it can be raised later without invalidating existing
hashes.

- Optional: Telegram-created accounts never need one.
- Changing an existing password requires the current one — an access token alone
  must not let someone lock the owner out.
- A password change or reset **revokes every other session**, because that is
  exactly when a stolen session should stop working.
- Five failed attempts locks the account for 15 minutes. Lockout state lives in
  PostgreSQL, not Redis: throttling that protects credentials must not be
  resettable by restarting a cache.

## Sessions and refresh-token rotation

Access tokens are short-lived HS256 JWTs carrying `sub`, `sid`, `channel` and
`roles`. Refresh tokens are opaque 256-bit random strings, stored only as a
SHA-256 digest.

SHA-256 rather than Argon2 for refresh tokens: the token is already full-entropy
from a CSPRNG, so there is no weak secret to slow an attacker over, and refresh
happens often enough that a memory-hard hash would be self-inflicted load.

### Rotation

```
present refresh token
   └─ validate  ──▶ create a NEW session row in the same family
                    revoke the old one, link old ──▶ new
                    return a new access + refresh pair
```

Every rotation from one login shares a `family_id`, so the family is the audit
trail of that login's token chain.

### Reuse detection

Presenting an **already-revoked** refresh token means the token leaked and is
being replayed — the legitimate holder would have the newest one. HOWLOW cannot
tell which party is the thief, so it revokes the whole family and forces
re-authentication.

**That revocation is written on its own connection**, outside the rotation
transaction. The request is rejected immediately afterwards, and a rejection
unwinds its transaction — so a revocation recorded inside it would be rolled
back and reuse detection would silently do nothing. Also a real bug caught by
the tests, and also still covered.

An access token is checked against its session on every request, so logout, a
password change and reuse detection all take effect immediately rather than
waiting for the access token to expire.

## Telegram account linking

Website-initiated, single-use, expiring:

```
Website  "Connect Telegram"
   └─ POST /me/telegram/link
        └─ 256-bit random token; only its SHA-256 hash is stored
        └─ returns https://t.me/<bot>?start=link_<token>
Telegram /start link_<token>
   └─ bot asks "Connect this Telegram account?"  [Confirm] [Cancel]
        └─ Confirm ──▶ validate, link, mark consumed, audit
```

The confirmation runs in one transaction that claims the token with `FOR
UPDATE`, so two confirmations racing the same token serialise and the second
finds it consumed. Single use is guaranteed by the database, not by handler
ordering.

Linking is refused when the Telegram account already belongs to another HOWLOW
user, when the token is expired or consumed, or when the target account is not
active. Issuing a new token retires any previous live one.

### Unlinking

Refused when Telegram is the account's only way back in — an account with no
verified phone and no password would become unreachable. Bids and orders are
never touched: they belong to the HOWLOW user, not to the channel that created
them.

## Roles

`user`, `seller`, `support_agent`, `finance`, `auction_manager`, `admin`,
`super_admin`. `super_admin` satisfies any requirement; the others do not
inherit. A refusal never names the role the caller was missing.

## API

| Method   | Path                                  | Auth     | Purpose                               |
| -------- | ------------------------------------- | -------- | ------------------------------------- |
| `POST`   | `/api/v1/auth/register`               | —        | Create a pending account, send a code |
| `POST`   | `/api/v1/auth/verify-phone`           | —        | Verify, activate, issue a session     |
| `POST`   | `/api/v1/auth/login`                  | —        | `otp_request` / `otp` / `password`    |
| `POST`   | `/api/v1/auth/refresh`                | —        | Rotate the refresh token              |
| `POST`   | `/api/v1/auth/logout`                 | optional | Revoke this session or all            |
| `POST`   | `/api/v1/auth/request-password-reset` | —        | Send a reset code                     |
| `POST`   | `/api/v1/auth/reset-password`         | —        | Reset with a code                     |
| `POST`   | `/api/v1/auth/change-password`        | Bearer   | Set or change a password              |
| `GET`    | `/api/v1/me`                          | Bearer   | The authenticated identity            |
| `POST`   | `/api/v1/me/telegram/link`            | Bearer   | Create a linking deep link            |
| `GET`    | `/api/v1/me/telegram/status`          | Bearer   | Whether Telegram is connected         |
| `DELETE` | `/api/v1/me/telegram`                 | Bearer   | Disconnect Telegram                   |

Identifiers at the boundary are UUIDs — opaque and non-enumerable. The only
sequential key in the schema is `audit_logs.id`, which no endpoint exposes.

## Rate limits

Counted in Redis per subject, per window:

| Operation         | Limit       |
| ----------------- | ----------- |
| register          | 5 / hour    |
| OTP send          | 5 / hour    |
| OTP verify        | 10 / 15 min |
| login             | 10 / 15 min |
| password reset    | 5 / hour    |
| refresh           | 60 / 15 min |
| Telegram `/start` | 20 / hour   |
| Telegram linking  | 10 / hour   |

Rate limiting **fails open** when Redis is unavailable. It is defence in depth;
the OTP attempt counter and account lockout in PostgreSQL are the hard limits,
and refusing every login because a cache is down would turn a degraded cache
into a total outage.

## Audit

Every event in `AUTH_EVENTS` is written to the append-only `audit_logs` table:
registration, verification, login success and failure, password set / changed /
reset, session created and revoked, refresh rotated, **refresh reuse detected**,
Telegram link created / linked / unlinked, and account lockout.

Audit payloads are scrubbed against a key denylist before being written, so a
password, OTP, token or hash cannot reach an audit row even if a caller passes
one. A test asserts that no secret appears in the trail.

## Local testing

```bash
docker compose up -d postgres redis
npm run migrate
npm run dev
```

Then at <http://localhost:5173>: register with a phone like `+251911234567`. The
development build shows the OTP on screen, so no SMS provider is needed.

To exercise the whole HTTP surface at once:

```bash
npm run verify:auth     # register → verify → rotate → reuse → password → link → logout
npm run test:db         # 70 tests against real PostgreSQL and Redis
```

Telegram requires a real bot to test end to end:

```bash
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=<from @BotFather>
TELEGRAM_WEBHOOK_SECRET=<any random string, 16+ characters>
TELEGRAM_BOT_USERNAME=<bot username without the @>
```

No Telegram credentials are committed, and none are needed for any test or for
`npm run dev`. With the channel enabled, the API resolves the bot's identity at
startup and logs one clear line if the Bot API is unreachable, rather than
leaving the first webhook delivery hanging.
