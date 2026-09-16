import { describe, expect, it } from 'vitest';
import { AppError } from '@howlow/shared';
import {
  assertAmountAllowed,
  assertAmountsAllowed,
  assertNoRepeats,
  ladderSize,
  parseAmounts,
  totalFee,
  type AuctionBidTerms,
} from './validation.js';

/**
 * The amount rules, without a database.
 *
 * These are the checks a bidder hits most often, and the ones where an
 * off-by-one would let through a bid the auction cannot price. The same
 * functions run again inside the transaction against the locked auction row,
 * so what is proven here is proven for both passes.
 */

/** 100..900 stepping by 100: nine rungs. */
const terms: AuctionBidTerms = {
  minBidMinor: 100n,
  maxBidMinor: 900n,
  bidIncrementMinor: 100n,
};

const bidCodeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (AppError.is(error)) return String(error.details?.['bidError']);
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('parseAmounts', () => {
  it('turns integer strings into bigints', () => {
    expect(parseAmounts(['100', '200', '900'])).toEqual([100n, 200n, 900n]);
  });

  it('accepts an amount far above what a double can hold', () => {
    // 2^53 + 1. A `number` would round this to 2^53 and the bid would be
    // stored as a different amount than the one submitted.
    expect(parseAmounts(['9007199254740993'])).toEqual([9007199254740993n]);
  });

  it.each([
    ['not-a-number', 'AMOUNT_INVALID'],
    ['', 'AMOUNT_INVALID'],
    ['-100', 'AMOUNT_INVALID'],
    ['0', 'AMOUNT_INVALID'],
    ['1.5', 'AMOUNT_INVALID'],
    ['1e3', 'AMOUNT_INVALID'],
    [' 100', 'AMOUNT_INVALID'],
    ['100 ', 'AMOUNT_INVALID'],
    // 20 digits: beyond BIGINT, so PostgreSQL would reject it. Refused here
    // with a 400 rather than reaching the database and surfacing as a 500.
    ['99999999999999999999', 'AMOUNT_INVALID'],
  ])('refuses %j', (raw, expected) => {
    expect(bidCodeOf(() => parseAmounts([raw]))).toBe(expected);
  });

  it('refuses more amounts than one request may carry', () => {
    const tooMany = Array.from({ length: 101 }, (_, index) => String(index + 1));
    expect(bidCodeOf(() => parseAmounts(tooMany))).toBe('TOO_MANY_AMOUNTS');
  });

  it('accepts exactly the maximum', () => {
    const atLimit = Array.from({ length: 100 }, (_, index) => String(index + 1));
    expect(parseAmounts(atLimit)).toHaveLength(100);
  });
});

describe('assertNoRepeats', () => {
  it('accepts distinct amounts', () => {
    expect(() => assertNoRepeats([100n, 200n, 300n])).not.toThrow();
  });

  it('refuses the whole request when an amount is repeated', () => {
    expect(bidCodeOf(() => assertNoRepeats([100n, 200n, 200n, 300n]))).toBe('DUPLICATE_AMOUNT');
  });

  it('names every repeated amount once, not once per repeat', () => {
    try {
      assertNoRepeats([100n, 100n, 100n, 200n, 200n]);
      throw new Error('expected a refusal');
    } catch (error) {
      if (!AppError.is(error)) throw error;
      expect(error.details?.['amountsMinor']).toEqual(['100', '200']);
    }
  });
});

describe('assertAmountAllowed', () => {
  it('accepts the minimum', () => {
    expect(() => assertAmountAllowed(100n, terms)).not.toThrow();
  });

  it('accepts the maximum', () => {
    expect(() => assertAmountAllowed(900n, terms)).not.toThrow();
  });

  it('accepts a rung in the middle', () => {
    expect(() => assertAmountAllowed(500n, terms)).not.toThrow();
  });

  it('refuses one minor unit below the minimum', () => {
    expect(bidCodeOf(() => assertAmountAllowed(99n, terms))).toBe('AMOUNT_OUT_OF_RANGE');
  });

  it('refuses one minor unit above the maximum', () => {
    expect(bidCodeOf(() => assertAmountAllowed(901n, terms))).toBe('AMOUNT_OUT_OF_RANGE');
  });

  it('refuses an amount in range but off the ladder', () => {
    expect(bidCodeOf(() => assertAmountAllowed(150n, terms))).toBe('AMOUNT_NOT_ALIGNED');
  });

  /**
   * Range is checked before alignment, so a wildly wrong amount gets the
   * message that explains the most.
   */
  it('reports range rather than alignment when both are wrong', () => {
    expect(bidCodeOf(() => assertAmountAllowed(5n, terms))).toBe('AMOUNT_OUT_OF_RANGE');
  });

  it('accepts every rung of an increment of 1', () => {
    const fine: AuctionBidTerms = { minBidMinor: 1n, maxBidMinor: 5n, bidIncrementMinor: 1n };
    for (const amount of [1n, 2n, 3n, 4n, 5n]) {
      expect(() => assertAmountAllowed(amount, fine)).not.toThrow();
    }
  });

  it('handles a single-rung auction where min equals max', () => {
    const only: AuctionBidTerms = { minBidMinor: 500n, maxBidMinor: 500n, bidIncrementMinor: 100n };
    expect(() => assertAmountAllowed(500n, only)).not.toThrow();
    expect(bidCodeOf(() => assertAmountAllowed(600n, only))).toBe('AMOUNT_OUT_OF_RANGE');
  });

  /** Alignment is relative to the minimum, not to zero. */
  it('measures alignment from the minimum', () => {
    const offset: AuctionBidTerms = { minBidMinor: 250n, maxBidMinor: 1250n, bidIncrementMinor: 500n };
    expect(() => assertAmountAllowed(750n, offset)).not.toThrow();
    expect(bidCodeOf(() => assertAmountAllowed(500n, offset))).toBe('AMOUNT_NOT_ALIGNED');
  });
});

describe('assertAmountsAllowed', () => {
  it('refuses the batch if any single amount is wrong', () => {
    expect(bidCodeOf(() => assertAmountsAllowed([100n, 200n, 250n], terms))).toBe('AMOUNT_NOT_ALIGNED');
  });
});

describe('ladderSize', () => {
  it('counts both endpoints', () => {
    expect(ladderSize(terms)).toBe(9);
  });

  it('is 1 when the range holds one amount', () => {
    expect(ladderSize({ minBidMinor: 5n, maxBidMinor: 5n, bidIncrementMinor: 1n })).toBe(1);
  });
});

describe('totalFee', () => {
  it('multiplies the per-bid fee by the batch size', () => {
    expect(totalFee(500n, 7)).toBe(3500n);
  });

  it('is zero for a free auction, however large the batch', () => {
    expect(totalFee(0n, 100)).toBe(0n);
  });

  it('stays exact at magnitudes a double would round', () => {
    // 100 bids at 9_007_199_254_740_993 minor units. The true product is
    // 900719925474099300; as a float it would come back as …3200.
    expect(totalFee(9007199254740993n, 100)).toBe(900719925474099300n);
  });
});
