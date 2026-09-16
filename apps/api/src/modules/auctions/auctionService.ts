import type {
  AuctionAdminDetailDto,
  AuctionDetailDto,
  AuctionSort,
  AuctionStatus,
  AuctionSummaryDto,
  AuctionTermsDto,
  Currency,
  ProductImageDto,
} from '@howlow/shared';
import { AppError, PUBLICLY_VISIBLE_STATUSES, slugify } from '@howlow/shared';
import { withTransaction, type Tx } from '../../db/index.js';
import { writeAuditLog, type OperationContext } from '../../shared/index.js';
import * as catalog from '../catalog/index.js';
import {
  auctionNotFound,
  auctionNotOwned,
  auctionSlugTaken,
  auctionImmutable,
  invalidAuctionConfig,
  productAlreadyCommitted,
  productNotEligible,
} from './errors.js';
import * as repo from './auctionRepository.js';
import { termsAreLocked } from './transitions.js';
import type { AuctionRecord, AuctionWithDisplay } from './types.js';

/**
 * Auction creation, configuration and discovery.
 *
 * Status changes live in `lifecycle.ts`; this file never writes a status
 * except through the insert that creates a draft.
 */

/** A configuration the service must be able to validate as a whole. */
export interface AuctionConfig {
  readonly minBidMinor: bigint;
  readonly maxBidMinor: bigint;
  readonly bidIncrementMinor: bigint;
  readonly maxBidsPerUser: number;
  readonly bidFeeMinor: bigint;
  readonly winnerPaymentHours: number;
  readonly startsAt: Date;
  readonly endsAt: Date;
}

/**
 * Every auction term rule, in one place.
 *
 * The shared schema applies the same cross-field rules at the request boundary
 * so a caller gets a friendly refusal, and the database enforces the two that
 * matter most as CHECK constraints. This is the layer that has the *stored*
 * auction to hand, so it is the only one that can validate a partial edit:
 * changing only `maxBidMinor` still has to be checked against the increment
 * already stored.
 */
export function validateAuctionConfig(config: AuctionConfig): void {
  if (config.endsAt <= config.startsAt) {
    throw invalidAuctionConfig(
      `ends_at ${config.endsAt.toISOString()} is not after starts_at ${config.startsAt.toISOString()}`,
      'The auction must end after it starts.',
    );
  }
  if (config.minBidMinor <= 0n) {
    throw invalidAuctionConfig(
      'minimum bid must be greater than zero',
      'The minimum bid must be more than zero.',
    );
  }
  if (config.bidIncrementMinor <= 0n) {
    throw invalidAuctionConfig(
      'increment must be greater than zero',
      'The bid increment must be more than zero.',
    );
  }
  if (config.maxBidMinor < config.minBidMinor) {
    throw invalidAuctionConfig(
      'maximum bid is below the minimum bid',
      'The maximum bid must be at least the minimum bid.',
    );
  }
  // Without this the published maximum is an amount no bidder can reach.
  if ((config.maxBidMinor - config.minBidMinor) % config.bidIncrementMinor !== 0n) {
    throw invalidAuctionConfig(
      `range ${config.minBidMinor}–${config.maxBidMinor} is not a whole number of ${config.bidIncrementMinor} increments`,
      'The bid range must be a whole number of increments, or the highest bid would be unreachable.',
    );
  }
  if (config.bidFeeMinor < 0n) {
    throw invalidAuctionConfig(
      'participation fee may not be negative',
      'The participation fee cannot be negative.',
    );
  }
  if (config.maxBidsPerUser < 1) {
    throw invalidAuctionConfig(
      'max bids per user must be at least one',
      'Bidders must be allowed at least one bid.',
    );
  }
  if (config.winnerPaymentHours < 1) {
    throw invalidAuctionConfig(
      'winner payment window must be at least one hour',
      'The winner needs at least an hour to pay.',
    );
  }
}

/** How many distinct amounts a bidder may choose from. Useful context to log. */
export function ladderSize(
  config: Pick<AuctionConfig, 'minBidMinor' | 'maxBidMinor' | 'bidIncrementMinor'>,
): bigint {
  return (config.maxBidMinor - config.minBidMinor) / config.bidIncrementMinor + 1n;
}

/**
 * Check the product may carry another auction.
 *
 * Two things are refused: a product that is not sellable at all, and a product
 * whose free stock is already promised to other unfinished auctions. The second
 * check is advisory at creation time — the binding one happens under the
 * product lock when the auction opens — but catching it early means a seller
 * finds out now rather than when their auction silently cancels itself.
 */
async function assertProductEligible(
  input: { productId: string; sellerId: string; excludeAuctionId?: string | undefined },
  tx: Tx,
): Promise<void> {
  const product = await catalog.getOwnedProduct({ productId: input.productId, sellerId: input.sellerId }, tx);

  if (product.status !== 'active') {
    throw productNotEligible(`product is ${product.status}, not active`);
  }
  if (product.stockQuantity < 1) {
    throw productNotEligible('product has no stock');
  }

  const committed = await repo.countUnfinishedForProduct(
    { productId: product.id, excludeAuctionId: input.excludeAuctionId },
    tx,
  );
  const available = catalog.availableQuantity(product);
  if (committed >= available) {
    throw productAlreadyCommitted({
      productId: product.id,
      conflictingAuctions: committed,
      available,
    });
  }
}

/** A free auction slug, suffixed on collision the same way products are. */
async function resolveSlug(input: { desired: string | undefined; title: string }, tx: Tx): Promise<string> {
  if (input.desired !== undefined) {
    if (await repo.slugExists(input.desired, tx)) throw auctionSlugTaken(input.desired);
    return input.desired;
  }
  const base = slugify(input.title) || 'auction';
  for (let suffix = 0; suffix < 50; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}-${suffix + 1}`;
    if (!(await repo.slugExists(candidate, tx))) return candidate;
  }
  throw auctionSlugTaken(base);
}

export async function createAuction(input: {
  sellerId: string;
  actorUserId: string;
  productId: string;
  title: string;
  slug?: string | undefined;
  description: string;
  shippingNote?: string | undefined;
  currency: Currency;
  startsAt: Date;
  endsAt: Date;
  minBidMinor: bigint;
  maxBidMinor: bigint;
  bidIncrementMinor: bigint;
  maxBidsPerUser: number;
  bidFeeMinor: bigint;
  winnerPaymentHours: number;
  context?: OperationContext | undefined;
}): Promise<AuctionRecord> {
  validateAuctionConfig(input);

  return withTransaction(async (tx) => {
    await assertProductEligible({ productId: input.productId, sellerId: input.sellerId }, tx);
    const slug = await resolveSlug({ desired: input.slug, title: input.title }, tx);

    const auction = await repo.insert(
      {
        productId: input.productId,
        sellerId: input.sellerId,
        slug,
        title: input.title,
        description: input.description,
        shippingNote: input.shippingNote,
        currency: input.currency,
        bidFeeMinor: input.bidFeeMinor,
        minBidMinor: input.minBidMinor,
        maxBidMinor: input.maxBidMinor,
        bidIncrementMinor: input.bidIncrementMinor,
        maxBidsPerUser: input.maxBidsPerUser,
        winnerPaymentHours: input.winnerPaymentHours,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        createdBy: input.actorUserId,
      },
      tx,
    );

    await writeAuditLog(
      {
        action: 'auction.created',
        entityType: 'auction',
        entityId: auction.id,
        actorUserId: input.actorUserId,
        channel: input.context?.channel ?? 'web',
        requestId: input.context?.requestId,
        details: {
          sellerId: auction.sellerId,
          productId: auction.productId,
          slug: auction.slug,
          status: auction.status,
          startsAt: auction.startsAt.toISOString(),
          endsAt: auction.endsAt.toISOString(),
          minBidMinor: auction.minBidMinor.toString(),
          maxBidMinor: auction.maxBidMinor.toString(),
          bidIncrementMinor: auction.bidIncrementMinor.toString(),
          bidFeeMinor: auction.bidFeeMinor.toString(),
          ladderSize: ladderSize(auction).toString(),
        },
      },
      tx,
    );
    return auction;
  });
}

/**
 * Edit an auction that has not started.
 *
 * Once an auction is live its terms are what its bidders committed against, so
 * they are fixed — the database trigger refuses the write too, but refusing
 * here gives the caller a stable code instead of a constraint name. A partial
 * edit is validated against the stored values it does not change.
 */
export async function updateAuction(input: {
  auctionId: string;
  sellerId: string;
  actorUserId: string;
  changes: {
    title?: string | undefined;
    slug?: string | undefined;
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
  };
  context?: OperationContext | undefined;
}): Promise<AuctionRecord> {
  return withTransaction(async (tx) => {
    const before = await repo.lockById(input.auctionId, tx);
    if (!before) throw auctionNotFound(input.auctionId);
    if (before.sellerId !== input.sellerId) throw auctionNotOwned(before.id, input.sellerId);
    if (termsAreLocked(before.status)) throw auctionImmutable(before.id, before.status);

    // Merge the edit onto the stored auction, then validate the whole thing.
    validateAuctionConfig({
      minBidMinor: input.changes.minBidMinor ?? before.minBidMinor,
      maxBidMinor: input.changes.maxBidMinor ?? before.maxBidMinor,
      bidIncrementMinor: input.changes.bidIncrementMinor ?? before.bidIncrementMinor,
      maxBidsPerUser: input.changes.maxBidsPerUser ?? before.maxBidsPerUser,
      bidFeeMinor: input.changes.bidFeeMinor ?? before.bidFeeMinor,
      winnerPaymentHours: input.changes.winnerPaymentHours ?? before.winnerPaymentHours,
      startsAt: input.changes.startsAt ?? before.startsAt,
      endsAt: input.changes.endsAt ?? before.endsAt,
    });

    if (input.changes.slug !== undefined && input.changes.slug !== before.slug) {
      if (await repo.slugExists(input.changes.slug, tx)) throw auctionSlugTaken(input.changes.slug);
    }

    const updated = await repo.updateTerms(before.id, input.changes, tx);
    if (!updated) throw auctionNotFound(before.id);

    await writeAuditLog(
      {
        action: 'auction.updated',
        entityType: 'auction',
        entityId: updated.id,
        actorUserId: input.actorUserId,
        channel: input.context?.channel ?? 'web',
        requestId: input.context?.requestId,
        before: {
          status: before.status,
          minBidMinor: before.minBidMinor.toString(),
          maxBidMinor: before.maxBidMinor.toString(),
          endsAt: before.endsAt.toISOString(),
        },
        details: {
          changed: Object.keys(input.changes),
          minBidMinor: updated.minBidMinor.toString(),
          maxBidMinor: updated.maxBidMinor.toString(),
          endsAt: updated.endsAt.toISOString(),
        },
      },
      tx,
    );
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getAuction(auctionId: string): Promise<AuctionWithDisplay> {
  const auction = await repo.findById(auctionId);
  if (!auction) throw auctionNotFound(auctionId);
  return auction;
}

/**
 * An auction by uuid or slug.
 *
 * Both are public references, so a link may carry either and neither exposes a
 * sequential internal id.
 */
export async function getAuctionByReference(reference: string): Promise<AuctionWithDisplay> {
  const auction =
    (await repo.findById(reference).catch(() => undefined)) ?? (await repo.findBySlug(reference));
  if (!auction) throw auctionNotFound(reference);
  return auction;
}

/**
 * An auction as a member of the public may see it.
 *
 * `getAuctionByReference` deliberately does not filter by status — staff and
 * the owning seller need to read a draft — so the public path must, and it
 * refuses with NOT_FOUND rather than FORBIDDEN so the response does not
 * confirm that an unpublished auction exists at that address.
 *
 * Without this, a draft's terms, seller and product were readable by anyone who
 * knew or guessed its id or slug, which an HTTP probe of the real endpoint is
 * what caught.
 */
export async function getPublicAuction(reference: string): Promise<AuctionWithDisplay> {
  const auction = await getAuctionByReference(reference);
  if (!(PUBLICLY_VISIBLE_STATUSES as readonly AuctionStatus[]).includes(auction.status)) {
    throw auctionNotFound(reference);
  }
  return auction;
}

export async function getOwnedAuction(input: {
  auctionId: string;
  sellerId: string;
}): Promise<AuctionWithDisplay> {
  const auction = await getAuction(input.auctionId);
  if (auction.sellerId !== input.sellerId) throw auctionNotOwned(auction.id, input.sellerId);
  return auction;
}

export interface AuctionListResult {
  readonly auctions: AuctionWithDisplay[];
  readonly nextCursor: string | null;
}

/**
 * Public discovery.
 *
 * Draft, pending and suspended auctions are never listed publicly: a draft is
 * not an offer, and a suspended auction is under review. Passing a status
 * outside the public set narrows within it rather than widening past it, so a
 * crafted query cannot reveal an unpublished auction.
 */
export async function listPublicAuctions(filters: {
  status?: AuctionStatus | undefined;
  categorySlug?: string | undefined;
  sellerId?: string | undefined;
  sort: AuctionSort;
  limit: number;
  cursor?: string | undefined;
}): Promise<AuctionListResult> {
  const visible: readonly AuctionStatus[] = PUBLICLY_VISIBLE_STATUSES;
  const statuses =
    filters.status === undefined ? visible : visible.includes(filters.status) ? [filters.status] : [];

  // A status outside the public set matches nothing rather than everything.
  if (statuses.length === 0) return { auctions: [], nextCursor: null };

  return repo.list({
    statuses,
    categorySlug: filters.categorySlug,
    sellerId: filters.sellerId,
    sort: filters.sort,
    limit: filters.limit,
    cursor: decodeCursor(filters.cursor),
  });
}

/** A seller's or staff member's view, which may include unpublished auctions. */
export async function listAuctionsForOwner(filters: {
  sellerId?: string | undefined;
  status?: AuctionStatus | undefined;
  sort: AuctionSort;
  limit: number;
  cursor?: string | undefined;
}): Promise<AuctionListResult> {
  return repo.list({
    statuses: filters.status === undefined ? undefined : [filters.status],
    sellerId: filters.sellerId,
    sort: filters.sort,
    limit: filters.limit,
    cursor: decodeCursor(filters.cursor),
  });
}

/** The approval queue, oldest submission first. */
export async function listPendingApproval(filters: {
  limit: number;
  cursor?: string | undefined;
}): Promise<AuctionListResult> {
  return repo.list({
    statuses: ['pending_approval'],
    sort: 'newest',
    limit: filters.limit,
    cursor: decodeCursor(filters.cursor),
  });
}

/**
 * Cursors are an opaque `<sort value>|<id>` pair, matching the ORDER BY of the
 * sort they were issued for.
 */
export function encodeCursor(cursor: string): string {
  return Buffer.from(cursor, 'utf8').toString('base64url');
}

/**
 * The timestamp half stays a string and is never parsed into a `Date`: a
 * `Date` holds milliseconds where `timestamptz` holds microseconds, and a
 * cursor rounded to the millisecond skips the rows that share it — or, in an
 * ascending sort, returns them for ever. The repository renders it at full
 * precision and compares it as `$n::timestamptz`.
 */
const CURSOR_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const CURSOR_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function decodeCursor(value: string | undefined): { value: string; id: string } | undefined {
  if (value === undefined) return undefined;
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  const [timestamp, id] = decoded.split('|');
  // A cursor is client-supplied. Rejecting it here keeps an unparseable
  // timestamp from reaching `::timestamptz` and surfacing as a 500.
  if (
    timestamp === undefined ||
    !CURSOR_TIMESTAMP_RE.test(timestamp) ||
    id === undefined ||
    !CURSOR_ID_RE.test(id)
  ) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'Malformed auction pagination cursor',
      publicMessage: 'That page cursor is not valid.',
    });
  }
  return { value: timestamp, id };
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

const toTerms = (auction: AuctionRecord): AuctionTermsDto => ({
  currency: auction.currency,
  minBidMinor: auction.minBidMinor.toString(),
  maxBidMinor: auction.maxBidMinor.toString(),
  bidIncrementMinor: auction.bidIncrementMinor.toString(),
  maxBidsPerUser: auction.maxBidsPerUser,
  bidFeeMinor: auction.bidFeeMinor.toString(),
  winnerPaymentHours: auction.winnerPaymentHours,
});

/**
 * Seconds until the auction ends, computed server-side.
 *
 * The countdown a page shows is anchored to this rather than to the browser's
 * clock: the database decides when an auction closes, and a viewer whose clock
 * is wrong should still see the right remaining time.
 */
function secondsRemaining(endsAt: Date, now: Date): number {
  return Math.trunc((endsAt.getTime() - now.getTime()) / 1000);
}

export function toSummaryDto(
  auction: AuctionWithDisplay,
  images: readonly ProductImageDto[],
  now: Date = new Date(),
): AuctionSummaryDto {
  return {
    id: auction.id,
    slug: auction.slug,
    title: auction.title,
    status: auction.status,
    startsAt: auction.startsAt.toISOString(),
    endsAt: auction.endsAt.toISOString(),
    secondsRemaining: secondsRemaining(auction.endsAt, now),
    sellerName: auction.sellerName,
    categorySlug: auction.categorySlug,
    productTitle: auction.productTitle,
    productCondition: auction.productCondition,
    retailPriceMinor: auction.retailPriceMinor.toString(),
    primaryImage: images.find((image) => image.isPrimary) ?? images[0] ?? null,
    terms: toTerms(auction),
  };
}

export function toDetailDto(
  auction: AuctionWithDisplay,
  images: readonly ProductImageDto[],
  now: Date = new Date(),
): AuctionDetailDto {
  return {
    ...toSummaryDto(auction, images, now),
    description: auction.description,
    shippingNote: auction.shippingNote,
    productDescription: auction.productDescription,
    productBrand: auction.productBrand,
    productSpecs: auction.productSpecs,
    images: [...images],
    quantity: auction.quantity,
    algorithmVersion: 'LUB_V1',
    openedAt: auction.openedAt?.toISOString() ?? null,
    closedAt: auction.closedAt?.toISOString() ?? null,
  };
}

/** The seller's and staff view: approval history and inventory state as well. */
export function toAdminDetailDto(
  auction: AuctionWithDisplay,
  images: readonly ProductImageDto[],
  inventoryReserved: boolean,
  now: Date = new Date(),
): AuctionAdminDetailDto {
  return {
    ...toDetailDto(auction, images, now),
    sellerId: auction.sellerId,
    productId: auction.productId,
    submittedAt: auction.submittedAt?.toISOString() ?? null,
    approvedAt: auction.approvedAt?.toISOString() ?? null,
    rejectedAt: auction.rejectedAt?.toISOString() ?? null,
    rejectionReason: auction.rejectionReason,
    suspendedAt: auction.suspendedAt?.toISOString() ?? null,
    suspendReason: auction.suspendReason,
    cancelledAt: auction.cancelledAt?.toISOString() ?? null,
    cancelReason: auction.cancelReason,
    inventoryReserved,
  };
}

/** Load the images an auction's product carries, as DTOs with fresh URLs. */
export async function imagesForAuction(auction: AuctionWithDisplay): Promise<ProductImageDto[]> {
  const product = await catalog.getProduct(auction.productId);
  return product.images.map(catalog.toImageDto);
}
