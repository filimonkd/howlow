-- Up Migration
--
-- Extensions, enum types and the trigger functions every later migration reuses.
--
-- Money rule for the whole schema: every monetary column is BIGINT holding an
-- integer count of MINOR units (ETB 1.00 = 100). No NUMERIC, no DOUBLE
-- PRECISION, no float arithmetic anywhere.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TYPE currency_code AS ENUM ('ETB', 'USD', 'EUR');

CREATE TYPE user_status AS ENUM ('pending', 'active', 'suspended', 'deleted');
CREATE TYPE role_name AS ENUM ('user', 'seller', 'support', 'admin');
CREATE TYPE otp_purpose AS ENUM ('registration', 'login', 'phone_change', 'password_reset');

-- How a request reached HOWLOW. Metadata only: no business rule may branch on
-- it, and results are identical across channels.
CREATE TYPE channel AS ENUM ('web', 'telegram', 'admin', 'system');

CREATE TYPE seller_status AS ENUM ('pending', 'approved', 'suspended', 'closed');
CREATE TYPE product_status AS ENUM ('draft', 'active', 'archived');

CREATE TYPE auction_status AS ENUM (
  'draft', 'scheduled', 'live', 'closing', 'closed', 'settled', 'cancelled'
);
CREATE TYPE bid_status AS ENUM ('valid', 'void', 'refunded');

CREATE TYPE wallet_entry_type AS ENUM (
  'deposit', 'withdrawal', 'bid_fee', 'bid_refund',
  'prize_payout', 'seller_payout', 'adjustment', 'hold', 'hold_release'
);

CREATE TYPE order_status AS ENUM (
  'pending_payment', 'paid', 'preparing', 'shipped', 'delivered', 'cancelled', 'refunded'
);
CREATE TYPE payment_provider AS ENUM ('telebirr', 'chapa', 'stripe', 'wallet', 'manual');
CREATE TYPE payment_status AS ENUM (
  'initiated', 'pending', 'succeeded', 'failed', 'cancelled', 'expired'
);
CREATE TYPE refund_status AS ENUM (
  'requested', 'approved', 'processing', 'completed', 'rejected'
);
CREATE TYPE shipment_status AS ENUM (
  'pending', 'dispatched', 'in_transit', 'delivered', 'returned', 'lost'
);

CREATE TYPE notification_channel AS ENUM ('web', 'telegram', 'email', 'sms');
CREATE TYPE notification_status AS ENUM ('pending', 'sent', 'failed', 'read');
CREATE TYPE outbox_status AS ENUM ('pending', 'sending', 'sent', 'failed');

CREATE TYPE fraud_flag_status AS ENUM ('open', 'reviewing', 'confirmed', 'dismissed');
CREATE TYPE fraud_flag_severity AS ENUM ('low', 'medium', 'high', 'critical');

-- Keeps updated_at honest without the application having to remember.
CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Attached to append-only tables (the wallet ledger, auction results, audit
-- logs, payment events). These records are financial and legal evidence: they
-- are written once and never edited, so the guarantee lives in the database
-- rather than in the discipline of every future caller.
CREATE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

-- Down Migration
DROP FUNCTION IF EXISTS forbid_mutation();
DROP FUNCTION IF EXISTS set_updated_at();

DROP TYPE IF EXISTS fraud_flag_severity;
DROP TYPE IF EXISTS fraud_flag_status;
DROP TYPE IF EXISTS outbox_status;
DROP TYPE IF EXISTS notification_status;
DROP TYPE IF EXISTS notification_channel;
DROP TYPE IF EXISTS shipment_status;
DROP TYPE IF EXISTS refund_status;
DROP TYPE IF EXISTS payment_status;
DROP TYPE IF EXISTS payment_provider;
DROP TYPE IF EXISTS order_status;
DROP TYPE IF EXISTS wallet_entry_type;
DROP TYPE IF EXISTS bid_status;
DROP TYPE IF EXISTS auction_status;
DROP TYPE IF EXISTS product_status;
DROP TYPE IF EXISTS seller_status;
DROP TYPE IF EXISTS channel;
DROP TYPE IF EXISTS otp_purpose;
DROP TYPE IF EXISTS role_name;
DROP TYPE IF EXISTS user_status;
DROP TYPE IF EXISTS currency_code;
