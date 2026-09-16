import { describe, expect, it } from 'vitest';
import { ladderSize, validateAuctionConfig, type AuctionConfig } from './auctionService.js';

/**
 * Auction configuration rules, without a database.
 *
 * These are the rules a seller runs into, and the reason they exist is that a
 * configuration which looks reasonable can still be unbiddable — a range that
 * is not a whole number of increments publishes a maximum nobody can place.
 */
const VALID: AuctionConfig = {
  minBidMinor: 100n,
  maxBidMinor: 5000n,
  bidIncrementMinor: 100n,
  maxBidsPerUser: 25,
  bidFeeMinor: 500n,
  winnerPaymentHours: 48,
  startsAt: new Date('2026-10-01T00:00:00Z'),
  endsAt: new Date('2026-10-02T00:00:00Z'),
};

const refusal = (config: AuctionConfig): { code: string; message: string } => {
  try {
    validateAuctionConfig(config);
  } catch (error) {
    const app = error as { details?: { auctionError?: unknown }; publicMessage?: unknown };
    return {
      code: typeof app.details?.auctionError === 'string' ? app.details.auctionError : 'UNKNOWN',
      message: String(app.publicMessage),
    };
  }
  throw new Error('Expected the configuration to be refused, but it was accepted');
};

describe('a valid configuration', () => {
  it('is accepted', () => {
    expect(() => validateAuctionConfig(VALID)).not.toThrow();
  });

  it('accepts a free-to-enter auction', () => {
    // The participation fee may be zero; the database CHECK agrees.
    expect(() => validateAuctionConfig({ ...VALID, bidFeeMinor: 0n })).not.toThrow();
  });

  it('accepts a single-amount auction', () => {
    // min == max is a one-rung ladder, which is odd but not invalid.
    expect(() => validateAuctionConfig({ ...VALID, minBidMinor: 500n, maxBidMinor: 500n })).not.toThrow();
  });
});

describe('time', () => {
  it('refuses an auction that ends before it starts', () => {
    expect(refusal({ ...VALID, endsAt: new Date('2026-09-30T00:00:00Z') }).code).toBe(
      'INVALID_AUCTION_CONFIG',
    );
  });

  it('refuses a zero-length auction', () => {
    expect(refusal({ ...VALID, endsAt: VALID.startsAt }).code).toBe('INVALID_AUCTION_CONFIG');
  });
});

describe('the bid ladder', () => {
  it('refuses a maximum below the minimum', () => {
    expect(refusal({ ...VALID, maxBidMinor: 50n }).message).toMatch(/at least the minimum/);
  });

  /**
   * The rule worth having. 100–5050 in steps of 100 stops at 5000, so the
   * published 5050 is an amount no bidder could ever place.
   */
  it('refuses a range that is not a whole number of increments', () => {
    expect(refusal({ ...VALID, maxBidMinor: 5050n }).message).toMatch(/whole number of increments/);
  });

  it('refuses a non-positive minimum or increment', () => {
    expect(refusal({ ...VALID, minBidMinor: 0n }).code).toBe('INVALID_AUCTION_CONFIG');
    expect(refusal({ ...VALID, minBidMinor: -100n }).code).toBe('INVALID_AUCTION_CONFIG');
    expect(refusal({ ...VALID, bidIncrementMinor: 0n }).code).toBe('INVALID_AUCTION_CONFIG');
  });

  it('refuses a negative participation fee', () => {
    expect(refusal({ ...VALID, bidFeeMinor: -1n }).code).toBe('INVALID_AUCTION_CONFIG');
  });

  it('counts the amounts a bidder may choose from', () => {
    // 100..5000 in steps of 100 is fifty rungs.
    expect(ladderSize(VALID)).toBe(50n);
    expect(ladderSize({ minBidMinor: 500n, maxBidMinor: 500n, bidIncrementMinor: 100n })).toBe(1n);
  });

  /** Money is bigint, so a ladder far beyond 2^53 is still counted exactly. */
  it('handles amounts beyond a double', () => {
    const huge: AuctionConfig = {
      ...VALID,
      minBidMinor: 9_007_199_254_740_993n,
      maxBidMinor: 9_007_199_254_741_093n,
      bidIncrementMinor: 100n,
    };
    expect(() => validateAuctionConfig(huge)).not.toThrow();
    expect(ladderSize(huge)).toBe(2n);
  });
});

describe('bidder limits', () => {
  it('refuses an auction nobody may bid in', () => {
    expect(refusal({ ...VALID, maxBidsPerUser: 0 }).message).toMatch(/at least one bid/);
  });

  it('refuses a winner payment window of no time at all', () => {
    expect(refusal({ ...VALID, winnerPaymentHours: 0 }).message).toMatch(/at least an hour/);
  });
});
