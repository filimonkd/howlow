-- Up Migration
--
-- Catalog and auction-lifecycle support. Additive: the Phase 1 tables are not
-- rewritten, and no migration history is rewound.

-- --------------------------------------------------------------------------
-- Auction lifecycle states.
--
-- Phase 1 declared 'draft, scheduled, live, closing, closed, settled,
-- cancelled'. The lifecycle the platform actually runs adds an approval step
-- before scheduling, a distinct result-calculation state, and an operational
-- suspend, so the enum is brought in line with it:
--
--   draft → pending_approval → scheduled → live → closing → calculating
--         → completed
--   plus cancelled and suspended
--
-- 'closed' becomes 'calculating' (bidding is over, the result is not yet
-- computed) and 'settled' becomes 'completed' (the result is final). Renames
-- rather than new values, so any existing row keeps its meaning.
-- --------------------------------------------------------------------------
ALTER TYPE auction_status RENAME VALUE 'closed' TO 'calculating';
ALTER TYPE auction_status RENAME VALUE 'settled' TO 'completed';

-- CHECK constraints and partial indexes bind their literals to the type they
-- were created against, so every dependent has to be dropped before the swap
-- and rebuilt after it. Leaving one in place fails with
-- "operator does not exist: auction_status = auction_status_old".
ALTER TABLE auctions
  DROP CONSTRAINT auctions_closed_at_when_closed,
  DROP CONSTRAINT auctions_cancelled_consistent;
DROP INDEX auctions_due_to_close_idx;

ALTER TYPE auction_status RENAME TO auction_status_old;

CREATE TYPE auction_status AS ENUM (
  'draft',
  'pending_approval',
  'scheduled',
  'live',
  'closing',
  'calculating',
  'completed',
  'cancelled',
  'suspended'
);

ALTER TABLE auctions
  ALTER COLUMN status DROP DEFAULT,
  ALTER COLUMN status TYPE auction_status USING status::text::auction_status,
  ALTER COLUMN status SET DEFAULT 'draft';

DROP TYPE auction_status_old;

ALTER TABLE auctions
  ADD CONSTRAINT auctions_cancelled_consistent
    CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL));

-- The closing sweep: auctions still accepting or finishing bids.
CREATE INDEX auctions_due_to_close_idx ON auctions (ends_at)
  WHERE status IN ('live', 'closing');

-- --------------------------------------------------------------------------
-- Product condition. Part of what a bidder is deciding on, so it is a
-- constrained value rather than free text a seller can phrase persuasively.
-- --------------------------------------------------------------------------
CREATE TYPE product_condition AS ENUM (
  'new',
  'refurbished',
  'used_like_new',
  'used_good',
  'used_fair'
);

-- --------------------------------------------------------------------------
-- Product detail.
-- --------------------------------------------------------------------------
ALTER TABLE products
  ADD COLUMN sku       text,
  ADD COLUMN brand     text,
  ADD COLUMN condition product_condition NOT NULL DEFAULT 'new',
  -- Free-form key/value specifications. Display metadata only: no rule reads it.
  ADD COLUMN specs     jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Units held by live auctions. See inventory_reservations below.
  ADD COLUMN reserved_quantity integer NOT NULL DEFAULT 0,

  ADD CONSTRAINT products_sku_not_blank
    CHECK (sku IS NULL OR length(btrim(sku)) > 0),
  ADD CONSTRAINT products_brand_not_blank
    CHECK (brand IS NULL OR length(btrim(brand)) > 0),
  ADD CONSTRAINT products_specs_is_object
    CHECK (jsonb_typeof(specs) = 'object'),
  ADD CONSTRAINT products_reserved_non_negative CHECK (reserved_quantity >= 0),
  -- The overselling rule. Reserved units can never exceed the units that
  -- exist, whatever the application believes it is doing.
  ADD CONSTRAINT products_reserved_within_stock
    CHECK (reserved_quantity <= stock_quantity);

-- Unique per seller, not globally: two sellers may legitimately use the same
-- internal code for their own goods.
CREATE UNIQUE INDEX products_seller_sku_key ON products (seller_id, sku)
  WHERE sku IS NOT NULL;

-- Seller and admin product lists filter by status within an owner.
CREATE INDEX products_seller_status_idx ON products (seller_id, status);
-- Category browsing filters by status within a category.
CREATE INDEX products_category_status_idx ON products (category_id, status)
  WHERE category_id IS NOT NULL;

COMMENT ON COLUMN products.reserved_quantity IS
  'Units held by live auctions. Cached; inventory_reservations is the record.';

-- --------------------------------------------------------------------------
-- Auction configuration and approval bookkeeping.
--
-- Column names follow the existing schema: `bid_fee_minor` is the
-- participation fee charged per bid (the same money the wallet ledger books as
-- `bid_fee`), and `bid_increment_minor` is the bid increment.
-- --------------------------------------------------------------------------
ALTER TABLE auctions
  ADD COLUMN slug                text,
  -- One unit per auction for the MVP, enforced rather than assumed so a
  -- multi-unit auction cannot be created before the code supports one.
  ADD COLUMN quantity            integer NOT NULL DEFAULT 1,
  ADD COLUMN winner_payment_hours integer NOT NULL DEFAULT 48,
  ADD COLUMN shipping_note       text,

  -- Who did what, for the audit trail and for the approval rules.
  ADD COLUMN created_by          uuid REFERENCES users (id) ON DELETE RESTRICT,
  ADD COLUMN submitted_at        timestamptz,
  ADD COLUMN approved_by         uuid REFERENCES users (id) ON DELETE RESTRICT,
  ADD COLUMN approved_at         timestamptz,
  ADD COLUMN rejected_at         timestamptz,
  ADD COLUMN rejection_reason    text,
  ADD COLUMN opened_at           timestamptz,
  ADD COLUMN closing_at          timestamptz,
  ADD COLUMN suspended_at        timestamptz,
  ADD COLUMN suspended_by        uuid REFERENCES users (id) ON DELETE RESTRICT,
  ADD COLUMN suspend_reason      text,
  -- The state a suspension interrupted, so resume restores it rather than
  -- guessing.
  ADD COLUMN suspended_from      auction_status,

  ADD CONSTRAINT auctions_quantity_is_one CHECK (quantity = 1),
  ADD CONSTRAINT auctions_winner_payment_hours_positive
    CHECK (winner_payment_hours > 0),
  ADD CONSTRAINT auctions_slug_shape
    CHECK (slug IS NULL OR slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  ADD CONSTRAINT auctions_approved_consistent
    CHECK ((approved_at IS NULL) = (approved_by IS NULL)),
  ADD CONSTRAINT auctions_rejected_consistent
    CHECK ((rejected_at IS NULL) = (rejection_reason IS NULL)),
  -- A suspension must always record why and what it interrupted: an
  -- unexplained hold on someone's auction is not something to leave behind.
  ADD CONSTRAINT auctions_suspended_consistent
    CHECK (num_nonnulls(suspended_at, suspended_by, suspend_reason, suspended_from) IN (0, 4)),
  ADD CONSTRAINT auctions_cancel_reason_not_blank
    CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) > 0);

CREATE UNIQUE INDEX auctions_slug_key ON auctions (slug) WHERE slug IS NOT NULL;

-- The opening sweep: scheduled auctions whose start time has passed.
CREATE INDEX auctions_due_to_open_idx ON auctions (starts_at) WHERE status = 'scheduled';
-- Public discovery orders by newest within a status.
CREATE INDEX auctions_status_created_idx ON auctions (status, created_at DESC, id DESC);
-- The approval queue.
CREATE INDEX auctions_pending_approval_idx ON auctions (submitted_at)
  WHERE status = 'pending_approval';
-- Reviewing what an operator approved or suspended. Partial, so they cost
-- almost nothing on the rows that carry no operator.
CREATE INDEX auctions_approved_by_idx ON auctions (approved_by)
  WHERE approved_by IS NOT NULL;
CREATE INDEX auctions_suspended_by_idx ON auctions (suspended_by)
  WHERE suspended_by IS NOT NULL;
-- `created_by` is deliberately left unindexed: nothing queries auctions by
-- their creator (a seller's list is by seller_id), and users are never deleted
-- in practice, so the FK check that would use it does not run.

COMMENT ON COLUMN auctions.bid_fee_minor IS
  'Participation fee per bid, BIGINT minor units. Booked by the ledger as bid_fee.';
COMMENT ON COLUMN auctions.quantity IS
  'Always 1 for the MVP. Multi-unit auctions are not implemented.';
COMMENT ON COLUMN auctions.suspended_from IS
  'The status a suspension interrupted, so resume restores it rather than guessing.';

-- A free-to-enter auction is a legitimate configuration, so the participation
-- fee may be zero. It may never be negative.
ALTER TABLE auctions DROP CONSTRAINT auctions_bid_fee_positive;
ALTER TABLE auctions ADD CONSTRAINT auctions_bid_fee_non_negative
  CHECK (bid_fee_minor >= 0);

-- The bid ladder must be walkable: every amount from min to max must be
-- reachable in whole increments, or a bidder could be refused an amount the
-- published range appears to offer.
ALTER TABLE auctions ADD CONSTRAINT auctions_bid_range_divisible
  CHECK ((max_bid_minor - min_bid_minor) % bid_increment_minor = 0);

-- --------------------------------------------------------------------------
-- The auction immutability trigger, updated for the renamed states.
--
-- Terms become historical fact once bidding has begun, not only once the
-- auction has finished: a live auction's price range, fee, bid limit, deadline
-- and product are what its bidders committed against.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_auction_immutability() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('live', 'closing', 'calculating', 'completed', 'cancelled', 'suspended') THEN
    IF NEW.product_id          IS DISTINCT FROM OLD.product_id
       OR NEW.currency            IS DISTINCT FROM OLD.currency
       OR NEW.bid_fee_minor       IS DISTINCT FROM OLD.bid_fee_minor
       OR NEW.min_bid_minor       IS DISTINCT FROM OLD.min_bid_minor
       OR NEW.max_bid_minor       IS DISTINCT FROM OLD.max_bid_minor
       OR NEW.bid_increment_minor IS DISTINCT FROM OLD.bid_increment_minor
       OR NEW.max_bids_per_user   IS DISTINCT FROM OLD.max_bids_per_user
       OR NEW.starts_at           IS DISTINCT FROM OLD.starts_at
       OR NEW.ends_at             IS DISTINCT FROM OLD.ends_at
       OR NEW.quantity            IS DISTINCT FROM OLD.quantity
       OR NEW.algorithm_version   IS DISTINCT FROM OLD.algorithm_version
    THEN
      RAISE EXCEPTION
        'auction % is % and its terms are immutable', OLD.id, OLD.status
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  -- A completed auction is final; its result has been published.
  IF OLD.status = 'completed' AND NEW.status <> 'completed' THEN
    RAISE EXCEPTION 'auction % is completed and cannot change status', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- A cancelled auction is equally final: it never ran, and reopening it would
  -- resurrect terms nobody is still committed to.
  IF OLD.status = 'cancelled' AND NEW.status <> 'cancelled' THEN
    RAISE EXCEPTION 'auction % is cancelled and cannot change status', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- Re-stated for the renamed states: an auction past bidding has a closed_at.
ALTER TABLE auctions ADD CONSTRAINT auctions_closed_at_when_finished
  CHECK (status NOT IN ('calculating', 'completed') OR closed_at IS NOT NULL);

-- --------------------------------------------------------------------------
-- Inventory reservations.
--
-- A product holds stock; an auction represents one unit of it. The unit is
-- reserved when the auction goes live, not when it is created — an auction
-- that never opens must not hold stock hostage.
--
-- This table is the record; `products.reserved_quantity` is a cache maintained
-- in the same transaction, exactly as the wallet's cached balance is. The
-- states distinguish what Phase 4 does from what later phases will:
--
--   held      a live auction holds the unit
--   released  returned to stock (cancelled, suspended-and-cancelled, no winner)
--   consumed  taken by a fulfilled order (Phase 10 writes this; Phase 4 never does)
--
-- The partial unique index is what makes reservation idempotent: one auction
-- cannot hold two units, so a replayed open is a no-op rather than a
-- double-decrement.
-- --------------------------------------------------------------------------
CREATE TYPE inventory_reservation_state AS ENUM ('held', 'released', 'consumed');

CREATE TABLE inventory_reservations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  uuid    NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  auction_id  uuid    NOT NULL REFERENCES auctions (id) ON DELETE RESTRICT,
  quantity    integer NOT NULL DEFAULT 1,
  state       inventory_reservation_state NOT NULL DEFAULT 'held',
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  consumed_at timestamptz,

  CONSTRAINT inventory_reservations_quantity_positive CHECK (quantity > 0),
  CONSTRAINT inventory_reservations_released_consistent
    CHECK ((state = 'released') = (released_at IS NOT NULL)),
  CONSTRAINT inventory_reservations_consumed_consistent
    CHECK ((state = 'consumed') = (consumed_at IS NOT NULL))
);

-- One live hold per auction, ever. Partial so a released hold does not block a
-- legitimate later one, and so history is kept rather than overwritten.
CREATE UNIQUE INDEX inventory_reservations_held_key
  ON inventory_reservations (auction_id)
  WHERE state = 'held';

CREATE INDEX inventory_reservations_product_idx
  ON inventory_reservations (product_id, state);

-- No set_updated_at trigger here, deliberately: the table has no updated_at
-- column and does not need one. A reservation is written once and then
-- transitions at most twice, and `released_at`/`consumed_at` record exactly
-- when, which a generic updated_at would only duplicate less precisely.

COMMENT ON TABLE inventory_reservations IS
  'The record of which auction holds which product unit. products.reserved_quantity is a cache.';

-- Down Migration
DROP TABLE IF EXISTS inventory_reservations;
DROP TYPE IF EXISTS inventory_reservation_state;

ALTER TABLE auctions DROP CONSTRAINT IF EXISTS auctions_closed_at_when_finished;
ALTER TABLE auctions DROP CONSTRAINT IF EXISTS auctions_bid_range_divisible;
ALTER TABLE auctions DROP CONSTRAINT IF EXISTS auctions_bid_fee_non_negative;
ALTER TABLE auctions ADD CONSTRAINT auctions_bid_fee_positive CHECK (bid_fee_minor > 0);

DROP INDEX IF EXISTS auctions_suspended_by_idx;
DROP INDEX IF EXISTS auctions_approved_by_idx;
DROP INDEX IF EXISTS auctions_pending_approval_idx;
DROP INDEX IF EXISTS auctions_status_created_idx;
DROP INDEX IF EXISTS auctions_due_to_open_idx;
DROP INDEX IF EXISTS auctions_slug_key;

ALTER TABLE auctions
  DROP CONSTRAINT IF EXISTS auctions_cancel_reason_not_blank,
  DROP CONSTRAINT IF EXISTS auctions_suspended_consistent,
  DROP CONSTRAINT IF EXISTS auctions_rejected_consistent,
  DROP CONSTRAINT IF EXISTS auctions_approved_consistent,
  DROP CONSTRAINT IF EXISTS auctions_slug_shape,
  DROP CONSTRAINT IF EXISTS auctions_winner_payment_hours_positive,
  DROP CONSTRAINT IF EXISTS auctions_quantity_is_one,
  DROP COLUMN IF EXISTS suspended_from,
  DROP COLUMN IF EXISTS suspend_reason,
  DROP COLUMN IF EXISTS suspended_by,
  DROP COLUMN IF EXISTS suspended_at,
  DROP COLUMN IF EXISTS closing_at,
  DROP COLUMN IF EXISTS opened_at,
  DROP COLUMN IF EXISTS rejection_reason,
  DROP COLUMN IF EXISTS rejected_at,
  DROP COLUMN IF EXISTS approved_at,
  DROP COLUMN IF EXISTS approved_by,
  DROP COLUMN IF EXISTS submitted_at,
  DROP COLUMN IF EXISTS created_by,
  DROP COLUMN IF EXISTS shipping_note,
  DROP COLUMN IF EXISTS winner_payment_hours,
  DROP COLUMN IF EXISTS quantity,
  DROP COLUMN IF EXISTS slug;

DROP INDEX IF EXISTS products_category_status_idx;
DROP INDEX IF EXISTS products_seller_status_idx;
DROP INDEX IF EXISTS products_seller_sku_key;

ALTER TABLE products
  DROP CONSTRAINT IF EXISTS products_reserved_within_stock,
  DROP CONSTRAINT IF EXISTS products_reserved_non_negative,
  DROP CONSTRAINT IF EXISTS products_specs_is_object,
  DROP CONSTRAINT IF EXISTS products_brand_not_blank,
  DROP CONSTRAINT IF EXISTS products_sku_not_blank,
  DROP COLUMN IF EXISTS reserved_quantity,
  DROP COLUMN IF EXISTS specs,
  DROP COLUMN IF EXISTS condition,
  DROP COLUMN IF EXISTS brand,
  DROP COLUMN IF EXISTS sku;

DROP TYPE IF EXISTS product_condition;

-- Restore the Phase 1 state names, trigger body and dependents.
ALTER TABLE auctions DROP CONSTRAINT IF EXISTS auctions_cancelled_consistent;
DROP INDEX IF EXISTS auctions_due_to_close_idx;

ALTER TYPE auction_status RENAME TO auction_status_new;
CREATE TYPE auction_status AS ENUM (
  'draft', 'scheduled', 'live', 'closing', 'calculating', 'completed', 'cancelled'
);
ALTER TABLE auctions
  ALTER COLUMN status DROP DEFAULT,
  ALTER COLUMN status TYPE auction_status USING status::text::auction_status,
  ALTER COLUMN status SET DEFAULT 'draft';
DROP TYPE auction_status_new;
ALTER TYPE auction_status RENAME VALUE 'calculating' TO 'closed';
ALTER TYPE auction_status RENAME VALUE 'completed' TO 'settled';

ALTER TABLE auctions
  ADD CONSTRAINT auctions_closed_at_when_closed
    CHECK (status NOT IN ('closed', 'settled') OR closed_at IS NOT NULL),
  ADD CONSTRAINT auctions_cancelled_consistent
    CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL));

CREATE INDEX auctions_due_to_close_idx ON auctions (ends_at)
  WHERE status IN ('live', 'closing');

CREATE OR REPLACE FUNCTION enforce_auction_immutability() RETURNS trigger
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

  IF OLD.status = 'settled' AND NEW.status <> 'settled' THEN
    RAISE EXCEPTION 'auction % is settled and cannot change status', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
