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

/**
 * Run `fn` inside a single transaction, committing on success and rolling back
 * on any thrown error. Money and bid paths must always go through here.
 */
export async function withTransaction<T>(
  fn: (tx: Tx) => Promise<T>,
  isolationLevel: IsolationLevel = 'READ COMMITTED',
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolationLevel}`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
