-- Up Migration
--
-- Additive changes the wallet module needs. The Phase 1 wallet schema is not
-- rewritten: `available_minor` remains the cached current balance and
-- `reserved_minor` remains for the holds that Phase 5 bidding will place.
--
-- The ledger integrity invariant is therefore:
--
--     SUM(wallet_entries.amount_minor) = wallets.available_minor
--                                      + wallets.reserved_minor
--
-- Through Phase 3 nothing places holds, so reserved_minor stays 0 and the
-- invariant reduces to the sum equalling available_minor.

-- --------------------------------------------------------------------------
-- Entry types.
--
-- Renames first (transaction-safe), then a type swap to add the new values —
-- ALTER TYPE ... ADD VALUE cannot be used by the transaction that adds it.
-- 'adjustment' becomes 'admin_credit' so a finance adjustment states its
-- direction in the type rather than only in the sign of the amount.
-- --------------------------------------------------------------------------
ALTER TYPE wallet_entry_type RENAME VALUE 'bid_refund' TO 'bid_fee_refund';
ALTER TYPE wallet_entry_type RENAME VALUE 'adjustment' TO 'admin_credit';
ALTER TYPE wallet_entry_type RENAME TO wallet_entry_type_old;

CREATE TYPE wallet_entry_type AS ENUM (
  -- credits (+)
  'deposit',
  'bid_fee_refund',
  'payment_refund',
  'admin_credit',
  'prize_payout',
  -- debits (-)
  'withdrawal',
  'bid_fee',
  'auction_payment',
  'admin_debit',
  'seller_payout',
  -- reservations, used from Phase 5
  'hold',
  'hold_release'
);

ALTER TABLE wallet_entries
  ALTER COLUMN entry_type TYPE wallet_entry_type
  USING entry_type::text::wallet_entry_type;

DROP TYPE wallet_entry_type_old;

-- --------------------------------------------------------------------------
-- Ledger provenance. Who caused the entry, and why, in words a human can read
-- during an investigation. Neither is derivable from the amount and type.
-- --------------------------------------------------------------------------
ALTER TABLE wallet_entries
  ADD COLUMN memo       text,
  -- The acting user: the wallet owner for their own operations, a finance
  -- operator for an adjustment, NULL when the platform acted on its own.
  ADD COLUMN created_by uuid REFERENCES users (id) ON DELETE RESTRICT,
  ADD CONSTRAINT wallet_entries_memo_not_blank
    CHECK (memo IS NULL OR length(btrim(memo)) > 0);

CREATE INDEX wallet_entries_created_by_idx ON wallet_entries (created_by)
  WHERE created_by IS NOT NULL;

COMMENT ON COLUMN wallet_entries.created_by IS
  'The user who caused this entry. NULL when the platform acted autonomously.';

-- --------------------------------------------------------------------------
-- Ledger order.
--
-- `created_at` defaults to now(), which in PostgreSQL is the *transaction
-- start* time. Two concurrent movements can therefore carry timestamps in the
-- opposite order from the order their balances were actually computed in, so a
-- replay ordered by created_at disagrees with the balance_after values that a
-- correctly serialised ledger recorded. (This was not theoretical: the
-- concurrency suite reproduced it.)
--
-- `seq` is the wallet's own movement counter, assigned under the wallet row
-- lock as `wallets.version + 1`. Because the lock serialises the whole
-- read-compute-write sequence, seq is exactly the order the balances were
-- computed in — and being gap-free, a missing number is itself detectable.
-- The ledger's order is therefore a fact it records, not an inference from a
-- clock.
-- --------------------------------------------------------------------------
ALTER TABLE wallet_entries ADD COLUMN seq bigint;

-- Backfill any rows that predate the column, in their recorded order.
UPDATE wallet_entries AS e
SET seq = ordered.position
FROM (
  SELECT id, row_number() OVER (PARTITION BY wallet_id ORDER BY created_at, id) AS position
  FROM wallet_entries
) AS ordered
WHERE e.id = ordered.id;

ALTER TABLE wallet_entries
  ALTER COLUMN seq SET NOT NULL,
  ADD CONSTRAINT wallet_entries_seq_positive CHECK (seq > 0);

-- Two entries cannot claim the same position, so a lost or duplicated movement
-- cannot hide inside a plausible-looking ledger.
CREATE UNIQUE INDEX wallet_entries_wallet_seq_unique ON wallet_entries (wallet_id, seq);

COMMENT ON COLUMN wallet_entries.seq IS
  'Per-wallet movement number, assigned under the wallet row lock. Gap-free; the ledger''s authoritative order.';

-- --------------------------------------------------------------------------
-- Wallet freeze: a financial control, distinct from account suspension.
--
-- A frozen wallet cannot be debited. Suspending an account is an
-- authentication decision and stops sign-in; freezing a wallet stops money
-- leaving while the owner keeps full access to everything else. Conflating the
-- two would mean fraud review had to lock people out of their own history.
-- --------------------------------------------------------------------------
ALTER TABLE wallets
  ADD COLUMN frozen_at     timestamptz,
  ADD COLUMN frozen_reason text,
  ADD COLUMN frozen_by     uuid REFERENCES users (id) ON DELETE RESTRICT,
  -- A freeze must always carry its reason: an unexplained freeze on someone's
  -- money is not something anyone should be able to leave behind.
  ADD CONSTRAINT wallets_freeze_consistent
    CHECK ((frozen_at IS NULL) = (frozen_reason IS NULL)),
  ADD CONSTRAINT wallets_frozen_reason_not_blank
    CHECK (frozen_reason IS NULL OR length(btrim(frozen_reason)) > 0);

CREATE INDEX wallets_frozen_idx ON wallets (frozen_at) WHERE frozen_at IS NOT NULL;
-- Answers "what did this operator freeze" during a review of their actions.
CREATE INDEX wallets_frozen_by_idx ON wallets (frozen_by) WHERE frozen_by IS NOT NULL;

COMMENT ON COLUMN wallets.frozen_at IS
  'Set while the wallet is frozen. Blocks debits only; credits and reads continue.';
COMMENT ON COLUMN wallets.available_minor IS
  'Cached spendable balance in BIGINT minor units. wallet_entries is the truth.';

-- Down Migration
DROP INDEX IF EXISTS wallets_frozen_by_idx;
DROP INDEX IF EXISTS wallets_frozen_idx;
ALTER TABLE wallets
  DROP CONSTRAINT IF EXISTS wallets_frozen_reason_not_blank,
  DROP CONSTRAINT IF EXISTS wallets_freeze_consistent,
  DROP COLUMN IF EXISTS frozen_by,
  DROP COLUMN IF EXISTS frozen_reason,
  DROP COLUMN IF EXISTS frozen_at;

DROP INDEX IF EXISTS wallet_entries_wallet_seq_unique;
DROP INDEX IF EXISTS wallet_entries_created_by_idx;
ALTER TABLE wallet_entries
  DROP CONSTRAINT IF EXISTS wallet_entries_seq_positive,
  DROP CONSTRAINT IF EXISTS wallet_entries_memo_not_blank,
  DROP COLUMN IF EXISTS seq,
  DROP COLUMN IF EXISTS created_by,
  DROP COLUMN IF EXISTS memo;

ALTER TYPE wallet_entry_type RENAME TO wallet_entry_type_new;
CREATE TYPE wallet_entry_type AS ENUM (
  'deposit', 'withdrawal', 'bid_fee', 'bid_fee_refund',
  'prize_payout', 'seller_payout', 'admin_credit', 'hold', 'hold_release'
);
ALTER TABLE wallet_entries
  ALTER COLUMN entry_type TYPE wallet_entry_type
  USING entry_type::text::wallet_entry_type;
DROP TYPE wallet_entry_type_new;
ALTER TYPE wallet_entry_type RENAME VALUE 'admin_credit' TO 'adjustment';
ALTER TYPE wallet_entry_type RENAME VALUE 'bid_fee_refund' TO 'bid_refund';
