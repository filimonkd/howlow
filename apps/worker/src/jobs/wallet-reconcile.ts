import { reconcileAllWallets } from '@howlow/api/modules/wallet';
import { Queue, Worker, type Job } from 'bullmq';
import { getQueueConnection } from '../queues/connection.js';
import { QUEUE_NAMES } from '../queues/index.js';
import { getLogger } from '../shared/logger.js';

/**
 * Nightly wallet reconciliation.
 *
 * Every wallet's cached balance is checked against its own append-only ledger.
 * The job **detects and reports**; it never repairs. A wallet whose cache
 * disagrees with its ledger is evidence of a bug, and a job that quietly
 * rewrote the balance would destroy that evidence and could just as easily
 * move the wallet further from the truth.
 *
 * It runs in the worker rather than on a request: it reads every wallet, so it
 * belongs somewhere it cannot make a user wait, and somewhere a slow night
 * cannot hold an HTTP connection open.
 */
export const WALLET_RECONCILE_CRON = '0 3 * * *';

export interface WalletReconcileResult {
  readonly walletsChecked: number;
  readonly inconsistentCount: number;
  readonly walletIds: readonly string[];
}

export async function runWalletReconcile(): Promise<WalletReconcileResult> {
  const logger = getLogger();
  const sweep = await reconcileAllWallets();

  const result: WalletReconcileResult = {
    walletsChecked: sweep.walletsChecked,
    inconsistentCount: sweep.inconsistent.length,
    walletIds: sweep.inconsistent.map((report) => report.walletId),
  };

  if (result.inconsistentCount > 0) {
    // Logged at error level with the ids and nothing else actionable elided:
    // this is the line that has to wake someone up. Each discrepancy is
    // already recorded in audit_logs by the module.
    logger.error(
      { ...result, reports: sweep.inconsistent },
      'wallet.reconcile: ledger discrepancies require investigation',
    );
  } else {
    logger.info(result, 'wallet.reconcile: every wallet matches its ledger');
  }

  return result;
}

/**
 * Register the processor and its nightly schedule.
 *
 * `jobId` is fixed so a restart re-registers the same repeatable job instead of
 * stacking a second nightly sweep on top of the first.
 */
export async function registerWalletReconcile(): Promise<Worker> {
  const connection = getQueueConnection();

  const worker = new Worker(
    QUEUE_NAMES.walletReconcile,
    async (job: Job): Promise<WalletReconcileResult> => {
      getLogger().info({ jobId: job.id }, 'wallet.reconcile: starting sweep');
      return runWalletReconcile();
    },
    // One at a time: the sweep is a read over the whole wallet table and gains
    // nothing from running twice at once.
    { connection, concurrency: 1 },
  );

  const queue = new Queue(QUEUE_NAMES.walletReconcile, { connection });
  await queue.upsertJobScheduler(
    'wallet.reconcile.nightly',
    { pattern: WALLET_RECONCILE_CRON },
    { opts: { removeOnComplete: 30, removeOnFail: 90 } },
  );
  await queue.close();

  return worker;
}
