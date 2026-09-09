-- Up Migration
--
-- The auction core. Both channels write here through the same service; the
-- rules that protect an auction's integrity are database constraints, not
-- application conventions, because a concurrent request can outrun any
-- application-level check.

CREATE TABLE auctions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id          uuid          NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  seller_id           uuid          NOT NULL REFERENCES sellers (id) ON DELETE RESTRICT,
  title               text          NOT NULL,
  description         text,
  currency            currency_code NOT NULL DEFAULT 'ETB',

  -- Every amount below is BIGINT minor units.
  bid_fee_minor       bigint        NOT NULL,
  min_bid_minor       bigint        NOT NULL,
  max_bid_minor       bigint        NOT NULL,
  bid_increment_minor bigint        NOT NULL DEFAULT 1,
  max_bids_per_user   integer       NOT NULL,

  starts_at           timestamptz   NOT NULL,
  ends_at             timestamptz   NOT NULL,
  status              auction_status NOT NULL DEFAULT 'draft',
  -- There is exactly one result algorithm. Pinning it here means a stored
  -- auction can never claim to have been decided by anything else.
  algorithm_version   text          NOT NULL DEFAULT 'LUB_V1',
  closed_at           timestamptz,
  cancelled_at        timestamptz,
  cancel_reason       text,
  created_at          timestamptz   NOT NULL DEFAULT now(),
  updated_at          timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT auctions_title_not_blank CHECK (length(btrim(title)) > 0),
  CONSTRAINT auctions_algorithm_is_lub_v1 CHECK (algorithm_version = 'LUB_V1'),
  CONSTRAINT auctions_bid_fee_positive CHECK (bid_fee_minor > 0),
  CONSTRAINT auctions_min_bid_positive CHECK (min_bid_minor > 0),
  CONSTRAINT auctions_bid_increment_positive CHECK (bid_increment_minor > 0),
  CONSTRAINT auctions_max_bids_per_user_positive CHECK (max_bids_per_user > 0),
  -- Invalid bid range.
  CONSTRAINT auctions_bid_range_ordered CHECK (max_bid_minor >= min_bid_minor),
  -- Invalid auction time range.
  CONSTRAINT auctions_time_range_ordered CHECK (ends_at > starts_at),
  CONSTRAINT auctions_closed_at_when_closed
    CHECK (status NOT IN ('closed', 'settled') OR closed_at IS NOT NULL),
  CONSTRAINT auctions_cancelled_consistent
    CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);

CREATE INDEX auctions_status_ends_at_idx ON auctions (status, ends_at);
CREATE INDEX auctions_product_idx ON auctions (product_id);
CREATE INDEX auctions_seller_idx ON auctions (seller_id);
-- The worker's closing sweep: auctions that are live and past their deadline.
CREATE INDEX auctions_due_to_close_idx ON auctions (ends_at)
  WHERE status IN ('live', 'closing');

CREATE TRIGGER auctions_set_updated_at BEFORE UPDATE ON auctions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Once an auction has closed, the terms it was decided under are historical
-- fact. Re-pricing or re-timing a finished auction would silently rewrite the
-- basis of a financial outcome, so the database refuses.
CREATE FUNCTION enforce_auction_immutability() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('closed', 'settled', 'cancelled') THEN
    IF NEW.product_id          IS DISTINCT FROM OLD.product_id
       OR NEW.currency            IS DISTINCT FROM OLD.currency
       OR NEW.bid_fee_minor       IS DISTINCT FROM OLD.bid_fee_minor
       OR NEW.min_bid_minor       IS DISTINCT FROM OLD.min_bid_minor
       OR NEW.max_bid_minor       IS DISTINCT FROM OLD.max_bid_minor
       OR NEW.bid_increment_minor IS DISTINCT FROM OLD.bid_increment_minor
       OR NEW.max_bids_per_user   IS DISTINCT FROM OLD.max_bids_per_user
       OR NEW.starts_at           IS DISTINCT FROM OLD.starts_at
       OR NEW.ends_at             IS DISTINCT FROM OLD.ends_at
       OR NEW.algorithm_version   IS DISTINCT FROM OLD.algorithm_version
    THEN
      RAISE EXCEPTION
        'auction % is % and its terms are immutable', OLD.id, OLD.status
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  -- A settled auction is final; it cannot be reopened to a live state.
  IF OLD.status = 'settled' AND NEW.status <> 'settled' THEN
    RAISE EXCEPTION 'auction % is settled and cannot change status', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER auctions_enforce_immutability BEFORE UPDATE ON auctions
  FOR EACH ROW EXECUTE FUNCTION enforce_auction_immutability();

CREATE TABLE auction_participants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id       uuid    NOT NULL REFERENCES auctions (id) ON DELETE CASCADE,
  user_id          uuid    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  bid_count        integer NOT NULL DEFAULT 0,
  total_fees_minor bigint  NOT NULL DEFAULT 0,
  first_bid_at     timestamptz,
  last_bid_at      timestamptz,
  -- Which channel this user first joined through. Metadata only.
  joined_channel   channel NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT auction_participants_bid_count_non_negative CHECK (bid_count >= 0),
  CONSTRAINT auction_participants_fees_non_negative CHECK (total_fees_minor >= 0),
  CONSTRAINT auction_participants_bid_times_ordered
    CHECK (last_bid_at IS NULL OR first_bid_at IS NOT NULL)
);

CREATE UNIQUE INDEX auction_participants_unique_key
  ON auction_participants (auction_id, user_id);
CREATE INDEX auction_participants_user_idx ON auction_participants (user_id);

CREATE TRIGGER auction_participants_set_updated_at BEFORE UPDATE ON auction_participants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE bids (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id      uuid       NOT NULL REFERENCES auctions (id) ON DELETE RESTRICT,
  user_id         uuid       NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  -- BIGINT minor units. The bid amount, not the fee.
  amount_minor    bigint     NOT NULL,
  fee_minor       bigint     NOT NULL,
  status          bid_status NOT NULL DEFAULT 'valid',
  -- Which channel the bid arrived through. Telegram bids and web bids are the
  -- same kind of row and enter the same engine; this column is for audit only.
  channel         channel    NOT NULL,
  -- Client-supplied key making submission replay-safe.
  idempotency_key text,
  wallet_entry_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  voided_at       timestamptz,
  void_reason     text,

  CONSTRAINT bids_amount_positive CHECK (amount_minor > 0),
  CONSTRAINT bids_fee_non_negative CHECK (fee_minor >= 0),
  CONSTRAINT bids_void_consistent
    CHECK ((status = 'valid') = (voided_at IS NULL))
);

-- THE duplicate-bid rule. A user may never hold two valid bids at the same
-- amount in the same auction. Enforced by PostgreSQL, so two concurrent
-- requests cannot both pass an application-level check and both insert.
-- Partial, so voiding a bid frees the amount for a legitimate re-bid.
CREATE UNIQUE INDEX bids_valid_amount_unique_key
  ON bids (auction_id, user_id, amount_minor)
  WHERE status = 'valid';

-- Bid submission is idempotent: the same key from the same user on the same
-- auction can only ever produce one row.
CREATE UNIQUE INDEX bids_idempotency_key_unique
  ON bids (auction_id, user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Drives LUB_V1: group valid bids of an auction by amount and take the lowest
-- with exactly one bidder.
CREATE INDEX bids_auction_amount_idx ON bids (auction_id, amount_minor)
  WHERE status = 'valid';
CREATE INDEX bids_auction_user_idx ON bids (auction_id, user_id);
CREATE INDEX bids_user_created_idx ON bids (user_id, created_at DESC);

COMMENT ON INDEX bids_valid_amount_unique_key IS
  'Duplicate-bid rule: one valid bid per (auction, user, amount). Database-enforced.';

-- A bid's terms are evidence of what a user committed to. Status may move
-- valid -> void/refunded, but what was bid, by whom, for how much, and when
-- cannot be edited afterwards.
CREATE FUNCTION enforce_bid_immutability() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.auction_id   IS DISTINCT FROM OLD.auction_id
     OR NEW.user_id      IS DISTINCT FROM OLD.user_id
     OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
     OR NEW.fee_minor    IS DISTINCT FROM OLD.fee_minor
     OR NEW.channel      IS DISTINCT FROM OLD.channel
     OR NEW.created_at   IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'bid % is immutable; only its status may change', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER bids_enforce_immutability BEFORE UPDATE ON bids
  FOR EACH ROW EXECUTE FUNCTION enforce_bid_immutability();

CREATE TABLE auction_results (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Exactly one result per auction, ever.
  auction_id           uuid   NOT NULL REFERENCES auctions (id) ON DELETE RESTRICT,
  algorithm_version    text   NOT NULL DEFAULT 'LUB_V1',
  winning_bid_id       uuid REFERENCES bids (id) ON DELETE RESTRICT,
  winner_user_id       uuid REFERENCES users (id) ON DELETE RESTRICT,
  winning_amount_minor bigint,
  total_bids           integer NOT NULL,
  total_valid_bids     integer NOT NULL,
  unique_amount_count  integer NOT NULL,
  participant_count    integer NOT NULL,
  -- Digest of the frozen valid-bid set the result was computed from, so a
  -- result can be re-verified against the bids that produced it.
  frozen_bid_checksum  text    NOT NULL,
  computed_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT auction_results_algorithm_is_lub_v1 CHECK (algorithm_version = 'LUB_V1'),
  CONSTRAINT auction_results_counts_non_negative
    CHECK (total_bids >= 0 AND total_valid_bids >= 0
           AND unique_amount_count >= 0 AND participant_count >= 0),
  CONSTRAINT auction_results_valid_within_total CHECK (total_valid_bids <= total_bids),
  CONSTRAINT auction_results_unique_within_valid CHECK (unique_amount_count <= total_valid_bids),
  CONSTRAINT auction_results_winning_amount_positive
    CHECK (winning_amount_minor IS NULL OR winning_amount_minor > 0),
  -- A winner is all three facts together, or none of them: an auction with no
  -- unique bid has no winner at all.
  CONSTRAINT auction_results_winner_complete
    CHECK (num_nonnulls(winning_bid_id, winner_user_id, winning_amount_minor) IN (0, 3))
);

CREATE UNIQUE INDEX auction_results_auction_id_key ON auction_results (auction_id);
CREATE INDEX auction_results_winner_idx ON auction_results (winner_user_id)
  WHERE winner_user_id IS NOT NULL;
CREATE INDEX auction_results_winning_bid_idx ON auction_results (winning_bid_id)
  WHERE winning_bid_id IS NOT NULL;

-- Completed auction results are immutable. Written once by the worker, then
-- read forever.
CREATE TRIGGER auction_results_append_only
  BEFORE UPDATE OR DELETE ON auction_results
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

COMMENT ON TABLE auction_results IS
  'One immutable row per auction, produced by the single LUB_V1 implementation.';

-- Down Migration
DROP TABLE IF EXISTS auction_results;
DROP TRIGGER IF EXISTS bids_enforce_immutability ON bids;
DROP FUNCTION IF EXISTS enforce_bid_immutability();
DROP TABLE IF EXISTS bids;
DROP TABLE IF EXISTS auction_participants;
DROP TRIGGER IF EXISTS auctions_enforce_immutability ON auctions;
DROP FUNCTION IF EXISTS enforce_auction_immutability();
DROP TABLE IF EXISTS auctions;
