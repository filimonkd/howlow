import type { AuctionEvent, AuctionStatsEvent } from '@howlow/shared';
import { getRedis } from '../db/index.js';
import { getLogger } from '../shared/logger.js';

/**
 * Channel-neutral lifecycle events.
 *
 * An auction starting or closing is a fact about the auction, not about any
 * channel. The event carries no rendering, no chat ids and no socket details:
 * the website's socket layer and the Telegram notifier each subscribe and
 * decide for themselves what to do with it. Nothing Telegram-specific belongs
 * on this path.
 *
 * ## Why Redis, and what it is not
 *
 * This is fan-out, not truth. The durable record of every transition is the
 * `audit_logs` row the lifecycle service writes inside the transaction that
 * made the transition; this publish happens *after* that transaction commits
 * and is allowed to fail. A dropped notification means a page updates a few
 * seconds later, when it next polls — it can never mean an auction is in a
 * state the database disagrees with, which is exactly the boundary the
 * "Redis is never the source of truth" rule draws.
 *
 * Delivery is therefore at-most-once. Phase 11 owns guaranteed notification
 * delivery and can add an outbox table when it needs one; putting one here
 * would be building that phase early.
 */
export const AUCTION_EVENT_CHANNEL = 'howlow:auctions';

/**
 * Publish one lifecycle event.
 *
 * Never throws. A lifecycle transition that has already committed must not be
 * reported as failed because a cache was briefly unreachable, and the caller
 * has no useful recovery to perform.
 */
export async function publishAuctionEvent(event: AuctionEvent): Promise<void> {
  try {
    await getRedis().publish(AUCTION_EVENT_CHANNEL, JSON.stringify(event));
  } catch (error) {
    getLogger().warn(
      { err: error, event: event.event, auctionId: event.auctionId },
      'Lifecycle event could not be published; the transition itself is committed',
    );
  }
}

/**
 * Aggregate auction statistics, after a bid batch commits.
 *
 * Its own channel, so a subscriber that wants lifecycle transitions is not
 * woken by every bid on a busy auction, and a bid-stats subscriber does not
 * have to filter.
 *
 * **Counts only.** No amount, no bid id, no user — and that is a correctness
 * property, not a payload preference: HOWLOW awards the lowest unmatched bid,
 * so a listener who could see amounts (or difference two events to recover
 * one) would be handed the answer. `totalBids` and `totalParticipants` reveal
 * how busy an auction is, which every bidder may know.
 *
 * Same at-most-once contract as lifecycle events: the durable record is the
 * committed rows, this is fan-out, and it never throws.
 */
export const AUCTION_STATS_CHANNEL = 'howlow:auction-stats';

export async function publishAuctionStats(event: AuctionStatsEvent): Promise<void> {
  try {
    await getRedis().publish(AUCTION_STATS_CHANNEL, JSON.stringify(event));
  } catch (error) {
    getLogger().warn(
      { err: error, auctionId: event.auctionId },
      'Auction stats could not be published; the bids themselves are committed',
    );
  }
}
