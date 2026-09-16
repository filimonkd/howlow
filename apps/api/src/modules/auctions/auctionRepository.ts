import type { AuctionSort, AuctionStatus, Currency, ProductCondition } from '@howlow/shared';
import { getPool, type Tx } from '../../db/index.js';
import type { AuctionRecord, AuctionWithDisplay } from './types.js';

/**
 * Every auction SQL statement. Nothing outside this file writes auction SQL,
 * so the queries that change an auction's state can be reviewed in one place.
 */
type Runner = Pick<Tx, 'query'>;
const runner = (tx?: Tx): Runner => tx ?? getPool();

interface AuctionRow {
  id: string;
  product_id: string;
  seller_id: string;
  slug: string | null;
  title: string;
  description: string | null;
  shipping_note: string | null;
  currency: Currency;
  bid_fee_minor: string;
  min_bid_minor: string;
  max_bid_minor: string;
  bid_increment_minor: string;
  max_bids_per_user: number;
  winner_payment_hours: number;
  quantity: number;
  status: AuctionStatus;
  algorithm_version: string;
  starts_at: Date;
  ends_at: Date;
  created_by: string | null;
  submitted_at: Date | null;
  approved_by: string | null;
  approved_at: Date | null;
  rejected_at: Date | null;
  rejection_reason: string | null;
  opened_at: Date | null;
  closing_at: Date | null;
  closed_at: Date | null;
  suspended_at: Date | null;
  suspend_reason: string | null;
  suspended_from: AuctionStatus | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

interface DisplayRow {
  seller_name: string;
  category_slug: string | null;
  product_title: string;
  product_description: string | null;
  product_brand: string | null;
  product_condition: ProductCondition;
  product_specs: Record<string, string>;
  retail_price_minor: string;
}

function toAuction(row: AuctionRow): AuctionRecord {
  return {
    id: row.id,
    productId: row.product_id,
    sellerId: row.seller_id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    shippingNote: row.shipping_note,
    currency: row.currency,
    bidFeeMinor: BigInt(row.bid_fee_minor),
    minBidMinor: BigInt(row.min_bid_minor),
    maxBidMinor: BigInt(row.max_bid_minor),
    bidIncrementMinor: BigInt(row.bid_increment_minor),
    maxBidsPerUser: row.max_bids_per_user,
    winnerPaymentHours: row.winner_payment_hours,
    quantity: row.quantity,
    status: row.status,
    algorithmVersion: row.algorithm_version,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    createdBy: row.created_by,
    submittedAt: row.submitted_at,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    rejectedAt: row.rejected_at,
    rejectionReason: row.rejection_reason,
    openedAt: row.opened_at,
    closingAt: row.closing_at,
    closedAt: row.closed_at,
    suspendedAt: row.suspended_at,
    suspendReason: row.suspend_reason,
    suspendedFrom: row.suspended_from,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const toDisplay = (row: AuctionRow & DisplayRow): AuctionWithDisplay => ({
  ...toAuction(row),
  sellerName: row.seller_name,
  categorySlug: row.category_slug,
  productTitle: row.product_title,
  productDescription: row.product_description,
  productBrand: row.product_brand,
  productCondition: row.product_condition,
  productSpecs: row.product_specs,
  retailPriceMinor: BigInt(row.retail_price_minor),
});

const AUCTION_COLUMNS = `a.id, a.product_id, a.seller_id, a.slug, a.title, a.description,
  a.shipping_note, a.currency, a.bid_fee_minor, a.min_bid_minor, a.max_bid_minor,
  a.bid_increment_minor, a.max_bids_per_user, a.winner_payment_hours, a.quantity,
  a.status, a.algorithm_version, a.starts_at, a.ends_at, a.created_by, a.submitted_at,
  a.approved_by, a.approved_at, a.rejected_at, a.rejection_reason, a.opened_at,
  a.closing_at, a.closed_at, a.suspended_at, a.suspend_reason, a.suspended_from,
  a.cancelled_at, a.cancel_reason, a.created_at, a.updated_at`;

const DISPLAY_COLUMNS = `s.display_name AS seller_name, c.slug AS category_slug,
  p.title AS product_title, p.description AS product_description, p.brand AS product_brand,
  p.condition AS product_condition, p.specs AS product_specs, p.retail_price_minor`;

const AUCTION_SELECT = `
  SELECT ${AUCTION_COLUMNS}, ${DISPLAY_COLUMNS}
    FROM auctions a
    JOIN products p ON p.id = a.product_id
    JOIN sellers s ON s.id = a.seller_id
    LEFT JOIN categories c ON c.id = p.category_id`;

export async function findById(id: string, tx?: Tx): Promise<AuctionWithDisplay | undefined> {
  const { rows } = await runner(tx).query<AuctionRow & DisplayRow>(
    `${AUCTION_SELECT} WHERE a.id = $1`,
    [id],
  );
  return rows[0] ? toDisplay(rows[0]) : undefined;
}

export async function findBySlug(slug: string, tx?: Tx): Promise<AuctionWithDisplay | undefined> {
  const { rows } = await runner(tx).query<AuctionRow & DisplayRow>(
    `${AUCTION_SELECT} WHERE a.slug = $1`,
    [slug],
  );
  return rows[0] ? toDisplay(rows[0]) : undefined;
}

/**
 * Read the auction under a row lock. **This is the serialisation point for
 * every lifecycle transition.**
 *
 * Two workers that both try to open the same auction queue here, and the
 * second reads the status the first committed — which is what makes "opened
 * twice" impossible rather than unlikely.
 *
 * The auction row is the **first** lock in the platform's order
 * (auction → product → wallet), so it is safe to take a product lock while
 * holding it, and a wallet lock after that in Phase 5.
 *
 * Only ever called inside a transaction; a lock outside one protects nothing.
 */
export async function lockById(id: string, tx: Tx): Promise<AuctionRecord | undefined> {
  const { rows } = await tx.query<AuctionRow>(
    `SELECT ${AUCTION_COLUMNS} FROM auctions a WHERE a.id = $1 FOR UPDATE`,
    [id],
  );
  return rows[0] ? toAuction(rows[0]) : undefined;
}

export async function insert(
  input: {
    productId: string;
    sellerId: string;
    slug: string;
    title: string;
    description: string;
    shippingNote?: string | undefined;
    currency: Currency;
    bidFeeMinor: bigint;
    minBidMinor: bigint;
    maxBidMinor: bigint;
    bidIncrementMinor: bigint;
    maxBidsPerUser: number;
    winnerPaymentHours: number;
    startsAt: Date;
    endsAt: Date;
    createdBy: string;
  },
  tx?: Tx,
): Promise<AuctionRecord> {
  const { rows } = await runner(tx).query<AuctionRow>(
    `INSERT INTO auctions
       (product_id, seller_id, slug, title, description, shipping_note, currency,
        bid_fee_minor, min_bid_minor, max_bid_minor, bid_increment_minor,
        max_bids_per_user, winner_payment_hours, starts_at, ends_at, created_by,
        quantity, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 1, 'draft')
     RETURNING ${AUCTION_COLUMNS.replace(/a\./g, '')}`,
    [
      input.productId,
      input.sellerId,
      input.slug,
      input.title,
      input.description,
      input.shippingNote ?? null,
      input.currency,
      input.bidFeeMinor.toString(),
      input.minBidMinor.toString(),
      input.maxBidMinor.toString(),
      input.bidIncrementMinor.toString(),
      input.maxBidsPerUser,
      input.winnerPaymentHours,
      input.startsAt,
      input.endsAt,
      input.createdBy,
    ],
  );
  return toAuction(rows[0]!);
}

/** Edit the terms of an auction that has not started. */
export async function updateTerms(
  id: string,
  changes: {
    slug?: string | undefined;
    title?: string | undefined;
    description?: string | undefined;
    shippingNote?: string | null | undefined;
    startsAt?: Date | undefined;
    endsAt?: Date | undefined;
    minBidMinor?: bigint | undefined;
    maxBidMinor?: bigint | undefined;
    bidIncrementMinor?: bigint | undefined;
    maxBidsPerUser?: number | undefined;
    bidFeeMinor?: bigint | undefined;
    winnerPaymentHours?: number | undefined;
  },
  tx: Tx,
): Promise<AuctionRecord | undefined> {
  const { rows } = await tx.query<AuctionRow>(
    `UPDATE auctions SET
       slug                = COALESCE($2, slug),
       title               = COALESCE($3, title),
       description         = COALESCE($4, description),
       shipping_note       = CASE WHEN $5::boolean THEN $6::text ELSE shipping_note END,
       starts_at           = COALESCE($7::timestamptz, starts_at),
       ends_at             = COALESCE($8::timestamptz, ends_at),
       min_bid_minor       = COALESCE($9::bigint, min_bid_minor),
       max_bid_minor       = COALESCE($10::bigint, max_bid_minor),
       bid_increment_minor = COALESCE($11::bigint, bid_increment_minor),
       max_bids_per_user   = COALESCE($12::integer, max_bids_per_user),
       bid_fee_minor       = COALESCE($13::bigint, bid_fee_minor),
       winner_payment_hours = COALESCE($14::integer, winner_payment_hours)
     WHERE id = $1
     RETURNING ${AUCTION_COLUMNS.replace(/a\./g, '')}`,
    [
      id,
      changes.slug ?? null,
      changes.title ?? null,
      changes.description ?? null,
      changes.shippingNote !== undefined,
      changes.shippingNote ?? null,
      changes.startsAt ?? null,
      changes.endsAt ?? null,
      changes.minBidMinor?.toString() ?? null,
      changes.maxBidMinor?.toString() ?? null,
      changes.bidIncrementMinor?.toString() ?? null,
      changes.maxBidsPerUser ?? null,
      changes.bidFeeMinor?.toString() ?? null,
      changes.winnerPaymentHours ?? null,
    ],
  );
  return rows[0] ? toAuction(rows[0]) : undefined;
}

/**
 * Apply a status change and the bookkeeping that belongs with it.
 *
 * One statement per transition, with `WHERE status = $2` as a final guard: even
 * if two transactions somehow reached here with the same intent, only the one
 * that still sees the expected previous state updates a row. The caller treats
 * "no row" as "someone else already did it".
 */
export async function applyTransition(
  input: {
    id: string;
    expectedStatus: AuctionStatus;
    nextStatus: AuctionStatus;
    submittedAt?: Date | null | undefined;
    approvedBy?: string | null | undefined;
    approvedAt?: Date | null | undefined;
    rejectedAt?: Date | null | undefined;
    rejectionReason?: string | null | undefined;
    openedAt?: Date | null | undefined;
    closingAt?: Date | null | undefined;
    closedAt?: Date | null | undefined;
    suspendedAt?: Date | null | undefined;
    suspendedBy?: string | null | undefined;
    suspendReason?: string | null | undefined;
    suspendedFrom?: AuctionStatus | null | undefined;
    cancelledAt?: Date | null | undefined;
    cancelReason?: string | null | undefined;
    clearSuspension?: boolean | undefined;
  },
  tx: Tx,
): Promise<AuctionRecord | undefined> {
  const { rows } = await tx.query<AuctionRow>(
    `UPDATE auctions SET
       status           = $3,
       submitted_at     = CASE WHEN $4::boolean  THEN $5::timestamptz    ELSE submitted_at END,
       approved_by      = CASE WHEN $6::boolean  THEN $7::uuid           ELSE approved_by END,
       approved_at      = CASE WHEN $8::boolean  THEN $9::timestamptz    ELSE approved_at END,
       rejected_at      = CASE WHEN $10::boolean THEN $11::timestamptz   ELSE rejected_at END,
       rejection_reason = CASE WHEN $12::boolean THEN $13::text          ELSE rejection_reason END,
       opened_at        = CASE WHEN $14::boolean THEN $15::timestamptz   ELSE opened_at END,
       closing_at       = CASE WHEN $16::boolean THEN $17::timestamptz   ELSE closing_at END,
       closed_at        = CASE WHEN $18::boolean THEN $19::timestamptz   ELSE closed_at END,
       cancelled_at     = CASE WHEN $20::boolean THEN $21::timestamptz   ELSE cancelled_at END,
       cancel_reason    = CASE WHEN $22::boolean THEN $23::text          ELSE cancel_reason END,
       -- The four suspension columns move together: a CHECK requires all or none.
       suspended_at     = CASE WHEN $24::boolean THEN NULL WHEN $25::boolean THEN $26::timestamptz ELSE suspended_at END,
       suspended_by     = CASE WHEN $24::boolean THEN NULL WHEN $25::boolean THEN $27::uuid ELSE suspended_by END,
       suspend_reason   = CASE WHEN $24::boolean THEN NULL WHEN $25::boolean THEN $28::text ELSE suspend_reason END,
       suspended_from   = CASE WHEN $24::boolean THEN NULL WHEN $25::boolean THEN $29::auction_status ELSE suspended_from END
     WHERE id = $1 AND status = $2
     RETURNING ${AUCTION_COLUMNS.replace(/a\./g, '')}`,
    [
      input.id,
      input.expectedStatus,
      input.nextStatus,
      input.submittedAt !== undefined,
      input.submittedAt ?? null,
      input.approvedBy !== undefined,
      input.approvedBy ?? null,
      input.approvedAt !== undefined,
      input.approvedAt ?? null,
      input.rejectedAt !== undefined,
      input.rejectedAt ?? null,
      input.rejectionReason !== undefined,
      input.rejectionReason ?? null,
      input.openedAt !== undefined,
      input.openedAt ?? null,
      input.closingAt !== undefined,
      input.closingAt ?? null,
      input.closedAt !== undefined,
      input.closedAt ?? null,
      input.cancelledAt !== undefined,
      input.cancelledAt ?? null,
      input.cancelReason !== undefined,
      input.cancelReason ?? null,
      input.clearSuspension === true,
      input.suspendedAt !== undefined,
      input.suspendedAt ?? null,
      input.suspendedBy ?? null,
      input.suspendReason ?? null,
      input.suspendedFrom ?? null,
    ],
  );
  return rows[0] ? toAuction(rows[0]) : undefined;
}

/** Unfinished auctions already committed against a product. */
export async function countUnfinishedForProduct(
  input: { productId: string; excludeAuctionId?: string | undefined },
  tx?: Tx,
): Promise<number> {
  const { rows } = await runner(tx).query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM auctions
      WHERE product_id = $1
        AND ($2::uuid IS NULL OR id <> $2::uuid)
        AND status IN ('draft', 'pending_approval', 'scheduled', 'live', 'closing',
                       'calculating', 'suspended')`,
    [input.productId, input.excludeAuctionId ?? null],
  );
  return Number(rows[0]?.count ?? '0');
}

export async function slugExists(slug: string, tx?: Tx): Promise<boolean> {
  const { rows } = await runner(tx).query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM auctions WHERE slug = $1) AS exists`,
    [slug],
  );
  return rows[0]?.exists === true;
}

export interface AuctionPage {
  readonly auctions: AuctionWithDisplay[];
  readonly nextCursor: string | null;
}

/**
 * A page of auctions.
 *
 * Keyset pagination, consistent with the rest of the platform (wallet history,
 * product lists): an auction listing changes under a reader as auctions open
 * and close, and an offset would show one auction twice or skip another. The
 * cursor's shape depends on the sort, because the keyset must match the ORDER
 * BY to be stable.
 */
export async function list(
  filters: {
    statuses?: readonly AuctionStatus[] | undefined;
    categorySlug?: string | undefined;
    sellerId?: string | undefined;
    sort: AuctionSort;
    limit: number;
    cursor?: { value: Date; id: string } | undefined;
  },
  tx?: Tx,
): Promise<AuctionPage> {
  // The sort column is chosen from a closed set, never interpolated from input.
  const sortColumn = {
    ending_soon: 'a.ends_at',
    starting_soon: 'a.starts_at',
    newest: 'a.created_at',
  }[filters.sort];
  const direction = filters.sort === 'newest' ? 'DESC' : 'ASC';
  const comparison = direction === 'DESC' ? '<' : '>';

  const { rows } = await runner(tx).query<AuctionRow & DisplayRow>(
    `${AUCTION_SELECT}
      WHERE ($1::auction_status[] IS NULL OR a.status = ANY($1::auction_status[]))
        AND ($2::text IS NULL OR c.slug = $2::text)
        AND ($3::uuid IS NULL OR a.seller_id = $3::uuid)
        AND ($4::timestamptz IS NULL
             OR (${sortColumn}, a.id) ${comparison} ($4::timestamptz, $5::uuid))
      ORDER BY ${sortColumn} ${direction}, a.id ${direction}
      LIMIT $6`,
    [
      filters.statuses === undefined ? null : [...filters.statuses],
      filters.categorySlug ?? null,
      filters.sellerId ?? null,
      filters.cursor?.value ?? null,
      filters.cursor?.id ?? null,
      filters.limit + 1,
    ],
  );

  const auctions = rows.slice(0, filters.limit).map(toDisplay);
  const last = auctions[auctions.length - 1];
  if (rows.length <= filters.limit || !last) return { auctions, nextCursor: null };

  const sortValue = {
    ending_soon: last.endsAt,
    starting_soon: last.startsAt,
    newest: last.createdAt,
  }[filters.sort];
  return { auctions, nextCursor: `${sortValue.toISOString()}|${last.id}` };
}

/**
 * Auctions the database says are due to open or close.
 *
 * `now()` is evaluated by PostgreSQL, not by the worker: the database is the
 * clock of record, so a worker with a skewed clock cannot open an auction
 * early or leave one running past its deadline.
 */
export async function findDueToOpen(limit: number, tx?: Tx): Promise<string[]> {
  const { rows } = await runner(tx).query<{ id: string }>(
    `SELECT id FROM auctions
      WHERE status = 'scheduled' AND starts_at <= now()
      ORDER BY starts_at LIMIT $1`,
    [limit],
  );
  return rows.map((row) => row.id);
}

export async function findDueToClose(limit: number, tx?: Tx): Promise<string[]> {
  const { rows } = await runner(tx).query<{ id: string }>(
    `SELECT id FROM auctions
      WHERE status = 'live' AND ends_at <= now()
      ORDER BY ends_at LIMIT $1`,
    [limit],
  );
  return rows.map((row) => row.id);
}

/** The database's own clock, for decisions that must not trust the process. */
export async function databaseNow(tx?: Tx): Promise<Date> {
  const { rows } = await runner(tx).query<{ now: Date }>(`SELECT now() AS now`);
  return rows[0]!.now;
}
