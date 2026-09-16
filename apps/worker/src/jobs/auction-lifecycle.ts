import { close, findDueToClose, findDueToOpen, open } from '@howlow/api/modules/auctions';
import { Queue, Worker, type Job } from 'bullmq';
import { getQueueConnection } from '../queues/connection.js';
import { QUEUE_NAMES } from '../queues/index.js';
import { getLogger } from '../shared/logger.js';

/**
 * Auction opening and closing.
 *
 * ## The worker holds no lifecycle logic
 *
 * Both processors call the same `open` / `close` services the API and the
 * sweeper call. The rules about what an auction may do live in the lifecycle
 * service's transition table, and a second copy here would be a second set of
 * rules to keep in step.
 *
 * ## Idempotency
 *
 * Every job id is derived from the auction, so BullMQ itself refuses a
 * duplicate enqueue — re-approving an auction cannot stack a second opening.
 * And because the lifecycle service treats "already in the target state" as a
 * no-op, a job that runs twice anyway (a retry, or the sweeper racing the
 * scheduled job) produces one effect.
 *
 * ## The clock
 *
 * A delay is only a hint about *when* to look. The services re-read `now()`
 * from PostgreSQL and refuse to act early, so a worker whose own clock runs
 * fast cannot open an auction before its published start time. That is why a
 * job firing early is logged and dropped rather than retried into a loop.
 */
export interface AuctionJobData {
  readonly auctionId: string;
}

/**
 * Job ids are stable per auction, which is what makes enqueueing idempotent.
 *
 * Hyphen-separated rather than the `auction.open:<id>` the specification names,
 * because BullMQ refuses a custom job id containing a colon — it reserves the
 * character for its own key namespacing. The identity is the same; only the
 * separator differs.
 */
export const openJobId = (auctionId: string): string => `auction-open-${auctionId}`;
export const closeJobId = (auctionId: string): string => `auction-close-${auctionId}`;

/** Bounded so a clock skew cannot push a job years out. */
const MAX_DELAY_MS = 365 * 24 * 60 * 60 * 1000;

function delayFor(at: Date, now: Date): number {
  return Math.max(0, Math.min(at.getTime() - now.getTime(), MAX_DELAY_MS));
}

/**
 * Schedule an auction's opening and closing.
 *
 * Called when an auction becomes `scheduled`. Safe to call again: the fixed job
 * ids mean a repeat is ignored rather than doubled.
 */
export async function scheduleAuction(input: {
  auctionId: string;
  startsAt: Date;
  endsAt: Date;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const queue = new Queue<AuctionJobData>(QUEUE_NAMES.auctionLifecycle, {
    connection: getQueueConnection(),
  });
  try {
    await queue.add(
      'open',
      { auctionId: input.auctionId },
      {
        jobId: openJobId(input.auctionId),
        delay: delayFor(input.startsAt, now),
        removeOnComplete: 100,
        removeOnFail: 500,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      },
    );
    await queue.add(
      'close',
      { auctionId: input.auctionId },
      {
        jobId: closeJobId(input.auctionId),
        delay: delayFor(input.endsAt, now),
        removeOnComplete: 100,
        removeOnFail: 500,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      },
    );
    getLogger().info(
      {
        event: 'auction.scheduled',
        auctionId: input.auctionId,
        startsAt: input.startsAt.toISOString(),
        endsAt: input.endsAt.toISOString(),
      },
      'auction.scheduled',
    );
  } finally {
    await queue.close();
  }
}

export interface LifecycleJobResult {
  readonly auctionId: string;
  readonly status: string;
  readonly changed: boolean;
}

/**
 * `AUCTION_NOT_DUE` means the job fired before the database agrees it is time.
 * Retrying would just fire early again, so it is logged and the job succeeds;
 * the sweeper will pick the auction up once it really is due.
 */
function isNotDue(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('details' in error)) return false;
  return (error as { details?: { auctionError?: unknown } }).details?.auctionError === 'AUCTION_NOT_DUE';
}

export async function runOpen(auctionId: string): Promise<LifecycleJobResult> {
  const logger = getLogger();
  try {
    const result = await open({ auctionId, context: { channel: 'system' } });
    logger.info(
      {
        event: result.cancelledForInventory ? 'auction.cancelled' : 'auction.opened',
        auctionId,
        status: result.auction.status,
        changed: result.changed,
        cancelledForInventory: result.cancelledForInventory,
      },
      result.cancelledForInventory
        ? 'auction.open: cancelled, no product unit was available'
        : 'auction.opened',
    );
    return { auctionId, status: result.auction.status, changed: result.changed };
  } catch (error) {
    if (isNotDue(error)) {
      logger.warn({ auctionId }, 'auction.open: fired before the database says it is due');
      return { auctionId, status: 'scheduled', changed: false };
    }
    throw error;
  }
}

export async function runClose(auctionId: string): Promise<LifecycleJobResult> {
  const logger = getLogger();
  try {
    const result = await close({ auctionId, context: { channel: 'system' } });
    logger.info(
      { event: 'auction.closing', auctionId, status: result.auction.status, changed: result.changed },
      'auction.closing',
    );
    return { auctionId, status: result.auction.status, changed: result.changed };
  } catch (error) {
    if (isNotDue(error)) {
      logger.warn({ auctionId }, 'auction.close: fired before the database says it is due');
      return { auctionId, status: 'live', changed: false };
    }
    throw error;
  }
}

/**
 * Not async: registering a processor needs no round trip. Kept returning the
 * worker so the entrypoint treats every processor the same way.
 */
export function registerAuctionLifecycle(): Worker<AuctionJobData> {
  const connection = getQueueConnection();
  return new Worker<AuctionJobData>(
    QUEUE_NAMES.auctionLifecycle,
    async (job: Job<AuctionJobData>): Promise<LifecycleJobResult> =>
      job.name === 'open' ? runOpen(job.data.auctionId) : runClose(job.data.auctionId),
    // A handful at a time: each job is one short transaction, and the auction
    // row lock serialises anything that genuinely collides.
    { connection, concurrency: 5 },
  );
}

// ---------------------------------------------------------------------------
// The safety sweeper
// ---------------------------------------------------------------------------

/** How often the sweeper looks for auctions the scheduled jobs missed. */
export const SWEEPER_INTERVAL_MS = 30_000;
/** Bounded so one pass cannot monopolise the worker. */
const SWEEP_BATCH = 100;

export interface SweepResult {
  readonly opened: number;
  readonly closed: number;
  readonly examined: number;
  readonly failures: number;
}

/**
 * Repair missed executions.
 *
 * The queue is in Redis, which is explicitly not the source of truth: a flushed
 * Redis, a worker that was down at the wrong moment, or a delay that never
 * fired would otherwise leave an auction stuck. PostgreSQL knows which
 * auctions are due, so the sweeper asks it and calls **the same lifecycle
 * services** the scheduled jobs call.
 *
 * It holds no lifecycle logic of its own, which is what makes it safe to race
 * the scheduled job: whichever arrives second finds the work done.
 */
export async function runSweep(): Promise<SweepResult> {
  const logger = getLogger();
  const dueToOpen = await findDueToOpen(SWEEP_BATCH);
  const dueToClose = await findDueToClose(SWEEP_BATCH);

  let opened = 0;
  let closed = 0;
  let failures = 0;

  for (const auctionId of dueToOpen) {
    try {
      const result = await runOpen(auctionId);
      if (result.changed) opened += 1;
    } catch (error) {
      failures += 1;
      logger.error({ err: error, auctionId }, 'auction.sweeper: could not open a due auction');
    }
  }

  for (const auctionId of dueToClose) {
    try {
      const result = await runClose(auctionId);
      if (result.changed) closed += 1;
    } catch (error) {
      failures += 1;
      logger.error({ err: error, auctionId }, 'auction.sweeper: could not close a due auction');
    }
  }

  const result: SweepResult = {
    opened,
    closed,
    examined: dueToOpen.length + dueToClose.length,
    failures,
  };

  // Only a sweep that actually repaired something, or failed, is worth a line:
  // a healthy platform runs this every thirty seconds and finds nothing.
  if (opened > 0 || closed > 0 || failures > 0) {
    logger.info({ event: 'auction.swept', ...result }, 'auction.sweeper: repaired missed executions');
  } else {
    logger.debug({ event: 'auction.swept', ...result }, 'auction.sweeper: nothing due');
  }
  return result;
}

/**
 * Register the sweeper on its repeating schedule.
 *
 * A fixed scheduler id, so a restart re-registers the same sweep rather than
 * stacking a second one.
 */
export async function registerAuctionSweeper(): Promise<Worker> {
  const connection = getQueueConnection();

  const worker = new Worker(
    QUEUE_NAMES.auctionSweeper,
    async (): Promise<SweepResult> => runSweep(),
    // Strictly one at a time: two overlapping sweeps would do the same work
    // twice, and the lifecycle services would simply no-op the second — wasted
    // effort rather than a correctness problem, but wasted all the same.
    { connection, concurrency: 1 },
  );

  const queue = new Queue(QUEUE_NAMES.auctionSweeper, { connection });
  await queue.upsertJobScheduler(
    'auction.sweeper.periodic',
    { every: SWEEPER_INTERVAL_MS },
    { opts: { removeOnComplete: 10, removeOnFail: 50 } },
  );
  await queue.close();

  return worker;
}
