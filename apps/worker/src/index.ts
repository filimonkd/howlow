import { loadConfig } from './config/index.js';
import { getLogger } from './shared/logger.js';
import { closeQueueConnection, getQueueConnection, QUEUE_NAMES } from './queues/index.js';

/**
 * Worker entrypoint.
 *
 * Phase 0 brings the process up, proves its Redis connection and waits. Job
 * processors are registered here as the phases that own them land.
 */
async function main(): Promise<void> {
  const env = loadConfig();
  const logger = getLogger();

  const connection = getQueueConnection();
  await connection.ping();

  logger.info(
    { env: env.NODE_ENV, queues: Object.values(QUEUE_NAMES) },
    'HOWLOW worker started; no processors registered yet',
  );

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down HOWLOW worker');
    void closeQueueConnection().finally(() => {
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
