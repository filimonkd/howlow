import pg from 'pg';
import { loadConfig } from '../config/index.js';
import { getLogger } from '../shared/logger.js';
import { applySafeTypeParsers } from './types.js';

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (pool) return pool;
  const env = loadConfig();
  applySafeTypeParsers();

  pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
    application_name: env.SERVICE_NAME,
    ...(env.DATABASE_SSL ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  pool.on('error', (error) => {
    getLogger().error({ err: error }, 'Idle PostgreSQL client error');
  });

  return pool;
}

export interface DbHealth {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly error?: string;
}

export async function checkDatabase(): Promise<DbHealth> {
  const startedAt = process.hrtime.bigint();
  try {
    await getPool().query('SELECT 1');
    return { ok: true, latencyMs: elapsedMs(startedAt) };
  } catch (error) {
    return {
      ok: false,
      latencyMs: elapsedMs(startedAt),
      error: error instanceof Error ? error.message : 'unknown error',
    };
  }
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  const current = pool;
  pool = undefined;
  await current.end();
}

function elapsedMs(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}
