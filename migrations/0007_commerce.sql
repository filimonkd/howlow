-- Up Migration
--
-- What happens after an auction is won: the order, its payment, and delivery.

CREATE TABLE orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Human-quotable reference, e.g. HL-2026-000123.
  order_number    text          NOT NULL,
  user_id         uuid          NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  seller_id       uuid          NOT NULL REFERENCES sellers (id) ON DELETE RESTRICT,
  product_id      uuid          NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  -- Set when the order came from winning an auction; null for a direct sale.
  auction_id      uuid REFERENCES auctions (id) ON DELETE RESTRICT,
  status          order_status  NOT NULL DEFAULT 'pending_payment',
  currency        currency_code NOT NULL DEFAULT 'ETB',

  -- All BIGINT minor units; the total is checked against its parts so the
  -- arithmetic cannot silently drift.
  subtotal_minor  bigint        NOT NULL,
  shipping_minor  bigint        NOT NULL DEFAULT 0,
  tax_minor       bigint        NOT NULL DEFAULT 0,
  discount_minor  bigint        NOT NULL DEFAULT 0,
  total_minor     bigint        NOT NULL,

  shipping_address jsonb,
  placed_at       timestamptz   NOT NULL DEFAULT now(),
  paid_at         timestamptz,
  cancelled_at    timestamptz,
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT orders_amounts_non_negative
    CHECK (subtotal_minor >= 0 AND shipping_minor >= 0
           AND tax_minor >= 0 AND discount_minor >= 0 AND total_minor >= 0),
  CONSTRAINT orders_total_is_sum_of_parts
    CHECK (total_minor = subtotal_minor + shipping_minor + tax_minor - discount_minor),
  CONSTRAINT orders_discount_within_subtotal CHECK (discount_minor <= subtotal_minor),
  CONSTRAINT orders_paid_consistent
    CHECK (status <> 'paid' OR paid_at IS NOT NULL),
  CONSTRAINT orders_cancelled_consistent
    CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);

CREATE UNIQUE INDEX orders_order_number_key ON orders (order_number);
-- A won auction produces exactly one order.
CREATE UNIQUE INDEX orders_auction_id_key ON orders (auction_id)
  WHERE auction_id IS NOT NULL;
CREATE INDEX orders_user_idx ON orders (user_id, placed_at DESC);
CREATE INDEX orders_seller_idx ON orders (seller_id, placed_at DESC);
CREATE INDEX orders_status_idx ON orders (status);
CREATE INDEX orders_product_idx ON orders (product_id);

CREATE TRIGGER orders_set_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE payments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid REFERENCES orders (id) ON DELETE RESTRICT,
  user_id            uuid             NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  provider           payment_provider NOT NULL,
  -- The provider's own identifier for this charge.
  provider_reference text,
  status             payment_status   NOT NULL DEFAULT 'initiated',
  currency           currency_code    NOT NULL DEFAULT 'ETB',
  amount_minor       bigint           NOT NULL,
  fee_minor          bigint           NOT NULL DEFAULT 0,
  idempotency_key    text,
  failure_reason     text,
  initiated_at       timestamptz      NOT NULL DEFAULT now(),
  succeeded_at       timestamptz,
  failed_at          timestamptz,
  created_at         timestamptz      NOT NULL DEFAULT now(),
  updated_at         timestamptz      NOT NULL DEFAULT now(),

  CONSTRAINT payments_amount_positive CHECK (amount_minor > 0),
  CONSTRAINT payments_fee_non_negative CHECK (fee_minor >= 0),
  CONSTRAINT payments_succeeded_consistent
    CHECK ((status = 'succeeded') = (succeeded_at IS NOT NULL)),
  CONSTRAINT payments_failed_consistent
    CHECK (status <> 'failed' OR failed_at IS NOT NULL)
);

-- One provider reference is one payment: a retried callback cannot create a
-- second charge row.
CREATE UNIQUE INDEX payments_provider_reference_key
  ON payments (provider, provider_reference)
  WHERE provider_reference IS NOT NULL;
CREATE UNIQUE INDEX payments_idempotency_key_unique
  ON payments (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX payments_order_idx ON payments (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX payments_user_idx ON payments (user_id, created_at DESC);
CREATE INDEX payments_status_idx ON payments (status);

CREATE TRIGGER payments_set_updated_at BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE payment_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id        uuid REFERENCES payments (id) ON DELETE RESTRICT,
  provider          payment_provider NOT NULL,
  event_type        text             NOT NULL,
  -- The provider's event id, used to make webhook delivery idempotent.
  provider_event_id text,
  payload           jsonb            NOT NULL,
  signature_verified boolean         NOT NULL DEFAULT false,
  received_at       timestamptz      NOT NULL DEFAULT now(),

  CONSTRAINT payment_events_event_type_not_blank CHECK (length(btrim(event_type)) > 0)
);

-- Providers retry webhooks. The same event can only ever be recorded once.
CREATE UNIQUE INDEX payment_events_provider_event_key
  ON payment_events (provider, provider_event_id)
  WHERE provider_event_id IS NOT NULL;
CREATE INDEX payment_events_payment_idx ON payment_events (payment_id, received_at DESC)
  WHERE payment_id IS NOT NULL;

-- Provider callbacks are evidence of what was received and when.
CREATE TRIGGER payment_events_append_only
  BEFORE UPDATE OR DELETE ON payment_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE refunds (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id   uuid          NOT NULL REFERENCES payments (id) ON DELETE RESTRICT,
  order_id     uuid REFERENCES orders (id) ON DELETE RESTRICT,
  currency     currency_code NOT NULL DEFAULT 'ETB',
  amount_minor bigint        NOT NULL,
  status       refund_status NOT NULL DEFAULT 'requested',
  reason       text,
  requested_by uuid REFERENCES users (id) ON DELETE SET NULL,
  provider_reference text,
  requested_at timestamptz   NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at   timestamptz   NOT NULL DEFAULT now(),
  updated_at   timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT refunds_amount_positive CHECK (amount_minor > 0),
  CONSTRAINT refunds_completed_consistent
    CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

CREATE INDEX refunds_payment_idx ON refunds (payment_id);
CREATE INDEX refunds_status_idx ON refunds (status);
CREATE INDEX refunds_order_idx ON refunds (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX refunds_requested_by_idx ON refunds (requested_by)
  WHERE requested_by IS NOT NULL;
CREATE UNIQUE INDEX refunds_provider_reference_key ON refunds (provider_reference)
  WHERE provider_reference IS NOT NULL;

CREATE TRIGGER refunds_set_updated_at BEFORE UPDATE ON refunds
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE shipments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid            NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
  carrier         text,
  tracking_number text,
  status          shipment_status NOT NULL DEFAULT 'pending',
  recipient_name  text,
  address         jsonb,
  shipped_at      timestamptz,
  delivered_at    timestamptz,
  created_at      timestamptz     NOT NULL DEFAULT now(),
  updated_at      timestamptz     NOT NULL DEFAULT now(),

  -- Nothing can be delivered before it was dispatched.
  CONSTRAINT shipments_delivery_after_dispatch
    CHECK (delivered_at IS NULL OR (shipped_at IS NOT NULL AND delivered_at >= shipped_at)),
  CONSTRAINT shipments_delivered_consistent
    CHECK ((status = 'delivered') = (delivered_at IS NOT NULL))
);

CREATE INDEX shipments_order_idx ON shipments (order_id);
CREATE INDEX shipments_status_idx ON shipments (status);
CREATE UNIQUE INDEX shipments_tracking_key ON shipments (carrier, tracking_number)
  WHERE tracking_number IS NOT NULL;

CREATE TRIGGER shipments_set_updated_at BEFORE UPDATE ON shipments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration
DROP TABLE IF EXISTS shipments;
DROP TABLE IF EXISTS refunds;
DROP TABLE IF EXISTS payment_events;
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS orders;
