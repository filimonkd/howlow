-- Up Migration
--
-- Telegram is a client channel, not a second identity system. These tables map
-- a Telegram account onto an existing HOWLOW user and nothing more: no wallet,
-- no bids, no auction state lives here.

CREATE TABLE telegram_accounts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One HOWLOW user has at most one linked Telegram account in the MVP.
  user_id          uuid   NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Telegram ids exceed int32, so BIGINT. This is the identity; username is not.
  telegram_user_id bigint NOT NULL,
  -- Display information only. Usernames are re-assignable by Telegram and must
  -- never be used to identify a user.
  username         text,
  first_name       text,
  last_name        text,
  language_code    text,
  is_bot           boolean NOT NULL DEFAULT false,
  linked_at        timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT telegram_accounts_telegram_user_id_positive CHECK (telegram_user_id > 0),
  CONSTRAINT telegram_accounts_not_a_bot CHECK (is_bot = false)
);

CREATE UNIQUE INDEX telegram_accounts_user_id_key ON telegram_accounts (user_id);
CREATE UNIQUE INDEX telegram_accounts_telegram_user_id_key
  ON telegram_accounts (telegram_user_id);
CREATE INDEX telegram_accounts_username_idx ON telegram_accounts (lower(username))
  WHERE username IS NOT NULL;

CREATE TRIGGER telegram_accounts_set_updated_at BEFORE UPDATE ON telegram_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON COLUMN telegram_accounts.username IS
  'Display only. Telegram usernames are re-assignable and are never identity.';

CREATE TABLE telegram_link_tokens (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Only the hash of the token is stored. The raw token exists once, in the
  -- link the user is shown, and is never recoverable from the database.
  token_hash                   text NOT NULL,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  expires_at                   timestamptz NOT NULL,
  consumed_at                  timestamptz,
  consumed_by_telegram_user_id bigint,
  created_channel              channel NOT NULL DEFAULT 'web',

  CONSTRAINT telegram_link_tokens_expiry_after_creation CHECK (expires_at > created_at),
  -- Single use: a consumed token records who consumed it, and both facts are set
  -- together or not at all.
  CONSTRAINT telegram_link_tokens_consumption_consistent
    CHECK ((consumed_at IS NULL) = (consumed_by_telegram_user_id IS NULL))
);

CREATE UNIQUE INDEX telegram_link_tokens_token_hash_key ON telegram_link_tokens (token_hash);
-- At most one live token per user, so an old link cannot be replayed after a
-- new one is issued.
CREATE UNIQUE INDEX telegram_link_tokens_live_key ON telegram_link_tokens (user_id)
  WHERE consumed_at IS NULL;
CREATE INDEX telegram_link_tokens_expires_at_idx ON telegram_link_tokens (expires_at);

COMMENT ON COLUMN telegram_link_tokens.token_hash IS
  'Hash of the link token. The raw token is never stored.';

-- Down Migration
DROP TABLE IF EXISTS telegram_link_tokens;
DROP TABLE IF EXISTS telegram_accounts;
