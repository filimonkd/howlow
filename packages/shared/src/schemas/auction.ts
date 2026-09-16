import { z } from 'zod';
import { currencySchema, minorAmountSchema } from './common.js';
import { productImageSchema, productConditionSchema, slugSchema } from './catalog.js';

/**
 * Auction wire contracts.
 *
 * A public auction payload deliberately carries no information about who has
 * bid, how many bids exist, or whether any amount is currently unique.
 * Revealing any of that would let a bidder reverse-engineer the lowest unique
 * bid, which is the one thing the format depends on keeping private.
 */

/**
 * The auction lifecycle.
 *
 *   draft → pending_approval → scheduled → live → closing → calculating
 *         → completed
 *
 * `cancelled` and `suspended` are reachable from several states; see
 * `docs/auctions.md` for the full transition table, which the lifecycle
 * service enforces.
 */
export const AUCTION_STATUSES = [
  'draft',
  'pending_approval',
  'scheduled',
  'live',
  'closing',
  'calculating',
  'completed',
  'cancelled',
  'suspended',
] as const;

export const auctionStatusSchema = z.enum(AUCTION_STATUSES);
export type AuctionStatus = z.infer<typeof auctionStatusSchema>;

/** Statuses a member of the public may see in a listing. */
export const PUBLICLY_VISIBLE_STATUSES = [
  'scheduled',
  'live',
  'closing',
  'calculating',
  'completed',
] as const satisfies readonly AuctionStatus[];

/** True while an auction accepts bids. Phase 5 is what will act on this. */
export function acceptsBids(status: AuctionStatus): boolean {
  return status === 'live';
}

/** The auction terms a bidder is committing against. Immutable once live. */
export const auctionTermsSchema = z.object({
  currency: currencySchema,
  minBidMinor: minorAmountSchema,
  maxBidMinor: minorAmountSchema,
  bidIncrementMinor: minorAmountSchema,
  maxBidsPerUser: z.number().int().positive(),
  /** Charged per bid. The spec calls this the participation fee. */
  bidFeeMinor: minorAmountSchema,
  winnerPaymentHours: z.number().int().positive(),
});
export type AuctionTermsDto = z.infer<typeof auctionTermsSchema>;

export const auctionSummarySchema = z.object({
  id: z.uuid(),
  slug: slugSchema.nullable(),
  title: z.string(),
  status: auctionStatusSchema,
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  /** Seconds until the auction ends; negative once it has passed. */
  secondsRemaining: z.number().int(),
  sellerName: z.string(),
  categorySlug: slugSchema.nullable(),
  productTitle: z.string(),
  productCondition: productConditionSchema,
  retailPriceMinor: minorAmountSchema,
  primaryImage: productImageSchema.nullable(),
  terms: auctionTermsSchema,
});
export type AuctionSummaryDto = z.infer<typeof auctionSummarySchema>;

export const auctionDetailSchema = auctionSummarySchema.extend({
  description: z.string().nullable(),
  shippingNote: z.string().nullable(),
  productDescription: z.string().nullable(),
  productBrand: z.string().nullable(),
  productSpecs: z.record(z.string(), z.string()),
  images: z.array(productImageSchema),
  quantity: z.number().int().positive(),
  algorithmVersion: z.literal('LUB_V1'),
  openedAt: z.iso.datetime().nullable(),
  closedAt: z.iso.datetime().nullable(),
});
export type AuctionDetailDto = z.infer<typeof auctionDetailSchema>;

/** What the auction's own seller and staff additionally see. */
export const auctionAdminDetailSchema = auctionDetailSchema.extend({
  sellerId: z.uuid(),
  productId: z.uuid(),
  submittedAt: z.iso.datetime().nullable(),
  approvedAt: z.iso.datetime().nullable(),
  rejectedAt: z.iso.datetime().nullable(),
  rejectionReason: z.string().nullable(),
  suspendedAt: z.iso.datetime().nullable(),
  suspendReason: z.string().nullable(),
  cancelledAt: z.iso.datetime().nullable(),
  cancelReason: z.string().nullable(),
  inventoryReserved: z.boolean(),
});
export type AuctionAdminDetailDto = z.infer<typeof auctionAdminDetailSchema>;

// ---------------------------------------------------------------------------
// Creation and configuration
// ---------------------------------------------------------------------------

const positiveMinorAmount = minorAmountSchema.refine(
  (value) => !value.startsWith('-') && value !== '0',
  { message: 'Amount must be greater than zero' },
);
const nonNegativeMinorAmount = minorAmountSchema.refine((value) => !value.startsWith('-'), {
  message: 'Amount may not be negative',
});

/**
 * Cross-field auction rules, applied wherever a full or partial configuration
 * is supplied.
 *
 * The divisibility rule is the subtle one: if the range is not a whole number
 * of increments, the published maximum is an amount no bidder can actually
 * bid. The database refuses it too, so this is the friendly half of a rule
 * that is enforced either way.
 */
interface AuctionConfigFields {
  readonly minBidMinor?: string | undefined;
  readonly maxBidMinor?: string | undefined;
  readonly bidIncrementMinor?: string | undefined;
  readonly startsAt?: string | undefined;
  readonly endsAt?: string | undefined;
}

function checkAuctionConfig(config: AuctionConfigFields, ctx: z.RefinementCtx): void {
  if (
    config.startsAt !== undefined &&
    config.endsAt !== undefined &&
    Date.parse(config.endsAt) <= Date.parse(config.startsAt)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['endsAt'],
      message: 'The auction must end after it starts',
    });
  }

  if (
    config.minBidMinor === undefined ||
    config.maxBidMinor === undefined ||
    config.bidIncrementMinor === undefined
  ) {
    // A partial update supplying only some of the three is checked against the
    // stored auction by the service, which has the other values.
    return;
  }

  const min = BigInt(config.minBidMinor);
  const max = BigInt(config.maxBidMinor);
  const increment = BigInt(config.bidIncrementMinor);

  if (max < min) {
    ctx.addIssue({
      code: 'custom',
      path: ['maxBidMinor'],
      message: 'Maximum bid must be at least the minimum bid',
    });
    return;
  }
  if ((max - min) % increment !== 0n) {
    ctx.addIssue({
      code: 'custom',
      path: ['bidIncrementMinor'],
      message:
        'The bid range must be a whole number of increments, or the maximum bid would be unreachable',
    });
  }
}

export const createAuctionSchema = z
  .object({
    productId: z.uuid(),
    title: z.string().trim().min(5).max(200),
    slug: slugSchema.optional(),
    description: z.string().trim().min(20).max(10_000),
    shippingNote: z.string().trim().min(3).max(1000).optional(),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    minBidMinor: positiveMinorAmount,
    maxBidMinor: positiveMinorAmount,
    bidIncrementMinor: positiveMinorAmount,
    maxBidsPerUser: z.number().int().min(1).max(1000),
    /** May be zero: a free-to-enter auction is a legitimate configuration. */
    bidFeeMinor: nonNegativeMinorAmount,
    winnerPaymentHours: z.number().int().min(1).max(720).default(48),
    /** Always 1 for the MVP; multi-unit auctions are not implemented. */
    quantity: z.literal(1).default(1),
    currency: currencySchema.default('ETB'),
  })
  .superRefine(checkAuctionConfig);

export const updateAuctionSchema = z
  .object({
    title: z.string().trim().min(5).max(200).optional(),
    slug: slugSchema.optional(),
    description: z.string().trim().min(20).max(10_000).optional(),
    shippingNote: z.string().trim().min(3).max(1000).nullable().optional(),
    startsAt: z.iso.datetime().optional(),
    endsAt: z.iso.datetime().optional(),
    minBidMinor: positiveMinorAmount.optional(),
    maxBidMinor: positiveMinorAmount.optional(),
    bidIncrementMinor: positiveMinorAmount.optional(),
    maxBidsPerUser: z.number().int().min(1).max(1000).optional(),
    bidFeeMinor: nonNegativeMinorAmount.optional(),
    winnerPaymentHours: z.number().int().min(1).max(720).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'No changes supplied' })
  .superRefine(checkAuctionConfig);

/** A reason is mandatory wherever staff act against a seller's auction. */
export const auctionReasonSchema = z.object({
  reason: z.string().trim().min(8).max(500),
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export const AUCTION_SORTS = ['ending_soon', 'newest', 'starting_soon'] as const;
export const auctionSortSchema = z.enum(AUCTION_SORTS);
export type AuctionSort = z.infer<typeof auctionSortSchema>;

export const auctionListQuerySchema = z.object({
  status: auctionStatusSchema.optional(),
  categorySlug: slugSchema.optional(),
  sellerId: z.uuid().optional(),
  sort: auctionSortSchema.default('ending_soon'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(256).optional(),
});
export type AuctionListQuery = z.infer<typeof auctionListQuerySchema>;

export const auctionListSchema = z.object({
  auctions: z.array(auctionSummarySchema),
  nextCursor: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Lifecycle events
// ---------------------------------------------------------------------------

/**
 * Channel-neutral lifecycle events. The website consumes them over a socket
 * and Telegram notifications will consume them later; neither channel's
 * concerns appear here.
 */
export const AUCTION_EVENTS = [
  'AUCTION_SCHEDULED',
  'AUCTION_STARTED',
  'AUCTION_CLOSING',
  'AUCTION_SUSPENDED',
  'AUCTION_RESUMED',
  'AUCTION_CANCELLED',
] as const;

export const auctionEventSchema = z.object({
  event: z.enum(AUCTION_EVENTS),
  auctionId: z.uuid(),
  slug: slugSchema.nullable(),
  status: auctionStatusSchema,
  occurredAt: z.iso.datetime(),
});
export type AuctionEvent = z.infer<typeof auctionEventSchema>;
