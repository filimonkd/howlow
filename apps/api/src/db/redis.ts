import { Redis } from 'ioredis';
import { loadConfig } from '../config/index.js';
import { getLogger } from '../shared/logger.js';

/**
 * Redis is a cache, a rate limiter and a queue transport. It is NEVER the
 * source of truth for money, bids or auction results — those live in
 * PostgreSQL and are reconstructible without Redis.
 */
let client: Redis | undefined;

export function getRedis(): Redis {
  if (client) return client;
  const env = loadConfig();
  client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  });
  client.on('error', (error: Error) => {
    getLogger().error({ err: error }, 'Redis client error');
  });
  return client;
}

export interface RedisHealth {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly error?: string;
}

export async function checkRedis(): Promise<RedisHealth> {
  const startedAt = process.hrtime.bigint();
  try {
    await getRedis().ping();
    return { ok: true, latencyMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000 };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
      error: error instanceof Error ? error.message : 'unknown error',
    };
  }
}

export async function closeRedis(): Promise<void> {
  if (!client) return;
  const current = client;
  client = undefined;
  await current.quit();
}
