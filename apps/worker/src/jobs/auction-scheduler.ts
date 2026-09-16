import { AUCTION_EVENT_CHANNEL } from '@howlow/api/events';
import { findLiveAhead, findScheduledAhead } from '@howlow/api/modules/auctions';
import { auctionEventSchema } from '@howlow/shared';
import type { Redis } from 'ioredis';
import { getQueueConnection } from '../queues/connection.js';
import { getLogger } from '../shared/logger.js';
import { scheduleAuction } from './auction-lifecycle.js';

/**
 * Turning lifecycle events into precisely-timed jobs.
 *
 * The API cannot enqueue these itself — the worker depends on the API, not the
 * other way round — so it publishes a channel-neutral `AUCTION_SCHEDULED`
 * event and this subscriber schedules the work.
 *
 * ## Why a missed event is not a correctness problem
 *
 * Redis pub/sub is at-most-once, and Redis is explicitly not the source of
 * truth. If this subscriber is down when an auction is approved, no precise
 * job is created — and the sweeper opens the auction within its interval
 * because PostgreSQL still knows it is due. The scheduled job is a
 * *latency* optimisation over the sweeper, not the mechanism the platform's
 * correctness rests on.
 *
 * On boot, every auction that is already scheduled or live is re-enqueued, so
 * a worker that was down while approvals happened catches up rather than
 * leaving those auctions to the sweeper's coarser timing. The fixed job ids
 * make that safe to repeat.
 */
const CATCH_UP_LIMIT = 500;

export async function catchUpSchedules(): Promise<{ scheduled: number; live: number }> {
  const [ahead, live] = await Promise.all([
    findScheduledAhead(CATCH_UP_LIMIT),
    findLiveAhead(CATCH_UP_LIMIT),
  ]);

  for (const auction of [...ahead, ...live]) {
    await scheduleAuction({
      auctionId: auction.id,
      startsAt: auction.startsAt,
      endsAt: auction.endsAt,
    });
  }

  if (ahead.length > 0 || live.length > 0) {
    getLogger().info(
      { event: 'auction.schedules_restored', scheduled: ahead.length, live: live.length },
      'auction.scheduler: re-enqueued jobs for auctions already in flight',
    );
  }
  return { scheduled: ahead.length, live: live.length };
}

/**
 * Subscribe to lifecycle events.
 *
 * A dedicated connection: a Redis client in subscriber mode cannot run ordinary
 * commands, and the queue connection needs to.
 */
export async function subscribeToLifecycleEvents(): Promise<Redis> {
  const logger = getLogger();
  const subscriber = getQueueConnection().duplicate();

  subscriber.on('message', (_channel: string, payload: string) => {
    void (async () => {
      // The payload is validated rather than trusted: anything else on the
      // channel is ignored instead of crashing the subscriber.
      const parsed = auctionEventSchema.safeParse(JSON.parse(payload));
      if (!parsed.success) {
        logger.warn({ payload }, 'auction.scheduler: ignoring an unrecognised lifecycle event');
        return;
      }
      const event = parsed.data;
      if (event.event !== 'AUCTION_SCHEDULED') return;

      // The event carries no times, so they are read from the database — the
      // clock of record — rather than from the message.
      const scheduled = await findScheduledAhead(CATCH_UP_LIMIT);
      const match = scheduled.find((auction) => auction.id === event.auctionId);
      if (!match) {
        logger.debug(
          { auctionId: event.auctionId },
          'auction.scheduler: auction is no longer scheduled ahead; leaving it to the sweeper',
        );
        return;
      }
      await scheduleAuction({
        auctionId: match.id,
        startsAt: match.startsAt,
        endsAt: match.endsAt,
      });
    })().catch((error: unknown) => {
      logger.error({ err: error }, 'auction.scheduler: could not schedule from a lifecycle event');
    });
  });

  await subscriber.subscribe(AUCTION_EVENT_CHANNEL);
  logger.info({ channel: AUCTION_EVENT_CHANNEL }, 'auction.scheduler: subscribed to lifecycle events');
  return subscriber;
}
