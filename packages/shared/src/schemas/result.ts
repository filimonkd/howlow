import { z } from 'zod';
import { currencySchema, minorAmountSchema } from './common.js';
import { orderDtoSchema } from './order.js';

/**
 * Auction results, over the wire.
 *
 * ## What a result may say, and what it may not
 *
 * After an auction closes the winning amount is public — it is the answer the
 * whole auction was asking, and every bidder needs it to understand their own
 * outcome. What stays private is *everyone else*: no bidder is named but the
 * winner, and no payload carries a frequency table of who bid what. A bidder
 * learns whether **they** won and what the winning amount was, and nothing
 * more about the other players.
 *
 * Before the auction closes there is no result at all, so there is nothing to
 * leak: the uniqueness signal Phase 5 withholds stays withheld right up to the
 * moment the outcome is final.
 */

/** The four ways an auction can end. */
export const AUCTION_OUTCOMES = ['winner', 'no_unique_bid', 'no_bids', 'cancelled'] as const;
export const auctionOutcomeSchema = z.enum(AUCTION_OUTCOMES);
export type AuctionOutcome = (typeof AUCTION_OUTCOMES)[number];

/**
 * The one algorithm that decides a winner.
 *
 * Persisted with every result, so a stored result always says which rules
 * produced it. A future change of rules would be `LUB_V2` — a new version
 * alongside this one, never a redefinition of it, because results already
 * published were computed under these.
 */
export const ALGORITHM_LUB_V1 = 'LUB_V1';

/**
 * How the winner is chosen: **the lowest amount exactly one valid bid was
 * placed at.**
 *
 * Not the lowest bid. An amount five people chose is worth nothing; an amount
 * one person chose beats every higher lonely amount and every crowded lower
 * one.
 */
export const LUB_V1_RULE =
  'The winner is the lowest bid amount placed by exactly one bidder. If every amount was bid by two or more bidders, there is no winner.';

/**
 * Stable result-error codes, for both channels to map to their own wording.
 *
 * Short list by design: closing is a worker operation, and most of what could
 * go wrong is a state the service treats as "already done" rather than an
 * error. What remains means the data is not what the algorithm requires.
 */
export const RESULT_ERRORS = ['AUCTION_NOT_CLOSED', 'RESULT_NOT_FOUND', 'RESULT_INCONSISTENT'] as const;
export const resultErrorSchema = z.enum(RESULT_ERRORS);
export type ResultErrorCode = (typeof RESULT_ERRORS)[number];

/** Statistics frozen with the result, from the bid set it was computed over. */
export const resultStatisticsSchema = z.object({
  /** Every bid row, whatever its status. */
  totalBids: z.number().int().nonnegative(),
  /** The bids that actually took part: status `valid`. */
  totalValidBids: z.number().int().nonnegative(),
  /** Distinct bidders among those valid bids. */
  participantCount: z.number().int().nonnegative(),
  /** How many amounts exactly one bidder chose. Zero means no winner. */
  uniqueAmountCount: z.number().int().nonnegative(),
});

export type ResultStatisticsDto = z.infer<typeof resultStatisticsSchema>;

/**
 * An auction's result, as anyone may read it once the auction has closed.
 *
 * `winningAmountMinor` is present for a `winner` outcome and null otherwise.
 * There is deliberately no `winnerName`, no `winnerId` and no per-amount
 * breakdown: the winner is told privately through their own view, and nobody
 * is handed a map of the other bidders.
 */
export const auctionResultSchema = z.object({
  auctionId: z.uuid(),
  outcome: auctionOutcomeSchema,
  algorithmVersion: z.literal(ALGORITHM_LUB_V1),
  winningAmountMinor: minorAmountSchema.nullable(),
  currency: currencySchema,
  statistics: resultStatisticsSchema,
  /**
   * Digest of the frozen valid-bid set the result was computed from.
   *
   * Published on purpose: it lets a result be re-verified later without
   * exposing the bids themselves, which is the whole point of a checksum over
   * a private set.
   */
  checksum: z.string().length(64),
  computedAt: z.iso.datetime(),
});

export type AuctionResultDto = z.infer<typeof auctionResultSchema>;

/**
 * What a particular bidder learns about their own part in a closed auction.
 *
 * `won` is the only judgement made about the caller. `bidCount` and
 * `feesPaidMinor` are their own figures, and `refundedMinor` says what came
 * back when no unique bid existed. Nothing here describes another bidder.
 */
export const myAuctionOutcomeSchema = z.object({
  auctionId: z.uuid(),
  outcome: auctionOutcomeSchema,
  won: z.boolean(),
  /** The winning amount, once the auction has closed. Null when nobody won. */
  winningAmountMinor: minorAmountSchema.nullable(),
  currency: currencySchema,
  /** The caller's own participation. */
  bidCount: z.number().int().nonnegative(),
  feesPaidMinor: minorAmountSchema,
  /** Fees returned to the caller for this auction, if any. */
  refundedMinor: minorAmountSchema,
  /** The order awaiting payment, for the winner only. */
  order: orderDtoSchema.nullable(),
});

export type MyAuctionOutcomeDto = z.infer<typeof myAuctionOutcomeSchema>;

/**
 * Channel-neutral result events.
 *
 * Published once a result is final and durable. The website's socket layer and
 * the Telegram notifier each subscribe and decide what to do; nothing on this
 * path is specific to either, and nothing carries a bidder's identity except
 * the winner's own `AUCTION_WON`, which is addressed to them.
 */
export const RESULT_EVENTS = [
  'AUCTION_RESULT_READY',
  'AUCTION_WON',
  'AUCTION_NOT_WON',
  'AUCTION_NO_UNIQUE_BID',
  'AUCTION_NO_BIDS',
] as const;

export const resultEventSchema = z.object({
  event: z.enum(RESULT_EVENTS),
  auctionId: z.uuid(),
  outcome: auctionOutcomeSchema,
  /** Null for the outcomes that have no winning amount. */
  winningAmountMinor: minorAmountSchema.nullable(),
  currency: currencySchema,
  /**
   * The user this event concerns, for the addressed events (`AUCTION_WON`,
   * `AUCTION_NOT_WON`). Absent on the auction-wide ones.
   */
  userId: z.uuid().optional(),
  occurredAt: z.iso.datetime(),
});

export type ResultEvent = z.infer<typeof resultEventSchema>;

/**
 * The winner of a closed auction, or the fact that there was none.
 *
 * A pure function over amount counts, exported so the rule can be checked
 * without a database — see `lubCalculator` for the authoritative
 * implementation, which computes the same answer with SQL aggregation rather
 * than by loading bids. Kept in shared so a test, a script or a future
 * verification tool can restate the rule without importing the API.
 */
export function lowestUniqueAmount(
  counts: readonly { readonly amountMinor: bigint; readonly bidders: number }[],
): bigint | null {
  let lowest: bigint | null = null;
  for (const entry of counts) {
    if (entry.bidders !== 1) continue;
    if (lowest === null || entry.amountMinor < lowest) lowest = entry.amountMinor;
  }
  return lowest;
}
