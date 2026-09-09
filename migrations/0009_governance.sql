-- Up Migration
--
-- Audit and fraud review. Financial operations must be auditable, which means
-- the audit trail itself cannot be edited by the code it is auditing.

CREATE TABLE audit_logs (
  -- BIGINT identity rather than uuid: the audit trail is read in order, and a
  -- monotonic key makes that ordering unambiguous and the index compact.
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  actor_channel  channel NOT NULL DEFAULT 'system',
  -- What happened, e.g. 'auction.closed', 'wallet.credited'.
  action         text    NOT NULL,
  entity_type    text    NOT NULL,
  -- Text rather than uuid so any entity can be referenced, including ones keyed
  -- by something other than a uuid.
  entity_id      text,
  before_data    jsonb,
  after_data     jsonb,
  ip_address     inet,
  user_agent     text,
  request_id     text,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT audit_logs_action_not_blank CHECK (length(btrim(action)) > 0),
  CONSTRAINT audit_logs_entity_type_not_blank CHECK (length(btrim(entity_type)) > 0)
);

CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id, created_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_user_id, created_at DESC)
  WHERE actor_user_id IS NOT NULL;
CREATE INDEX audit_logs_action_idx ON audit_logs (action, created_at DESC);
CREATE INDEX audit_logs_request_idx ON audit_logs (request_id) WHERE request_id IS NOT NULL;

-- An audit trail that can be rewritten is not an audit trail.
CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

COMMENT ON TABLE audit_logs IS
  'Append-only. Neither the application nor an operator may edit or delete rows.';

CREATE TABLE fraud_flags (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users (id) ON DELETE CASCADE,
  auction_id  uuid REFERENCES auctions (id) ON DELETE CASCADE,
  bid_id      uuid REFERENCES bids (id) ON DELETE CASCADE,
  -- Which detection rule fired, e.g. 'velocity.bids_per_minute'.
  rule_code   text                NOT NULL,
  severity    fraud_flag_severity NOT NULL DEFAULT 'low',
  status      fraud_flag_status   NOT NULL DEFAULT 'open',
  details     jsonb               NOT NULL DEFAULT '{}'::jsonb,
  raised_at   timestamptz         NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users (id) ON DELETE SET NULL,
  resolution_note text,
  created_at  timestamptz         NOT NULL DEFAULT now(),
  updated_at  timestamptz         NOT NULL DEFAULT now(),

  CONSTRAINT fraud_flags_rule_code_not_blank CHECK (length(btrim(rule_code)) > 0),
  -- A flag must point at something.
  CONSTRAINT fraud_flags_has_subject
    CHECK (num_nonnulls(user_id, auction_id, bid_id) > 0),
  -- Resolved states carry a resolution time; open ones do not.
  CONSTRAINT fraud_flags_resolution_consistent
    CHECK ((status IN ('confirmed', 'dismissed')) = (resolved_at IS NOT NULL))
);

CREATE INDEX fraud_flags_open_idx ON fraud_flags (severity, raised_at DESC)
  WHERE status IN ('open', 'reviewing');
CREATE INDEX fraud_flags_user_idx ON fraud_flags (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX fraud_flags_auction_idx ON fraud_flags (auction_id) WHERE auction_id IS NOT NULL;
CREATE INDEX fraud_flags_rule_idx ON fraud_flags (rule_code, raised_at DESC);
CREATE INDEX fraud_flags_bid_idx ON fraud_flags (bid_id) WHERE bid_id IS NOT NULL;
CREATE INDEX fraud_flags_resolved_by_idx ON fraud_flags (resolved_by)
  WHERE resolved_by IS NOT NULL;

CREATE TRIGGER fraud_flags_set_updated_at BEFORE UPDATE ON fraud_flags
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration
DROP TABLE IF EXISTS fraud_flags;
DROP TABLE IF EXISTS audit_logs;
