-- Up Migration
--
-- Additive changes Phase 2 needs. The Phase 1 schema is not rewritten: this
-- renames two enum labels, widens the role enum, and adds columns.

-- PHONE_VERIFY reads better than 'registration' now that the same purpose also
-- covers verifying a phone added to an existing account.
ALTER TYPE otp_purpose RENAME VALUE 'registration' TO 'phone_verify';

-- Widen the role set. Done by swapping the type rather than ALTER TYPE ... ADD
-- VALUE, because adding an enum value cannot be used in the same transaction
-- that adds it, and migrations run transactionally.
ALTER TYPE role_name RENAME VALUE 'support' TO 'support_agent';
ALTER TYPE role_name RENAME TO role_name_old;

CREATE TYPE role_name AS ENUM (
  'user',
  'seller',
  'support_agent',
  'finance',
  'auction_manager',
  'admin',
  'super_admin'
);

ALTER TABLE user_roles
  ALTER COLUMN role TYPE role_name USING role::text::role_name;

DROP TYPE role_name_old;

-- --------------------------------------------------------------------------
-- Sessions: refresh-token rotation with reuse detection.
--
-- Each rotation writes a NEW session row sharing the family_id and revokes the
-- old one. A refresh token that is presented after being revoked means the
-- token leaked and someone is replaying it, so the whole family is revoked and
-- the user must re-authenticate.
-- --------------------------------------------------------------------------
ALTER TABLE sessions
  ADD COLUMN family_id           uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN replaced_by_session_id uuid REFERENCES sessions (id) ON DELETE SET NULL,
  ADD COLUMN reuse_detected_at   timestamptz,
  ADD COLUMN revoked_reason      text;

-- Revoking a whole family on reuse must not scan every session ever issued.
CREATE INDEX sessions_family_idx ON sessions (family_id);
CREATE INDEX sessions_replaced_by_idx ON sessions (replaced_by_session_id)
  WHERE replaced_by_session_id IS NOT NULL;

COMMENT ON COLUMN sessions.family_id IS
  'Groups a refresh token and every token rotated from it. Reuse revokes the family.';
COMMENT ON COLUMN sessions.refresh_token_hash IS
  'SHA-256 of the refresh token. The raw token is never stored.';

-- --------------------------------------------------------------------------
-- Account lockout. Kept in PostgreSQL rather than Redis: throttling state that
-- protects credentials must not be resettable by restarting a cache.
-- --------------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN failed_login_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN locked_until          timestamptz,
  ADD COLUMN password_changed_at   timestamptz,
  ADD CONSTRAINT users_failed_login_attempts_non_negative
    CHECK (failed_login_attempts >= 0);

-- --------------------------------------------------------------------------
-- OTP resend accounting. The live-challenge index means a resend updates the
-- existing row, so the row itself has to remember how often it has been sent.
-- --------------------------------------------------------------------------
ALTER TABLE otp_challenges
  ADD COLUMN sent_count   integer     NOT NULL DEFAULT 1,
  ADD COLUMN last_sent_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT otp_challenges_sent_count_positive CHECK (sent_count > 0);

-- --------------------------------------------------------------------------
-- Fix an unreachable referential action introduced in Phase 1.
--
-- audit_logs.actor_user_id was ON DELETE SET NULL, but audit_logs rejects
-- UPDATE via the append-only trigger — and SET NULL is implemented as exactly
-- that UPDATE. Deleting any user with audit history therefore failed with
-- "audit_logs is append-only", which is confusing and leaves the delete
-- impossible rather than merely restricted.
--
-- RESTRICT states the real rule: a user with audit history is not hard-deleted.
-- Accounts are retired by setting status = 'deleted', which the partial unique
-- indexes on email and phone already account for by freeing the identifiers.
-- --------------------------------------------------------------------------
ALTER TABLE audit_logs
  DROP CONSTRAINT audit_logs_actor_user_id_fkey,
  ADD CONSTRAINT audit_logs_actor_user_id_fkey
    FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE RESTRICT;

-- Down Migration
ALTER TABLE otp_challenges
  DROP CONSTRAINT IF EXISTS otp_challenges_sent_count_positive,
  DROP COLUMN IF EXISTS last_sent_at,
  DROP COLUMN IF EXISTS sent_count;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_failed_login_attempts_non_negative,
  DROP COLUMN IF EXISTS password_changed_at,
  DROP COLUMN IF EXISTS locked_until,
  DROP COLUMN IF EXISTS failed_login_attempts;

DROP INDEX IF EXISTS sessions_replaced_by_idx;
DROP INDEX IF EXISTS sessions_family_idx;
ALTER TABLE sessions
  DROP COLUMN IF EXISTS revoked_reason,
  DROP COLUMN IF EXISTS reuse_detected_at,
  DROP COLUMN IF EXISTS replaced_by_session_id,
  DROP COLUMN IF EXISTS family_id;

ALTER TYPE role_name RENAME TO role_name_new;
CREATE TYPE role_name AS ENUM ('user', 'seller', 'support_agent', 'admin');
ALTER TABLE user_roles
  ALTER COLUMN role TYPE role_name USING role::text::role_name;
DROP TYPE role_name_new;
ALTER TYPE role_name RENAME VALUE 'support_agent' TO 'support';

ALTER TABLE audit_logs
  DROP CONSTRAINT audit_logs_actor_user_id_fkey,
  ADD CONSTRAINT audit_logs_actor_user_id_fkey
    FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL;

ALTER TYPE otp_purpose RENAME VALUE 'phone_verify' TO 'registration';
