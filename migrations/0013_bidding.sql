-- Up Migration
--
-- Bidding-engine support. Additive: the Phase 1 `bids` and
-- `auction_participants` tables stand, and no migration history is rewound.
--
-- Three things the bidding engine needs that Phase 1 did not provide:
--
--   1. Live counters on `auctions`. Phase 1 put `total_bids` and
--      `total_participants` on `auction_results`, which is the *final* record
--      written when an auction is settled. A live auction page needs the same
--      two numbers while bidding is open, and they have to be transactional:
--      computed from events after the fact they could disagree with the bids
--      actually committed.
--   2. Fraud evidence on `bids` — the request, address and device a bid
--      arrived from.
--   3. An idempotency index that permits a batch. See below.

-- --------------------------------------------------------------------------
-- Live auction counters.
--
-- Maintained inside the bid transaction, so they can never count a bid that
-- rolled back. `auction_results` keeps its own copies: those are the frozen
-- figures the result was computed from, and Phase 6 writes them once.
--
-- Deliberately not a trigger on `bids`. A statement-level trigger would make
-- the counters a side effect of any insert, including a future backfill or
-- repair, and the engine already holds the auction row locked at the point it
-- updates them — which is what makes two concurrent bidders serialise here.
-- --------------------------------------------------------------------------
ALTER TABLE auctions
  ADD COLUMN total_bids         integer NOT NULL DEFAULT 0,
  ADD COLUMN total_participants integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT auctions_total_bids_non_negative CHECK (total_bids >= 0),
  ADD CONSTRAINT auctions_total_participants_non_negative CHECK (total_participants >= 0),
  -- A bid belongs to a participant, so there can never be more participants
  -- than bids. Cheap, and it catches a counter updated in only one place.
  ADD CONSTRAINT auctions_participants_within_bids CHECK (total_participants <= total_bids);

COMMENT ON COLUMN auctions.total_bids IS
  'Valid bids placed so far. Maintained transactionally by the bidding engine under the auction row lock.';
COMMENT ON COLUMN auctions.total_participants IS
  'Distinct users who have bid. Incremented once, when a user places their first bid in this auction.';

-- The auction immutability trigger guards the *terms* (fees, range, deadlines)
-- once an auction is live. It names the columns it protects one by one, so
-- these two counters are mutable while live without any change to it — which
-- is the intent: a counter is not a term.

-- --------------------------------------------------------------------------
-- Fraud evidence on a bid.
--
-- Preserved for later analysis, never used to decide anything: Phase 6's
-- winner algorithm must reach the same answer whatever channel or address a
-- bid came from. `inet` rather than text so an address is stored as an
-- address; `ip_address` is nullable because a bid placed by an operator on
-- someone's behalf has no meaningful client address.
-- --------------------------------------------------------------------------
ALTER TABLE bids
  ADD COLUMN request_id  uuid,
  ADD COLUMN ip_address  inet,
  ADD COLUMN device_hash text,
  ADD CONSTRAINT bids_device_hash_shape
    CHECK (device_hash IS NULL OR char_length(device_hash) BETWEEN 16 AND 128);

COMMENT ON COLUMN bids.request_id IS
  'The request that submitted this bid. Every bid in one batch carries the same value.';
COMMENT ON COLUMN bids.device_hash IS
  'Opaque client fingerprint for fraud analysis. Never a raw device identifier, and never used by the result algorithm.';

-- Finding one batch, and finding every bid from one device, are both
-- fraud-review queries. Partial on NOT NULL: most rows will carry a request id
-- but an operator-placed bid need not.
CREATE INDEX bids_request_idx ON bids (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX bids_device_idx ON bids (device_hash) WHERE device_hash IS NOT NULL;

-- --------------------------------------------------------------------------
-- The idempotency index, corrected for batches.
--
-- Phase 1 wrote:
--
--   UNIQUE (auction_id, user_id, idempotency_key) WHERE idempotency_key IS NOT NULL
--
-- which allows exactly one bid row per key. That is right for one bid per
-- request and wrong for the engine actually being built: a batch of seven
-- amounts is one request, carrying one `Idempotency-Key`, and it inserts seven
-- rows. Under the old index the second row of every batch would fail.
--
-- Replaced by the same guarantee at the granularity a batch has: one key may
-- not produce the same amount twice. Request-level replay — returning the
-- original response to a retry rather than re-charging — is enforced by the
-- `idempotency_keys` table, which is where a *request's* identity belongs;
-- this index is the row-level backstop underneath it.
--
-- Note this is not redundant with `bids_valid_amount_unique_key`. That one is
-- partial on `status = 'valid'`, so a voided bid frees its amount for a
-- legitimate re-bid; this one covers every status, so a retried request cannot
-- resurrect an amount that was voided in between.
-- --------------------------------------------------------------------------
DROP INDEX bids_idempotency_key_unique;

CREATE UNIQUE INDEX bids_idempotency_amount_unique
  ON bids (auction_id, user_id, idempotency_key, amount_minor)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON INDEX bids_idempotency_amount_unique IS
  'One idempotency key may not produce the same amount twice. Batch-safe: one key covers every amount in its batch.';

-- --------------------------------------------------------------------------
-- The bid immutability trigger, extended over the new evidence columns.
--
-- A bid's terms were already immutable. Where it came from is evidence too: if
-- the address or device on a bid could be edited afterwards, fraud review
-- would be reading a story rather than a record.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_bid_immutability() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.auction_id   IS DISTINCT FROM OLD.auction_id
     OR NEW.user_id      IS DISTINCT FROM OLD.user_id
     OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
     OR NEW.fee_minor    IS DISTINCT FROM OLD.fee_minor
     OR NEW.channel      IS DISTINCT FROM OLD.channel
     OR NEW.created_at   IS DISTINCT FROM OLD.created_at
     OR NEW.request_id   IS DISTINCT FROM OLD.request_id
     OR NEW.ip_address   IS DISTINCT FROM OLD.ip_address
     OR NEW.device_hash  IS DISTINCT FROM OLD.device_hash
  THEN
    RAISE EXCEPTION 'bid % is immutable; only its status may change', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- --------------------------------------------------------------------------
-- Participant lookup under the bid limit.
--
-- The engine reads one participant row per request, by (auction_id, user_id),
-- and locks it. `auction_participants_unique_key` already serves that exactly,
-- so no index is added here — the limit check is a primary-key-shaped lookup,
-- never a COUNT over `bids`.
-- --------------------------------------------------------------------------

-- Down Migration

DROP INDEX IF EXISTS bids_device_idx;
DROP INDEX IF EXISTS bids_request_idx;
DROP INDEX IF EXISTS bids_idempotency_amount_unique;

CREATE UNIQUE INDEX bids_idempotency_key_unique
  ON bids (auction_id, user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE OR REPLACE FUNCTION enforce_bid_immutability() RETURNS trigger
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

ALTER TABLE bids
  DROP CONSTRAINT bids_device_hash_shape,
  DROP COLUMN device_hash,
  DROP COLUMN ip_address,
  DROP COLUMN request_id;

ALTER TABLE auctions
  DROP CONSTRAINT auctions_participants_within_bids,
  DROP CONSTRAINT auctions_total_participants_non_negative,
  DROP CONSTRAINT auctions_total_bids_non_negative,
  DROP COLUMN total_participants,
  DROP COLUMN total_bids;
