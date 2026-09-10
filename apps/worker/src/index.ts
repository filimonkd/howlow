import { loadConfig } from './config/index.js';
import { getLogger } from './shared/logger.js';
import { registerWalletReconcile, WALLET_RECONCILE_CRON } from './jobs/wallet-reconcile.js';
import { closeQueueConnection, getQueueConnection, QUEUE_NAMES } from './queues/index.js';

/**
 * Worker entrypoint.
 *
 * Processors are registered here as the phases that own them land. Redis
 * carries scheduling only: every effect a job has is written to PostgreSQL,
 * which stays the single financial truth.
 */
async function main(): Promise<void> {
  const env = loadConfig();
  const logger = getLogger();

  const connection = getQueueConnection();
  await connection.ping();

  const workers = [await registerWalletReconcile()];

  logger.info(
    {
      env: env.NODE_ENV,
      queues: Object.values(QUEUE_NAMES),
      processors: workers.map((worker) => worker.name),
      walletReconcileCron: WALLET_RECONCILE_CRON,
    },
    'HOWLOW worker started',
  );

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down HOWLOW worker');
    // Close the workers first so an in-flight sweep finishes rather than being
    // cut off part-way through the wallet table.
    void Promise.all(workers.map(async (worker) => worker.close()))
      .then(closeQueueConnection)
      .finally(() => {
        process.exit(0);
      });
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
