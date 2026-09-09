import type pg from 'pg';
import { getPool } from './pool.js';

/**
 * A handle to a connection that is already inside a transaction. Every
 * financial write in HOWLOW takes one of these, so that the caller cannot
 * accidentally split a money operation across two connections.
 */
export interface Tx {
  query: pg.PoolClient['query'];
}

export type IsolationLevel = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

export interface TransactionOptions {
  readonly isolationLevel?: IsolationLevel;
  /**
   * How many times to retry when PostgreSQL aborts the transaction because it
   * could not be serialised. Only ever retried when the database itself says
   * the transaction is safe to retry.
   */
  readonly maxRetries?: number;
  readonly readOnly?: boolean;
}

/**
 * PostgreSQL raises these when concurrent transactions conflict. Both mean
 * "nothing was committed, try again" — never "the write may have landed" — so
 * retrying is safe and does not risk double-applying a money operation.
 *
 * 40001 serialization_failure, 40P01 deadlock_detected
 */
const RETRYABLE_SQL_STATES = new Set(['40001', '40P01']);

function isRetryable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return typeof error.code === 'string' && RETRYABLE_SQL_STATES.has(error.code);
}

/**
 * Run `fn` inside a single transaction, committing on success and rolling back
 * on any thrown error. Money, bid and auction-closing paths must always go
 * through here.
 *
 * The callback may be invoked more than once when `maxRetries` is above zero,
 * so it must not perform side effects outside the transaction — no queue
 * publishing, no HTTP calls, no in-memory mutation the caller depends on.
 * Do those after `withTransaction` returns.
 */
export async function withTransaction<T>(
  fn: (tx: Tx) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const { isolationLevel = 'READ COMMITTED', maxRetries = 0, readOnly = false } = options;
  const pool = getPool();

  let attempt = 0;
  for (;;) {
    const client = await pool.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolationLevel}${readOnly ? ' READ ONLY' : ''}`);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (attempt < maxRetries && isRetryable(error)) {
        attempt += 1;
        continue;
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

/**
 * Serialise work that must not run concurrently for the same subject — closing
 * one auction, mutating one wallet — by taking a transaction-scoped advisory
 * lock. The lock is released when the transaction ends, including on rollback,
 * so it cannot be leaked by a failing caller.
 *
 * `key` is hashed to the bigint PostgreSQL wants, so callers name the subject
 * ("wallet:<uuid>") rather than inventing lock numbers that could collide.
 */
export async function withAdvisoryLock<T>(tx: Tx, key: string, fn: () => Promise<T>): Promise<T> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
  return fn();
}
