import type {
  Currency,
  ProductCondition,
  ProductStatus,
  SellerStatus,
} from '@howlow/shared';
import { getPool, type Tx } from '../../db/index.js';
import type {
  CategoryRecord,
  ProductImageRecord,
  ProductRecord,
  ProductWithImages,
  ReservationRecord,
  ReservationState,
  SellerRecord,
} from './types.js';

/**
 * Every catalog SQL statement. Nothing outside this file writes catalog SQL, so
 * the queries that decide ownership and inventory can be reviewed in one place.
 *
 * BIGINT columns arrive as strings — the driver's parsers were replaced in
 * Phase 0 precisely so they cannot silently become lossy numbers — and are
 * widened to `bigint` here.
 */
type Runner = Pick<Tx, 'query'>;
const runner = (tx?: Tx): Runner => tx ?? getPool();

// ---------------------------------------------------------------------------
// Sellers
// ---------------------------------------------------------------------------

interface SellerRow {
  id: string;
  user_id: string;
  display_name: string;
  status: SellerStatus;
  payout_currency: Currency;
  commission_bps: number;
  approved_at: Date | null;
  created_at: Date;
}

const toSeller = (row: SellerRow): SellerRecord => ({
  id: row.id,
  userId: row.user_id,
  displayName: row.display_name,
  status: row.status,
  payoutCurrency: row.payout_currency,
  commissionBps: row.commission_bps,
  approvedAt: row.approved_at,
  createdAt: row.created_at,
});

const SELLER_COLUMNS = `id, user_id, display_name, status, payout_currency,
  commission_bps, approved_at, created_at`;

export async function findSellerByUserId(
  userId: string,
  tx?: Tx,
): Promise<SellerRecord | undefined> {
  const { rows } = await runner(tx).query<SellerRow>(
    `SELECT ${SELLER_COLUMNS} FROM sellers WHERE user_id = $1`,
    [userId],
  );
  return rows[0] ? toSeller(rows[0]) : undefined;
}

export async function findSellerById(id: string, tx?: Tx): Promise<SellerRecord | undefined> {
  const { rows } = await runner(tx).query<SellerRow>(
    `SELECT ${SELLER_COLUMNS} FROM sellers WHERE id = $1`,
    [id],
  );
  return rows[0] ? toSeller(rows[0]) : undefined;
}

export async function insertSeller(
  input: { userId: string; displayName: string; legalName?: string | undefined },
  tx?: Tx,
): Promise<SellerRecord> {
  const { rows } = await runner(tx).query<SellerRow>(
    `INSERT INTO sellers (user_id, display_name, legal_name)
     VALUES ($1, $2, $3) RETURNING ${SELLER_COLUMNS}`,
    [input.userId, input.displayName, input.legalName ?? null],
  );
  return toSeller(rows[0]!);
}

export async function setSellerStatus(
  input: { sellerId: string; status: SellerStatus },
  tx?: Tx,
): Promise<SellerRecord | undefined> {
  const { rows } = await runner(tx).query<SellerRow>(
    // The approved_at CHECK ties the timestamp to the status, so both move together.
    `UPDATE sellers
        SET status = $2,
            approved_at = CASE WHEN $2 = 'approved' THEN COALESCE(approved_at, now()) ELSE NULL END
      WHERE id = $1
      RETURNING ${SELLER_COLUMNS}`,
    [input.sellerId, input.status],
  );
  return rows[0] ? toSeller(rows[0]) : undefined;
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

interface CategoryRow {
  id: string;
  parent_id: string | null;
  slug: string;
  name: string;
  description: string | null;
  position: number;
  is_active: boolean;
}

const toCategory = (row: CategoryRow): CategoryRecord => ({
  id: row.id,
  parentId: row.parent_id,
  slug: row.slug,
  name: row.name,
  description: row.description,
  position: row.position,
  isActive: row.is_active,
});

const CATEGORY_COLUMNS = `id, parent_id, slug, name, description, position, is_active`;

export async function listCategories(
  options: { activeOnly: boolean },
  tx?: Tx,
): Promise<CategoryRecord[]> {
  const { rows } = await runner(tx).query<CategoryRow>(
    `SELECT ${CATEGORY_COLUMNS} FROM categories
      WHERE ($1::boolean IS FALSE OR is_active)
      ORDER BY position, name`,
    [options.activeOnly],
  );
  return rows.map(toCategory);
}

export async function findCategoryBySlug(
  slug: string,
  tx?: Tx,
): Promise<CategoryRecord | undefined> {
  const { rows } = await runner(tx).query<CategoryRow>(
    `SELECT ${CATEGORY_COLUMNS} FROM categories WHERE slug = $1`,
    [slug],
  );
  return rows[0] ? toCategory(rows[0]) : undefined;
}

export async function findCategoryById(id: string, tx?: Tx): Promise<CategoryRecord | undefined> {
  const { rows } = await runner(tx).query<CategoryRow>(
    `SELECT ${CATEGORY_COLUMNS} FROM categories WHERE id = $1`,
    [id],
  );
  return rows[0] ? toCategory(rows[0]) : undefined;
}

export async function insertCategory(
  input: {
    slug: string;
    name: string;
    parentId?: string | undefined;
    description?: string | undefined;
    position?: number | undefined;
  },
  tx?: Tx,
): Promise<CategoryRecord> {
  const { rows } = await runner(tx).query<CategoryRow>(
    `INSERT INTO categories (slug, name, parent_id, description, position)
     VALUES ($1, $2, $3, $4, COALESCE($5, 0)) RETURNING ${CATEGORY_COLUMNS}`,
    [input.slug, input.name, input.parentId ?? null, input.description ?? null, input.position ?? null],
  );
  return toCategory(rows[0]!);
}

export async function updateCategory(
  id: string,
  changes: {
    slug?: string | undefined;
    name?: string | undefined;
    parentId?: string | null | undefined;
    description?: string | null | undefined;
    position?: number | undefined;
    isActive?: boolean | undefined;
  },
  tx?: Tx,
): Promise<CategoryRecord | undefined> {
  const { rows } = await runner(tx).query<CategoryRow>(
    // COALESCE on the parameter leaves an omitted field untouched. parent_id and
    // description are nullable, so they take an explicit "clear" sentinel rather
    // than treating NULL as "no change".
    `UPDATE categories SET
       slug        = COALESCE($2, slug),
       name        = COALESCE($3, name),
       parent_id   = CASE WHEN $4::boolean THEN $5::uuid ELSE parent_id END,
       description = CASE WHEN $6::boolean THEN $7::text ELSE description END,
       position    = COALESCE($8, position),
       is_active   = COALESCE($9, is_active)
     WHERE id = $1
     RETURNING ${CATEGORY_COLUMNS}`,
    [
      id,
      changes.slug ?? null,
      changes.name ?? null,
      changes.parentId !== undefined,
      changes.parentId ?? null,
      changes.description !== undefined,
      changes.description ?? null,
      changes.position ?? null,
      changes.isActive ?? null,
    ],
  );
  return rows[0] ? toCategory(rows[0]) : undefined;
}

/**
 * Every ancestor of a category, nearest first.
 *
 * Used to refuse a parent change that would make a category its own ancestor.
 * The depth cap is a safety net rather than a product rule: if a cycle somehow
 * existed already, an uncapped recursive query would not terminate.
 */
export async function listAncestorIds(categoryId: string, tx?: Tx): Promise<string[]> {
  const { rows } = await runner(tx).query<{ id: string }>(
    `WITH RECURSIVE ancestry AS (
       SELECT id, parent_id, 1 AS depth FROM categories WHERE id = $1
       UNION ALL
       SELECT c.id, c.parent_id, a.depth + 1
         FROM categories c JOIN ancestry a ON c.id = a.parent_id
        WHERE a.depth < 32
     )
     SELECT id FROM ancestry WHERE id <> $1`,
    [categoryId],
  );
  return rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

interface ProductRow {
  id: string;
  seller_id: string;
  seller_name: string;
  category_id: string | null;
  category_slug: string | null;
  slug: string;
  title: string;
  description: string | null;
  sku: string | null;
  brand: string | null;
  condition: ProductCondition;
  specs: Record<string, string>;
  currency: Currency;
  retail_price_minor: string;
  stock_quantity: number;
  reserved_quantity: number;
  status: ProductStatus;
  created_at: Date;
  updated_at: Date;
}

const toProduct = (row: ProductRow): ProductRecord => ({
  id: row.id,
  sellerId: row.seller_id,
  sellerName: row.seller_name,
  categoryId: row.category_id,
  categorySlug: row.category_slug,
  slug: row.slug,
  title: row.title,
  description: row.description,
  sku: row.sku,
  brand: row.brand,
  condition: row.condition,
  specs: row.specs,
  currency: row.currency,
  retailPriceMinor: BigInt(row.retail_price_minor),
  stockQuantity: row.stock_quantity,
  reservedQuantity: row.reserved_quantity,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** Joined so a product read never needs a second query for its seller or category. */
const PRODUCT_SELECT = `
  SELECT p.id, p.seller_id, s.display_name AS seller_name,
         p.category_id, c.slug AS category_slug,
         p.slug, p.title, p.description, p.sku, p.brand, p.condition, p.specs,
         p.currency, p.retail_price_minor, p.stock_quantity, p.reserved_quantity,
         p.status, p.created_at, p.updated_at
    FROM products p
    JOIN sellers s ON s.id = p.seller_id
    LEFT JOIN categories c ON c.id = p.category_id`;

export async function findProductById(id: string, tx?: Tx): Promise<ProductRecord | undefined> {
  const { rows } = await runner(tx).query<ProductRow>(`${PRODUCT_SELECT} WHERE p.id = $1`, [id]);
  return rows[0] ? toProduct(rows[0]) : undefined;
}

export async function findProductBySlug(slug: string, tx?: Tx): Promise<ProductRecord | undefined> {
  const { rows } = await runner(tx).query<ProductRow>(`${PRODUCT_SELECT} WHERE p.slug = $1`, [slug]);
  return rows[0] ? toProduct(rows[0]) : undefined;
}

/**
 * Read the product under a row lock. **This is the serialisation point for
 * inventory.**
 *
 * `FOR UPDATE` makes concurrent reservations against one product queue here
 * rather than racing: the availability each of them then reads already
 * reflects every reservation that committed earlier. Without it, two auctions
 * could both see the last unit free, both pass their own check, and together
 * oversell — the `reserved_quantity <= stock_quantity` CHECK would catch it,
 * but as a database error rather than a clean refusal.
 *
 * Only ever called inside a transaction; a lock outside one is released
 * immediately and protects nothing.
 */
export async function lockProductById(id: string, tx: Tx): Promise<ProductRecord | undefined> {
  const { rows } = await tx.query<ProductRow>(
    `${PRODUCT_SELECT} WHERE p.id = $1 FOR UPDATE OF p`,
    [id],
  );
  return rows[0] ? toProduct(rows[0]) : undefined;
}

export async function insertProduct(
  input: {
    sellerId: string;
    categoryId?: string | undefined;
    slug: string;
    title: string;
    description: string;
    sku?: string | undefined;
    brand?: string | undefined;
    condition: ProductCondition;
    specs: Record<string, string>;
    currency: Currency;
    retailPriceMinor: bigint;
    stockQuantity: number;
  },
  tx?: Tx,
): Promise<ProductRecord> {
  const { rows } = await runner(tx).query<{ id: string }>(
    `INSERT INTO products
       (seller_id, category_id, slug, title, description, sku, brand, condition,
        specs, currency, retail_price_minor, stock_quantity, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, 'draft')
     RETURNING id`,
    [
      input.sellerId,
      input.categoryId ?? null,
      input.slug,
      input.title,
      input.description,
      input.sku ?? null,
      input.brand ?? null,
      input.condition,
      JSON.stringify(input.specs),
      input.currency,
      input.retailPriceMinor.toString(),
      input.stockQuantity,
    ],
  );
  return (await findProductById(rows[0]!.id, tx))!;
}

export async function updateProduct(
  id: string,
  changes: {
    slug?: string | undefined;
    title?: string | undefined;
    description?: string | undefined;
    categoryId?: string | null | undefined;
    sku?: string | null | undefined;
    brand?: string | null | undefined;
    condition?: ProductCondition | undefined;
    specs?: Record<string, string> | undefined;
    retailPriceMinor?: bigint | undefined;
    stockQuantity?: number | undefined;
    status?: ProductStatus | undefined;
  },
  tx?: Tx,
): Promise<ProductRecord | undefined> {
  await runner(tx).query(
    `UPDATE products SET
       slug        = COALESCE($2, slug),
       title       = COALESCE($3, title),
       description = COALESCE($4, description),
       category_id = CASE WHEN $5::boolean THEN $6::uuid ELSE category_id END,
       sku         = CASE WHEN $7::boolean THEN $8::text ELSE sku END,
       brand       = CASE WHEN $9::boolean THEN $10::text ELSE brand END,
       condition   = COALESCE($11, condition),
       specs       = COALESCE($12::jsonb, specs),
       retail_price_minor = COALESCE($13::bigint, retail_price_minor),
       stock_quantity     = COALESCE($14::integer, stock_quantity),
       status      = COALESCE($15, status)
     WHERE id = $1`,
    [
      id,
      changes.slug ?? null,
      changes.title ?? null,
      changes.description ?? null,
      changes.categoryId !== undefined,
      changes.categoryId ?? null,
      changes.sku !== undefined,
      changes.sku ?? null,
      changes.brand !== undefined,
      changes.brand ?? null,
      changes.condition ?? null,
      changes.specs === undefined ? null : JSON.stringify(changes.specs),
      changes.retailPriceMinor?.toString() ?? null,
      changes.stockQuantity ?? null,
      changes.status ?? null,
    ],
  );
  return findProductById(id, tx);
}

export interface ProductPage {
  readonly products: ProductRecord[];
  readonly nextCursor: { createdAt: Date; id: string } | null;
}

/**
 * A page of products, newest first.
 *
 * Keyset pagination on (created_at, id) rather than OFFSET: the list grows at
 * the head, so an offset would shift under a reader between pages and show one
 * product twice or skip another.
 */
export async function listProducts(
  filters: {
    sellerId?: string | undefined;
    status?: ProductStatus | undefined;
    categorySlug?: string | undefined;
    limit: number;
    cursor?: { createdAt: Date; id: string } | undefined;
  },
  tx?: Tx,
): Promise<ProductPage> {
  const { rows } = await runner(tx).query<ProductRow>(
    `${PRODUCT_SELECT}
      WHERE ($1::uuid IS NULL OR p.seller_id = $1::uuid)
        AND ($2::product_status IS NULL OR p.status = $2::product_status)
        AND ($3::text IS NULL OR c.slug = $3::text)
        AND ($4::timestamptz IS NULL OR (p.created_at, p.id) < ($4::timestamptz, $5::uuid))
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT $6`,
    [
      filters.sellerId ?? null,
      filters.status ?? null,
      filters.categorySlug ?? null,
      filters.cursor?.createdAt ?? null,
      filters.cursor?.id ?? null,
      filters.limit + 1,
    ],
  );
  const products = rows.slice(0, filters.limit).map(toProduct);
  const last = products[products.length - 1];
  return {
    products,
    nextCursor:
      rows.length > filters.limit && last ? { createdAt: last.createdAt, id: last.id } : null,
  };
}

/** How many auctions reference this product. Decides archive-versus-delete. */
export async function countAuctionsForProduct(productId: string, tx?: Tx): Promise<number> {
  const { rows } = await runner(tx).query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM auctions WHERE product_id = $1`,
    [productId],
  );
  return Number(rows[0]?.count ?? '0');
}

/** Auctions holding this product that are not finished, for edit refusals. */
export async function countActiveAuctionsForProduct(productId: string, tx?: Tx): Promise<number> {
  const { rows } = await runner(tx).query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM auctions
      WHERE product_id = $1
        AND status IN ('pending_approval', 'scheduled', 'live', 'closing', 'calculating', 'suspended')`,
    [productId],
  );
  return Number(rows[0]?.count ?? '0');
}

// ---------------------------------------------------------------------------
// Product images
// ---------------------------------------------------------------------------

interface ImageRow {
  id: string;
  product_id: string;
  storage_key: string;
  alt_text: string | null;
  position: number;
  is_primary: boolean;
}

const toImage = (row: ImageRow): ProductImageRecord => ({
  id: row.id,
  productId: row.product_id,
  storageKey: row.storage_key,
  altText: row.alt_text,
  position: row.position,
  isPrimary: row.is_primary,
});

const IMAGE_COLUMNS = `id, product_id, storage_key, alt_text, position, is_primary`;

export async function listImages(productId: string, tx?: Tx): Promise<ProductImageRecord[]> {
  const { rows } = await runner(tx).query<ImageRow>(
    `SELECT ${IMAGE_COLUMNS} FROM product_images WHERE product_id = $1 ORDER BY position`,
    [productId],
  );
  return rows.map(toImage);
}

/** Images for many products at once, so a listing does not issue N queries. */
export async function listImagesForProducts(
  productIds: readonly string[],
  tx?: Tx,
): Promise<Map<string, ProductImageRecord[]>> {
  const grouped = new Map<string, ProductImageRecord[]>();
  if (productIds.length === 0) return grouped;

  const { rows } = await runner(tx).query<ImageRow>(
    `SELECT ${IMAGE_COLUMNS} FROM product_images
      WHERE product_id = ANY($1::uuid[]) ORDER BY product_id, position`,
    [[...productIds]],
  );
  for (const row of rows) {
    const image = toImage(row);
    const existing = grouped.get(image.productId);
    if (existing) existing.push(image);
    else grouped.set(image.productId, [image]);
  }
  return grouped;
}

export async function findImageById(
  input: { productId: string; imageId: string },
  tx?: Tx,
): Promise<ProductImageRecord | undefined> {
  const { rows } = await runner(tx).query<ImageRow>(
    `SELECT ${IMAGE_COLUMNS} FROM product_images WHERE id = $1 AND product_id = $2`,
    [input.imageId, input.productId],
  );
  return rows[0] ? toImage(rows[0]) : undefined;
}

export async function countImages(productId: string, tx?: Tx): Promise<number> {
  const { rows } = await runner(tx).query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM product_images WHERE product_id = $1`,
    [productId],
  );
  return Number(rows[0]?.count ?? '0');
}

export async function insertImage(
  input: {
    productId: string;
    storageKey: string;
    altText?: string | undefined;
    position: number;
    isPrimary: boolean;
  },
  tx?: Tx,
): Promise<ProductImageRecord> {
  const { rows } = await runner(tx).query<ImageRow>(
    `INSERT INTO product_images (product_id, storage_key, alt_text, position, is_primary)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${IMAGE_COLUMNS}`,
    [input.productId, input.storageKey, input.altText ?? null, input.position, input.isPrimary],
  );
  return toImage(rows[0]!);
}

export async function deleteImage(
  input: { productId: string; imageId: string },
  tx?: Tx,
): Promise<ProductImageRecord | undefined> {
  const { rows } = await runner(tx).query<ImageRow>(
    `DELETE FROM product_images WHERE id = $1 AND product_id = $2 RETURNING ${IMAGE_COLUMNS}`,
    [input.imageId, input.productId],
  );
  return rows[0] ? toImage(rows[0]) : undefined;
}

/**
 * Apply a new display order.
 *
 * Positions and the primary flag are both unique per product, so the rows
 * cannot be rewritten one at a time without transiently colliding. Everything
 * is pushed to a temporary negative range first, then written back in order —
 * all inside the caller's transaction, so no reader ever sees the gap.
 */
export async function applyImageOrder(
  input: { productId: string; imageIds: readonly string[] },
  tx: Tx,
): Promise<void> {
  await tx.query(
    `UPDATE product_images SET position = -1 - position, is_primary = false
      WHERE product_id = $1`,
    [input.productId],
  );
  await tx.query(
    `UPDATE product_images AS img
        SET position = ordered.position - 1,
            is_primary = (ordered.position = 1)
       FROM unnest($2::uuid[]) WITH ORDINALITY AS ordered(id, position)
      WHERE img.id = ordered.id AND img.product_id = $1`,
    [input.productId, [...input.imageIds]],
  );
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

interface ReservationRow {
  id: string;
  product_id: string;
  auction_id: string;
  quantity: number;
  state: ReservationState;
  reason: string | null;
  created_at: Date;
  released_at: Date | null;
}

const toReservation = (row: ReservationRow): ReservationRecord => ({
  id: row.id,
  productId: row.product_id,
  auctionId: row.auction_id,
  quantity: row.quantity,
  state: row.state,
  reason: row.reason,
  createdAt: row.created_at,
  releasedAt: row.released_at,
});

const RESERVATION_COLUMNS = `id, product_id, auction_id, quantity, state, reason,
  created_at, released_at`;

export async function findHeldReservation(
  auctionId: string,
  tx?: Tx,
): Promise<ReservationRecord | undefined> {
  const { rows } = await runner(tx).query<ReservationRow>(
    `SELECT ${RESERVATION_COLUMNS} FROM inventory_reservations
      WHERE auction_id = $1 AND state = 'held'`,
    [auctionId],
  );
  return rows[0] ? toReservation(rows[0]) : undefined;
}

/**
 * Claim a unit for this auction.
 *
 * `ON CONFLICT DO NOTHING` against the partial unique index on held rows is
 * what makes reservation idempotent: a replayed open cannot produce a second
 * hold, so the caller distinguishes "I reserved it" from "it was already
 * reserved" by whether a row comes back, rather than by checking first and
 * hoping nothing changed in between.
 */
export async function insertReservation(
  input: { productId: string; auctionId: string; quantity: number },
  tx: Tx,
): Promise<ReservationRecord | undefined> {
  const { rows } = await tx.query<ReservationRow>(
    `INSERT INTO inventory_reservations (product_id, auction_id, quantity)
     VALUES ($1, $2, $3)
     ON CONFLICT (auction_id) WHERE state = 'held' DO NOTHING
     RETURNING ${RESERVATION_COLUMNS}`,
    [input.productId, input.auctionId, input.quantity],
  );
  return rows[0] ? toReservation(rows[0]) : undefined;
}

export async function markReservationReleased(
  input: { reservationId: string; reason: string },
  tx: Tx,
): Promise<ReservationRecord | undefined> {
  const { rows } = await tx.query<ReservationRow>(
    `UPDATE inventory_reservations
        SET state = 'released', released_at = now(), reason = $2
      WHERE id = $1 AND state = 'held'
      RETURNING ${RESERVATION_COLUMNS}`,
    [input.reservationId, input.reason],
  );
  return rows[0] ? toReservation(rows[0]) : undefined;
}

/**
 * Move the cached reserved count.
 *
 * Always called with the product row locked and in the same transaction as the
 * reservation row it accounts for, so the cache and the record cannot diverge.
 * The `reserved_quantity <= stock_quantity` CHECK is the database's own last
 * word behind the service's availability check.
 */
export async function adjustReservedQuantity(
  input: { productId: string; delta: number },
  tx: Tx,
): Promise<void> {
  await tx.query(`UPDATE products SET reserved_quantity = reserved_quantity + $2 WHERE id = $1`, [
    input.productId,
    input.delta,
  ]);
}

/** Sum of held reservations, for reconciling the cached count. */
export async function sumHeldReservations(productId: string, tx?: Tx): Promise<number> {
  const { rows } = await runner(tx).query<{ total: string }>(
    `SELECT COALESCE(SUM(quantity), 0)::text AS total FROM inventory_reservations
      WHERE product_id = $1 AND state = 'held'`,
    [productId],
  );
  return Number(rows[0]?.total ?? '0');
}

/** Attach images to already-loaded products. */
export async function withImages(
  products: readonly ProductRecord[],
  tx?: Tx,
): Promise<ProductWithImages[]> {
  const byProduct = await listImagesForProducts(
    products.map((product) => product.id),
    tx,
  );
  return products.map((product) => ({ ...product, images: byProduct.get(product.id) ?? [] }));
}
