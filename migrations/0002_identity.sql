-- Up Migration
--
-- ONE HOWLOW user identity. The website and the Telegram bot are channels onto
-- the same row in `users`; neither has an identity of its own.

CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              citext,
  phone              text,
  password_hash      text,
  display_name       text        NOT NULL,
  locale             text        NOT NULL DEFAULT 'en',
  status             user_status NOT NULL DEFAULT 'pending',
  email_verified_at  timestamptz,
  phone_verified_at  timestamptz,
  last_login_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT users_display_name_not_blank CHECK (length(btrim(display_name)) > 0),
  -- E.164, so one phone has exactly one representation and uniqueness is real.
  CONSTRAINT users_phone_e164 CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{6,14}$'),
  CONSTRAINT users_email_shape CHECK (email IS NULL OR email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
);

-- Partial uniqueness: a deleted account must not block re-registration, but two
-- live accounts can never share an identifier.
CREATE UNIQUE INDEX users_email_active_key ON users (email)
  WHERE email IS NOT NULL AND status <> 'deleted';
CREATE UNIQUE INDEX users_phone_active_key ON users (phone)
  WHERE phone IS NOT NULL AND status <> 'deleted';
CREATE INDEX users_status_idx ON users (status);
CREATE INDEX users_created_at_idx ON users (created_at DESC);

CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE users IS
  'The single HOWLOW identity. Telegram and web are channels onto this row.';

CREATE TABLE user_roles (
  user_id    uuid      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       role_name NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by uuid REFERENCES users (id) ON DELETE SET NULL,

  PRIMARY KEY (user_id, role)
);

CREATE INDEX user_roles_role_idx ON user_roles (role);
CREATE INDEX user_roles_granted_by_idx ON user_roles (granted_by)
  WHERE granted_by IS NOT NULL;

CREATE TABLE sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Only the hash is stored: a database leak must not yield usable sessions.
  refresh_token_hash text    NOT NULL,
  channel            channel NOT NULL,
  user_agent         text,
  ip_address         inet,
  issued_at          timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  last_used_at       timestamptz,

  CONSTRAINT sessions_expiry_after_issue CHECK (expires_at > issued_at)
);

CREATE UNIQUE INDEX sessions_refresh_token_hash_key ON sessions (refresh_token_hash);
CREATE INDEX sessions_user_active_idx ON sessions (user_id, expires_at DESC)
  WHERE revoked_at IS NULL;
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE otp_challenges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid REFERENCES users (id) ON DELETE CASCADE,
  -- Email address or E.164 phone the code was sent to. Nullable user_id because
  -- registration issues a challenge before the account exists.
  destination  text        NOT NULL,
  purpose      otp_purpose NOT NULL,
  -- Only the hash is stored, never the code itself.
  code_hash    text        NOT NULL,
  attempts     integer     NOT NULL DEFAULT 0,
  max_attempts integer     NOT NULL DEFAULT 5,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,

  CONSTRAINT otp_attempts_non_negative CHECK (attempts >= 0),
  CONSTRAINT otp_attempts_within_limit CHECK (attempts <= max_attempts),
  CONSTRAINT otp_max_attempts_positive  CHECK (max_attempts > 0),
  CONSTRAINT otp_expiry_after_creation  CHECK (expires_at > created_at)
);

-- At most one live challenge per destination and purpose, so a resend replaces
-- rather than accumulates and an attacker cannot farm parallel guesses.
CREATE UNIQUE INDEX otp_challenges_live_key ON otp_challenges (destination, purpose)
  WHERE consumed_at IS NULL;
CREATE INDEX otp_challenges_expires_at_idx ON otp_challenges (expires_at);
CREATE INDEX otp_challenges_user_idx ON otp_challenges (user_id) WHERE user_id IS NOT NULL;

-- Down Migration
DROP TABLE IF EXISTS otp_challenges;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS user_roles;
DROP TABLE IF EXISTS users;
