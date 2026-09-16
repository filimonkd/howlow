import { describe, expect, it } from 'vitest';
import { closeJobId, openJobId, SWEEPER_INTERVAL_MS } from './auction-lifecycle.js';

/**
 * Job identity and scheduling constraints.
 *
 * The colon rule is here because BullMQ rejected `auction.open:<id>` at
 * runtime — it reserves the character for its own key namespacing — and that
 * failure only appeared when a job was actually enqueued.
 */
describe('job ids', () => {
  const auctionId = '11111111-1111-4111-8111-111111111111';

  it('is stable for an auction, which is what makes enqueueing idempotent', () => {
    expect(openJobId(auctionId)).toBe(openJobId(auctionId));
    expect(closeJobId(auctionId)).toBe(closeJobId(auctionId));
  });

  it('distinguishes opening from closing, and one auction from another', () => {
    const other = '22222222-2222-4222-8222-222222222222';
    const ids = new Set([openJobId(auctionId), closeJobId(auctionId), openJobId(other), closeJobId(other)]);
    expect(ids.size).toBe(4);
  });

  /** BullMQ refuses a custom job id containing a colon. */
  it('contains no character BullMQ reserves', () => {
    for (const id of [openJobId(auctionId), closeJobId(auctionId)]) {
      expect(id).not.toContain(':');
      expect(id).toMatch(/^auction-(open|close)-[0-9a-f-]{36}$/);
    }
  });
});

describe('the sweeper interval', () => {
  it('is frequent enough to repair a missed transition promptly', () => {
    // The specification asks for roughly every thirty seconds: long enough not
    // to poll the database pointlessly, short enough that a missed scheduled
    // job is not visible to a bidder for long.
    expect(SWEEPER_INTERVAL_MS).toBe(30_000);
  });
});
