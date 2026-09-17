import { z } from 'zod';
import { channelSchema, currencySchema, minorAmountSchema } from './common.js';

/**
 * Bid submission, over the wire.
 *
 * ## What is deliberately absent
 *
 * Nothing here — not in the request, not in any response, not in the realtime
 * payload — tells a client whether an amount is currently unique. That is the
 * whole game: HOWLOW awards the lowest bid nobody else matched, so a client
 * that could ask "is 27 taken?" would be handed the answer instead of playing.
 * The only pre-close status a bid has is `submitted`. Phase 6 decides `won`
 * and `not_winning` once the auction is closed.
 *
 * This is why the response carries amounts the caller already sent and no
 * per-amount commentary, and why the aggregate event carries counts and no
 * amounts.
 */

/** The maximum number of amounts one request may carry. */
export const MAX_BIDS_PER_REQUEST = 100;

/**
 * How many bids a user may place in one auction, when the auction does not say
 * otherwise. The auction's own `maxBidsPerUser` is authoritative; this is the
 * figure the platform configures by default.
 */
export const DEFAULT_MAX_BIDS_PER_USER = 100;

/**
 * A bid amount as it arrives: a positive integer string in minor units.
 *
 * Strings, not numbers, all the way to PostgreSQL. `Number` silently loses
 * precision above 2^53 and JSON has no integer type, so an amount that
 * arrived as a number could not be trusted to be the amount that was sent.
 */
export const bidAmountSchema = minorAmountSchema.refine((value) => !value.startsWith('-') && value !== '0', {
  message: 'A bid amount must be a positive number of minor units',
});

export const submitBidsSchema = z.object({
  /**
   * One or more amounts. A single bid is a batch of one — there is no separate
   * single-bid path, because two paths would be two engines.
   */
  amountsMinor: z
    .array(bidAmountSchema)
    .min(1, 'At least one amount is required')
    .max(MAX_BIDS_PER_REQUEST, `A request may carry at most ${String(MAX_BIDS_PER_REQUEST)} amounts`),
});

export type SubmitBidsRequest = z.infer<typeof submitBidsSchema>;

/**
 * The only bid statuses a client ever sees before an auction closes.
 *
 * `void` and `refunded` exist in the database for operational corrections;
 * they are not part of the pre-close vocabulary a bidder is shown.
 */
export const BID_VIEW_STATUSES = ['submitted', 'void', 'refunded'] as const;
export const bidViewStatusSchema = z.enum(BID_VIEW_STATUSES);
export type BidViewStatus = (typeof BID_VIEW_STATUSES)[number];

/** One accepted bid, as the caller sees their own. */
export const bidSchema = z.object({
  id: z.uuid(),
  amountMinor: minorAmountSchema,
  feeMinor: minorAmountSchema,
  currency: currencySchema,
  /** Provenance for the caller's own records. No rule depends on it. */
  channel: channelSchema,
  status: bidViewStatusSchema,
  submittedAt: z.iso.datetime(),
});

export type BidDto = z.infer<typeof bidSchema>;

/**
 * What a successful submission returns.
 *
 * `replayed` is true when this response is the stored answer to a request that
 * had already been processed under the same idempotency key — the caller's
 * retry changed nothing, which is exactly what it should mean.
 */
export const submitBidsResultSchema = z.object({
  auctionId: z.uuid(),
  bids: z.array(bidSchema),
  /** Fee actually charged for this request, across every bid in it. */
  totalFeeMinor: minorAmountSchema,
  currency: currencySchema,
  /** The caller's totals for this auction after the request. */
  bidCount: z.number().int().nonnegative(),
  bidsRemaining: z.number().int().nonnegative(),
  walletBalanceMinor: minorAmountSchema,
  replayed: z.boolean(),
  /** Server time at which the batch committed. The client's clock decides nothing. */
  submittedAt: z.iso.datetime(),
});

export type SubmitBidsResult = z.infer<typeof submitBidsResultSchema>;

/** The caller's own bids in one auction, with what they may still do. */
export const myBidsSchema = z.object({
  auctionId: z.uuid(),
  bids: z.array(bidSchema),
  bidCount: z.number().int().nonnegative(),
  maxBidsPerUser: z.number().int().positive(),
  bidsRemaining: z.number().int().nonnegative(),
  totalFeesMinor: minorAmountSchema,
  currency: currencySchema,
});

export type MyBidsDto = z.infer<typeof myBidsSchema>;

/**
 * Stable bid error codes, carried in `details.bidError`.
 *
 * Both channels map these to their own wording. They are part of the contract:
 * a client may branch on them, so they do not change meaning once shipped.
 */
export const BID_ERRORS = [
  'AUCTION_NOT_LIVE',
  'AUCTION_NOT_STARTED',
  'AUCTION_ENDED',
  'AMOUNT_OUT_OF_RANGE',
  'AMOUNT_NOT_ALIGNED',
  'AMOUNT_INVALID',
  'DUPLICATE_AMOUNT',
  'BID_LIMIT_EXCEEDED',
  'TOO_MANY_AMOUNTS',
  'INSUFFICIENT_FUNDS',
  'WALLET_FROZEN',
  'IDEMPOTENCY_CONFLICT',
  'IDEMPOTENCY_IN_PROGRESS',
  'BIDDER_NOT_ELIGIBLE',
  'RATE_LIMITED',
] as const;

export type BidErrorCode = (typeof BID_ERRORS)[number];

/**
 * Aggregate auction statistics, published after a bid batch commits.
 *
 * Counts only. Publishing an amount — or anything a client could difference
 * across two events to recover one — would leak the uniqueness signal the
 * whole design withholds.
 */
export const BID_EVENTS = ['AUCTION_STATS'] as const;

export const auctionStatsEventSchema = z.object({
  event: z.enum(BID_EVENTS),
  auctionId: z.uuid(),
  totalBids: z.number().int().nonnegative(),
  totalParticipants: z.number().int().nonnegative(),
  /** Database time, so every client counts down against the same clock. */
  serverTime: z.iso.datetime(),
});

export type AuctionStatsEvent = z.infer<typeof auctionStatsEventSchema>;

/**
 * Parse whitespace- or comma-separated amounts typed by a human.
 *
 * Lives in shared because Telegram accepts "1 3 7 11" in a chat message and
 * the website accepts the same paste into its amount box: one parser, so the
 * two channels cannot disagree about what a user typed. Returns minor-unit
 * strings for the same schema the HTTP body uses, and rejects rather than
 * rounds — a bid is money, and guessing at "3.5" would be inventing intent.
 */
export function parseAmountList(input: string): { amounts: string[] } | { error: string } {
  const tokens = input
    .split(/[\s,;]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  if (tokens.length === 0) return { error: 'No amounts found.' };
  if (tokens.length > MAX_BIDS_PER_REQUEST) {
    return { error: `That is more than ${String(MAX_BIDS_PER_REQUEST)} amounts.` };
  }

  const amounts: string[] = [];
  for (const token of tokens) {
    if (!/^\d{1,19}$/.test(token)) {
      // Currency-neutral: the platform runs three currencies and this parser
      // never sees which one the auction uses.
      return { error: `"${token}" is not a whole number.` };
    }
    if (/^0+$/.test(token)) return { error: 'A bid must be more than zero.' };
    // Leading zeros are the user's formatting, not a different number.
    amounts.push(token.replace(/^0+/, ''));
  }
  return { amounts };
}

/**
 * Amounts that appear more than once in one request.
 *
 * The duplicate rule is enforced by PostgreSQL, which is what makes it safe
 * under concurrency. This is the same rule applied early so a user gets a
 * precise message naming the amount instead of a constraint violation, and it
 * is checked again inside the transaction.
 */
export function duplicateAmounts(amounts: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const amount of amounts) {
    if (seen.has(amount)) repeated.add(amount);
    seen.add(amount);
  }
  return [...repeated];
}
