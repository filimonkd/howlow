import type { AuctionEvent, AuctionStatsEvent, ResultEvent } from '@howlow/shared';
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

/**
 * Result events.
 *
 * Published once a result is **committed**: the `auction_results` row exists,
 * the winner's order or the released unit exists, and the auction is
 * `completed`. Never from inside that transaction — a retried transaction
 * would announce a result twice, and a rolled-back one would announce a result
 * that does not exist.
 *
 * ## Why a channel of its own
 *
 * A closing auction publishes two different kinds of thing. `AUCTION_CLOSING`
 * is a status change and belongs with the rest of the lifecycle; the result is
 * an outcome, and its payload carries money and (for the addressed events) a
 * user id. Keeping them apart means a subscriber that only renders status
 * badges never receives a winning amount, and the one that notifies a winner
 * does not have to filter lifecycle traffic to find them.
 *
 * ## What is on the wire, and what is not
 *
 * `AUCTION_RESULT_READY`, `AUCTION_NO_UNIQUE_BID` and `AUCTION_NO_BIDS` are
 * auction-wide and carry no user at all. `AUCTION_WON` and `AUCTION_NOT_WON`
 * are addressed — they name the one user they concern — so a subscriber
 * delivers each to that user and nobody else. No event ever carries a losing
 * bidder's amounts, a list of participants or a distribution of amounts: the
 * winning amount is the answer the auction was asking and is public; every
 * other bid stays private after the close exactly as it was during it.
 *
 * Same at-most-once contract as the other two channels. The durable record is
 * the immutable `auction_results` row; this is fan-out, and it never throws.
 */
export const AUCTION_RESULT_CHANNEL = 'howlow:auction-results';

export async function publishResultEvent(event: ResultEvent): Promise<void> {
  try {
    await getRedis().publish(AUCTION_RESULT_CHANNEL, JSON.stringify(event));
  } catch (error) {
    getLogger().warn(
      { err: error, auctionId: event.auctionId, event: event.event },
      'Auction result could not be published; the result itself is committed',
    );
  }
}

/**
 * Publish a whole result fan-out, best effort.
 *
 * The events are published in order — the auction-wide one first, then the
 * addressed ones — so a listener that renders the auction before notifying
 * users sees them in the order it would choose. Each publish is independent
 * and none throws, so one unreachable moment cannot stop the rest.
 */
export async function publishResultEvents(events: readonly ResultEvent[]): Promise<void> {
  for (const event of events) {
    await publishResultEvent(event);
  }
}
