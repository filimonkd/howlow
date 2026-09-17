-- Up Migration
--
-- Auction-result support. Additive: `auction_results` and `orders` stand as
-- Phase 1 and Phase 7 defined them, and no migration history is rewound.
--
-- Two things the closing workflow needs that the existing schema does not
-- express:
--
--   1. **The outcome, stated rather than inferred.** Phase 1's table encodes a
--      winner through `auction_results_winner_complete` — three winner columns
--      set together or none at all — which distinguishes "won" from "did not",
--      but not *why* it did not. A no-unique-bid auction and an auction nobody
--      bid on are different facts with different consequences (one refunds
--      fees, the other has none to refund), and reading them back out of
--      `total_valid_bids = 0` is inference rather than record. An explicit
--      column also lets `cancelled` have a result row, which is the shape the
--      administrative path needs.
--   2. **The winner's payment deadline.** `auctions.winner_payment_hours` says
--      how long a winner has; the order has to say *until when*, because the
--      answer must not move if the auction's terms are ever re-read.

-- --------------------------------------------------------------------------
-- The outcome.
-- --------------------------------------------------------------------------
CREATE TYPE auction_outcome AS ENUM ('winner', 'no_unique_bid', 'no_bids', 'cancelled');

ALTER TABLE auction_results
  ADD COLUMN outcome auction_outcome NOT NULL;

COMMENT ON COLUMN auction_results.outcome IS
  'Why the auction ended as it did. Stated rather than inferred from the winner columns.';

-- The outcome and the winner columns must agree. `winner_complete` already
-- says the three winner facts arrive together; these say which outcomes may
-- carry them, so a result claiming a winner with no winning bid — or a
-- no-bids result that somehow names one — cannot be written at all.
ALTER TABLE auction_results
  ADD CONSTRAINT auction_results_winner_matches_outcome
    CHECK ((outcome = 'winner') = (winning_bid_id IS NOT NULL)),
  -- A no-bids result counted nothing. This is the one place the statistics and
  -- the outcome can contradict each other, so the database refuses it.
  ADD CONSTRAINT auction_results_no_bids_has_no_bids
    CHECK (outcome <> 'no_bids' OR (total_valid_bids = 0 AND unique_amount_count = 0)),
  -- And a no-unique-bid result had bids but no amount that stood alone.
  ADD CONSTRAINT auction_results_no_unique_had_bids
    CHECK (outcome <> 'no_unique_bid' OR (total_valid_bids > 0 AND unique_amount_count = 0));

-- Operators ask "what happened to the auctions that closed today", which is a
-- scan by outcome over a growing table.
CREATE INDEX auction_results_outcome_idx ON auction_results (outcome, computed_at DESC);

-- --------------------------------------------------------------------------
-- The winner's deadline.
--
-- Computed once, when the order is created, from the auction's
-- `winner_payment_hours` as it stood at that moment. Stored rather than
-- derived on read: the deadline a winner was told is the deadline that binds,
-- and re-deriving it later from a re-read of the auction would let the answer
-- change.
--
-- Nullable because a direct sale — an order with no auction — has no auction
-- deadline. The CHECK ties the two together so an auction order cannot lack
-- one.
-- --------------------------------------------------------------------------
ALTER TABLE orders
  ADD COLUMN payment_due_at timestamptz,
  ADD CONSTRAINT orders_auction_order_has_deadline
    CHECK (auction_id IS NULL OR payment_due_at IS NOT NULL),
  ADD CONSTRAINT orders_deadline_after_placement
    CHECK (payment_due_at IS NULL OR payment_due_at > placed_at);

COMMENT ON COLUMN orders.payment_due_at IS
  'When an auction winner must have paid by. Fixed when the order is created; never re-derived.';

-- Finding orders whose deadline has passed is a worker query in a later phase,
-- and it is only ever asked about orders still awaiting payment.
CREATE INDEX orders_payment_due_idx ON orders (payment_due_at)
  WHERE status = 'pending_payment' AND payment_due_at IS NOT NULL;

-- --------------------------------------------------------------------------
-- Result immutability.
--
-- `auction_results_append_only` already forbids UPDATE and DELETE on the
-- table, which is what makes a published result evidence rather than an
-- opinion. Nothing here weakens it, and the `outcome` column is inside that
-- guarantee: it is written once, with the row.
--
-- No index is added on `orders.auction_id`: `orders_auction_id_key` is already
-- a partial unique index on it, which is both the one-order-per-auction rule
-- and the lookup the result path performs.
-- --------------------------------------------------------------------------

-- Down Migration

DROP INDEX IF EXISTS orders_payment_due_idx;

ALTER TABLE orders
  DROP CONSTRAINT orders_deadline_after_placement,
  DROP CONSTRAINT orders_auction_order_has_deadline,
  DROP COLUMN payment_due_at;

DROP INDEX IF EXISTS auction_results_outcome_idx;

ALTER TABLE auction_results
  DROP CONSTRAINT auction_results_no_unique_had_bids,
  DROP CONSTRAINT auction_results_no_bids_has_no_bids,
  DROP CONSTRAINT auction_results_winner_matches_outcome,
  DROP COLUMN outcome;

DROP TYPE auction_outcome;
