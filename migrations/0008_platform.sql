-- Up Migration
--
-- Cross-cutting platform tables: request idempotency, and notification delivery
-- for both channels.

CREATE TABLE idempotency_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Client-supplied key.
  key             text        NOT NULL,
  -- What the key is scoped to, e.g. 'bids.submit'. Keeps one client's key for
  -- one operation from colliding with an unrelated one.
  scope           text        NOT NULL,
  user_id         uuid REFERENCES users (id) ON DELETE CASCADE,
  -- Hash of the request body, so a replayed key carrying different parameters
  -- is detected rather than silently served the first response.
  request_hash    text        NOT NULL,
  state           text        NOT NULL DEFAULT 'in_progress',
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  expires_at      timestamptz NOT NULL,

  CONSTRAINT idempotency_keys_state_known
    CHECK (state IN ('in_progress', 'completed', 'failed')),
  CONSTRAINT idempotency_keys_completed_consistent
    CHECK ((state = 'in_progress') = (completed_at IS NULL)),
  CONSTRAINT idempotency_keys_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT idempotency_keys_response_status_range
    CHECK (response_status IS NULL OR response_status BETWEEN 100 AND 599)
);

CREATE UNIQUE INDEX idempotency_keys_scope_key_unique ON idempotency_keys (scope, key);
CREATE INDEX idempotency_keys_expires_at_idx ON idempotency_keys (expires_at);
CREATE INDEX idempotency_keys_user_idx ON idempotency_keys (user_id)
  WHERE user_id IS NOT NULL;

CREATE TABLE notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid                 NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  channel       notification_channel NOT NULL,
  -- Template identifier, e.g. 'auction.result.won'. The body is rendered at
  -- delivery time from payload, so wording changes do not rewrite history.
  template      text                 NOT NULL,
  payload       jsonb                NOT NULL DEFAULT '{}'::jsonb,
  status        notification_status  NOT NULL DEFAULT 'pending',
  -- Suppresses duplicates, e.g. one result notice per auction per user.
  dedupe_key    text,
  failure_reason text,
  sent_at       timestamptz,
  read_at       timestamptz,
  created_at    timestamptz          NOT NULL DEFAULT now(),

  CONSTRAINT notifications_template_not_blank CHECK (length(btrim(template)) > 0),
  CONSTRAINT notifications_sent_consistent
    CHECK (status <> 'sent' OR sent_at IS NOT NULL),
  CONSTRAINT notifications_failed_consistent
    CHECK (status <> 'failed' OR failure_reason IS NOT NULL)
);

CREATE UNIQUE INDEX notifications_dedupe_key_unique
  ON notifications (user_id, channel, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX notifications_user_created_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_pending_idx ON notifications (status, created_at)
  WHERE status = 'pending';

CREATE TABLE telegram_outbox (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id  uuid REFERENCES notifications (id) ON DELETE SET NULL,
  -- Telegram chat to deliver to. Held directly so delivery survives the user
  -- unlinking mid-flight.
  telegram_user_id bigint        NOT NULL,
  payload          jsonb         NOT NULL,
  status           outbox_status NOT NULL DEFAULT 'pending',
  attempts         integer       NOT NULL DEFAULT 0,
  max_attempts     integer       NOT NULL DEFAULT 5,
  next_attempt_at  timestamptz   NOT NULL DEFAULT now(),
  last_error       text,
  sent_at          timestamptz,
  created_at       timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT telegram_outbox_attempts_non_negative CHECK (attempts >= 0),
  CONSTRAINT telegram_outbox_attempts_within_limit CHECK (attempts <= max_attempts),
  CONSTRAINT telegram_outbox_telegram_user_id_positive CHECK (telegram_user_id > 0),
  CONSTRAINT telegram_outbox_sent_consistent
    CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);

-- The worker's claim query: due, not yet sent, oldest first.
CREATE INDEX telegram_outbox_due_idx ON telegram_outbox (next_attempt_at)
  WHERE status IN ('pending', 'failed');
CREATE INDEX telegram_outbox_notification_idx ON telegram_outbox (notification_id)
  WHERE notification_id IS NOT NULL;

CREATE TABLE notification_preferences (
  user_id    uuid                 NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  channel    notification_channel NOT NULL,
  -- Notification family, e.g. 'auction_result', 'bid_receipt', 'marketing'.
  category   text                 NOT NULL,
  enabled    boolean              NOT NULL DEFAULT true,
  updated_at timestamptz          NOT NULL DEFAULT now(),

  PRIMARY KEY (user_id, channel, category),
  CONSTRAINT notification_preferences_category_not_blank
    CHECK (length(btrim(category)) > 0)
);

CREATE TRIGGER notification_preferences_set_updated_at
  BEFORE UPDATE ON notification_preferences
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration
DROP TABLE IF EXISTS notification_preferences;
DROP TABLE IF EXISTS telegram_outbox;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS idempotency_keys;
