-- Up Migration
--
-- Sellers, categories and the products auctions are run against.

CREATE TABLE sellers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid          NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  display_name   text          NOT NULL,
  legal_name     text,
  tax_id         text,
  support_email  citext,
  status         seller_status NOT NULL DEFAULT 'pending',
  payout_currency currency_code NOT NULL DEFAULT 'ETB',
  -- Basis points (1/100 of a percent) so commission stays integer arithmetic.
  commission_bps integer       NOT NULL DEFAULT 1000,
  approved_at    timestamptz,
  created_at     timestamptz   NOT NULL DEFAULT now(),
  updated_at     timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT sellers_display_name_not_blank CHECK (length(btrim(display_name)) > 0),
  CONSTRAINT sellers_commission_bps_range CHECK (commission_bps BETWEEN 0 AND 10000),
  CONSTRAINT sellers_approved_when_approved
    CHECK ((status = 'approved') = (approved_at IS NOT NULL))
);

CREATE UNIQUE INDEX sellers_user_id_key ON sellers (user_id);
CREATE INDEX sellers_status_idx ON sellers (status);

CREATE TRIGGER sellers_set_updated_at BEFORE UPDATE ON sellers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id  uuid REFERENCES categories (id) ON DELETE RESTRICT,
  slug       text        NOT NULL,
  name       text        NOT NULL,
  description text,
  position   integer     NOT NULL DEFAULT 0,
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT categories_slug_shape CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT categories_not_own_parent CHECK (parent_id IS DISTINCT FROM id),
  CONSTRAINT categories_position_non_negative CHECK (position >= 0)
);

CREATE UNIQUE INDEX categories_slug_key ON categories (slug);
CREATE INDEX categories_parent_idx ON categories (parent_id) WHERE parent_id IS NOT NULL;

CREATE TRIGGER categories_set_updated_at BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE products (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id          uuid           NOT NULL REFERENCES sellers (id) ON DELETE RESTRICT,
  category_id        uuid REFERENCES categories (id) ON DELETE SET NULL,
  slug               text           NOT NULL,
  title              text           NOT NULL,
  description        text,
  currency           currency_code  NOT NULL DEFAULT 'ETB',
  -- BIGINT minor units. ETB 120,000.00 is stored as 12000000.
  retail_price_minor bigint         NOT NULL,
  stock_quantity     integer        NOT NULL DEFAULT 0,
  status             product_status NOT NULL DEFAULT 'draft',
  created_at         timestamptz    NOT NULL DEFAULT now(),
  updated_at         timestamptz    NOT NULL DEFAULT now(),

  CONSTRAINT products_slug_shape CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT products_title_not_blank CHECK (length(btrim(title)) > 0),
  CONSTRAINT products_retail_price_positive CHECK (retail_price_minor > 0),
  -- Stock can never go negative, whatever the application believes.
  CONSTRAINT products_stock_non_negative CHECK (stock_quantity >= 0)
);

CREATE UNIQUE INDEX products_slug_key ON products (slug);
CREATE INDEX products_seller_idx ON products (seller_id);
CREATE INDEX products_category_idx ON products (category_id) WHERE category_id IS NOT NULL;
CREATE INDEX products_status_idx ON products (status) WHERE status = 'active';

CREATE TRIGGER products_set_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON COLUMN products.retail_price_minor IS
  'BIGINT minor units (ETB 1.00 = 100). Never a float.';

CREATE TABLE product_images (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  uuid    NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  -- Key in the S3-compatible bucket, not a URL: the host may change.
  storage_key text    NOT NULL,
  alt_text    text,
  position    integer NOT NULL DEFAULT 0,
  is_primary  boolean NOT NULL DEFAULT false,
  width_px    integer,
  height_px   integer,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT product_images_position_non_negative CHECK (position >= 0),
  CONSTRAINT product_images_dimensions_positive
    CHECK ((width_px IS NULL OR width_px > 0) AND (height_px IS NULL OR height_px > 0))
);

CREATE UNIQUE INDEX product_images_position_key ON product_images (product_id, position);
-- Exactly one primary image per product, enforced rather than assumed.
CREATE UNIQUE INDEX product_images_primary_key ON product_images (product_id)
  WHERE is_primary;

-- Down Migration
DROP TABLE IF EXISTS product_images;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS categories;
DROP TABLE IF EXISTS sellers;
