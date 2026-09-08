import type { HealthResponse } from '@howlow/shared';
import { checkDatabase, checkRedis } from '../../db/index.js';
import { loadConfig } from '../../config/index.js';

/**
 * Application service. Channel adapters call this; they never reach for the
 * database themselves.
 */
export async function getHealth(): Promise<HealthResponse> {
  const env = loadConfig();
  const [database, redis] = await Promise.all([checkDatabase(), checkRedis()]);

  return {
    status: database.ok && redis.ok ? 'ok' : 'degraded',
    service: env.SERVICE_NAME,
    version: env.APP_VERSION,
    uptimeSeconds: Math.round(process.uptime()),
    checks: {
      postgres: {
        status: database.ok ? 'up' : 'down',
        latencyMs: Math.round(database.latencyMs),
        ...(database.error === undefined ? {} : { error: database.error }),
      },
      redis: {
        status: redis.ok ? 'up' : 'down',
        latencyMs: Math.round(redis.latencyMs),
        ...(redis.error === undefined ? {} : { error: redis.error }),
      },
    },
  };
}

/** Liveness: the process is up and able to answer. No dependencies consulted. */
export function getLiveness(): { status: 'ok' } {
  return { status: 'ok' };
}
