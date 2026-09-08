import { Redis } from 'ioredis';
import { loadConfig } from '../config/index.js';

/**
 * BullMQ requires its own Redis connection with `maxRetriesPerRequest: null`.
 * Redis carries job scheduling only — the job's *effects* are written to
 * PostgreSQL, which stays the single financial truth.
 */
let connection: Redis | undefined;

export function getQueueConnection(): Redis {
  if (connection) return connection;
  connection = new Redis(loadConfig().REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
  return connection;
}

export async function closeQueueConnection(): Promise<void> {
  if (!connection) return;
  const current = connection;
  connection = undefined;
  await current.quit();
}
