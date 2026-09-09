-- Up Migration
--
-- ONE wallet ledger for the whole platform. Telegram does not have its own
-- wallet; balances are channel-independent.
--
-- `wallets` holds the current balance, `wallet_entries` the append-only history
-- that produced it. The balance is a cache of the ledger, and the ledger is the
-- truth: every entry records the balance it resulted in, so the two can be
-- reconciled and any divergence detected.

CREATE TABLE wallets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid          NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  currency        currency_code NOT NULL DEFAULT 'ETB',
  -- Spendable balance, BIGINT minor units.
  available_minor bigint        NOT NULL DEFAULT 0,
  -- Held against in-flight operations (a placed bid, a pending withdrawal).
  reserved_minor  bigint        NOT NULL DEFAULT 0,
  -- Bumped on every mutation so callers can detect a concurrent write.
  version         bigint        NOT NULL DEFAULT 0,
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now(),

  -- A wallet can never go negative. This is the last line of defence behind
  -- every future wallet operation.
  CONSTRAINT wallets_available_non_negative CHECK (available_minor >= 0),
  CONSTRAINT wallets_reserved_non_negative CHECK (reserved_minor >= 0),
  CONSTRAINT wallets_version_non_negative CHECK (version >= 0)
);

-- One wallet per user per currency.
CREATE UNIQUE INDEX wallets_user_currency_key ON wallets (user_id, currency);

CREATE TRIGGER wallets_set_updated_at BEFORE UPDATE ON wallets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE wallets IS
  'Current balance per user and currency. Derived from wallet_entries, which is the truth.';

CREATE TABLE wallet_entries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id           uuid              NOT NULL REFERENCES wallets (id) ON DELETE RESTRICT,
  -- Denormalised so the ledger can be audited per user without a join.
  user_id             uuid              NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  entry_type          wallet_entry_type NOT NULL,
  currency            currency_code     NOT NULL,
  -- Signed BIGINT minor units: positive credits the wallet, negative debits it.
  -- A single signed column removes any chance of a direction flag and an amount
  -- disagreeing.
  amount_minor        bigint            NOT NULL,
  -- The available balance immediately after this entry was applied. Makes the
  -- ledger self-checking: replaying entries must reproduce these values.
  balance_after_minor bigint            NOT NULL,
  -- What this entry was for, e.g. ('bid', <bid id>) or ('payment', <payment id>).
  reference_type      text,
  reference_id        uuid,
  idempotency_key     text,
  created_channel     channel           NOT NULL DEFAULT 'system',
  metadata            jsonb             NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz       NOT NULL DEFAULT now(),

  -- A zero-value ledger entry records nothing and must not exist.
  CONSTRAINT wallet_entries_amount_non_zero CHECK (amount_minor <> 0),
  CONSTRAINT wallet_entries_balance_non_negative CHECK (balance_after_minor >= 0),
  CONSTRAINT wallet_entries_reference_complete
    CHECK ((reference_type IS NULL) = (reference_id IS NULL))
);

-- Replaying the same credit or debit must never double it.
CREATE UNIQUE INDEX wallet_entries_idempotency_key_unique
  ON wallet_entries (wallet_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX wallet_entries_wallet_created_idx
  ON wallet_entries (wallet_id, created_at DESC, id DESC);
CREATE INDEX wallet_entries_user_created_idx
  ON wallet_entries (user_id, created_at DESC);
CREATE INDEX wallet_entries_reference_idx ON wallet_entries (reference_type, reference_id)
  WHERE reference_type IS NOT NULL;
CREATE INDEX wallet_entries_type_idx ON wallet_entries (entry_type);

-- The ledger is append-only. Correcting a mistake means writing a compensating
-- entry, never editing history.
CREATE TRIGGER wallet_entries_append_only
  BEFORE UPDATE OR DELETE ON wallet_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

COMMENT ON TABLE wallet_entries IS
  'Append-only money ledger. Corrections are compensating entries, never edits.';
COMMENT ON COLUMN wallet_entries.amount_minor IS
  'Signed BIGINT minor units: positive credits, negative debits. Never a float.';

-- Down Migration
DROP TABLE IF EXISTS wallet_entries;
DROP TABLE IF EXISTS wallets;
