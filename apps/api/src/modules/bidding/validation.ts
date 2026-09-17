import { MAX_BIDS_PER_REQUEST } from '@howlow/shared';
import {
  amountInvalid,
  amountNotAligned,
  amountOutOfRange,
  duplicateAmount,
  tooManyAmounts,
} from './errors.js';

/**
 * Amount rules, as pure functions.
 *
 * Separated from the service so they are testable without a database, and
 * because they are the part of the engine most worth reading in one piece.
 * Every one of them is applied again inside the transaction against the
 * auction row the engine holds locked: these same functions, the same inputs,
 * but terms read under the lock rather than terms read a moment earlier. A
 * seller cannot change the terms of a live auction, but an auction can close
 * between the two, and the locked read is the one that decides.
 *
 * All arithmetic is `bigint`. No amount is ever converted to `number`: money
 * above 2^53 would round, and a bid is money.
 */

export interface AuctionBidTerms {
  readonly minBidMinor: bigint;
  readonly maxBidMinor: bigint;
  readonly bidIncrementMinor: bigint;
}

/**
 * Parse the amounts as they arrived.
 *
 * The transport schema has already checked the shape; this is the boundary
 * where strings become `bigint`, and it refuses rather than coerces. A
 * malformed amount reaching PostgreSQL would surface as a 500, so it is
 * rejected here with a 400 that names the value.
 */
export function parseAmounts(amountsMinor: readonly string[]): bigint[] {
  if (amountsMinor.length > MAX_BIDS_PER_REQUEST) {
    throw tooManyAmounts(amountsMinor.length, MAX_BIDS_PER_REQUEST);
  }

  const parsed: bigint[] = [];
  for (const raw of amountsMinor) {
    if (!/^\d{1,19}$/.test(raw)) throw amountInvalid(raw);
    const amount = BigInt(raw);
    if (amount <= 0n) throw amountInvalid(raw);
    parsed.push(amount);
  }
  return parsed;
}

/**
 * Reject a request that asks for the same amount twice.
 *
 * The whole request fails. Accepting three of four amounts would leave the
 * client unable to say what it holds without re-reading, and would charge a
 * fee for a submission the user did not make.
 */
export function assertNoRepeats(amountsMinor: readonly bigint[]): void {
  const seen = new Set<bigint>();
  const repeated: bigint[] = [];
  for (const amount of amountsMinor) {
    if (seen.has(amount) && !repeated.includes(amount)) repeated.push(amount);
    seen.add(amount);
  }
  if (repeated.length > 0) throw duplicateAmount(repeated);
}

/**
 * One amount against the auction's ladder.
 *
 * Valid amounts are `min`, `min + increment`, `min + 2·increment`, … up to and
 * including `max`. The auction's own configuration guarantees
 * `(max - min) % increment = 0`, so `max` is always on the ladder.
 */
export function assertAmountAllowed(amountMinor: bigint, terms: AuctionBidTerms): void {
  if (amountMinor < terms.minBidMinor || amountMinor > terms.maxBidMinor) {
    throw amountOutOfRange(amountMinor, terms.minBidMinor, terms.maxBidMinor);
  }
  if ((amountMinor - terms.minBidMinor) % terms.bidIncrementMinor !== 0n) {
    throw amountNotAligned(amountMinor, terms.minBidMinor, terms.bidIncrementMinor);
  }
}

/** Every amount in the batch, against the ladder. */
export function assertAmountsAllowed(amountsMinor: readonly bigint[], terms: AuctionBidTerms): void {
  for (const amount of amountsMinor) assertAmountAllowed(amount, terms);
}

/**
 * How many amounts the ladder holds.
 *
 * A user cannot hold more distinct valid bids than there are rungs, so this
 * bounds what the bid limit can usefully be. Returned as `number` because it
 * is a count of rungs, not money — and callers compare it against
 * `maxBidsPerUser`, which is an integer column.
 */
export function ladderSize(terms: AuctionBidTerms): number {
  return Number((terms.maxBidMinor - terms.minBidMinor) / terms.bidIncrementMinor) + 1;
}

/**
 * The fee for a batch.
 *
 * Multiplication in `bigint`, so a hundred bids at a large fee cannot overflow
 * into a float. A zero fee yields zero, and the caller skips the wallet
 * entirely — the ledger records movements of money, and a zero-value entry
 * would be a record of nothing.
 */
export function totalFee(feePerBidMinor: bigint, bidCount: number): bigint {
  return feePerBidMinor * BigInt(bidCount);
}
