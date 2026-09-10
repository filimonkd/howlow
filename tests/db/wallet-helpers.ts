import pg from 'pg';
import type { Role } from '@howlow/shared';
import { loadEnvFile } from '../../scripts/load-env.mjs';

/**
 * Helpers for the wallet suite.
 *
 * Like the auth suite, this exercises real services against real PostgreSQL —
 * the whole point is the concurrency behaviour of real transactions and real
 * row locks, which no mock can demonstrate. Rows are therefore created for
 * real and cleaned up afterwards rather than wrapped in a rolled-back
 * transaction.
 */
export const TEST_EMAIL_DOMAIN = 'wallet-suite.test.local';

let counter = 0;

export async function adminClient(): Promise<pg.Client> {
  await loadEnvFile();
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    throw new Error('DATABASE_URL is required for the wallet suite.');
  }
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}

/** A user with no wallet yet. The module creates it. */
export async function createUser(
  client: pg.Client,
  options: { readonly roles?: readonly Role[] } = {},
): Promise<string> {
  counter += 1;
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO users (email, display_name, status)
     VALUES ($1, $2, 'active') RETURNING id`,
    [`user-${Date.now()}-${counter}@${TEST_EMAIL_DOMAIN}`, `Wallet suite user ${counter}`],
  );
  const userId = rows[0]!.id;
  for (const role of options.roles ?? []) {
    await client.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, $2)`, [userId, role]);
  }
  return userId;
}

/**
 * Remove everything this suite created.
 *
 * `wallet_entries` is append-only and both it and `wallets` reference `users`
 * with ON DELETE RESTRICT — correct production behaviour, and exactly what the
 * schema is meant to guarantee. Teardown drops to
 * `session_replication_role = 'replica'` for one transaction, which suspends
 * triggers and referential actions. This is a test-only escape hatch: no
 * application code may do it, and the guarantee it bypasses is itself asserted
 * by tests in this file and in immutability.test.ts.
 */
export async function cleanup(client: pg.Client): Promise<void> {
  const domain = `%@${TEST_EMAIL_DOMAIN}`;
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL session_replication_role = 'replica'");
    const scope = `SELECT id FROM users WHERE email LIKE $1`;
    await client.query(`DELETE FROM audit_logs WHERE actor_user_id IN (${scope})`, [domain]);
    await client.query(`DELETE FROM wallet_entries WHERE user_id IN (${scope})`, [domain]);
    await client.query(`DELETE FROM wallets WHERE user_id IN (${scope})`, [domain]);
    await client.query(`DELETE FROM user_roles WHERE user_id IN (${scope})`, [domain]);
    await client.query(`DELETE FROM users WHERE email LIKE $1`, [domain]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

/**
 * Run an operation expected to fail and return its wallet error code.
 *
 * `toThrow` matches `Error.message`, which is the internal description. What a
 * caller branches on is the stable code in `details.walletError`, so that is
 * what the assertions use.
 */
export async function walletRejection(operation: Promise<unknown>): Promise<{
  walletError: string;
  code: string;
  publicMessage: string;
  message: string;
}> {
  try {
    await operation;
  } catch (error) {
    const app = error as {
      code?: unknown;
      publicMessage?: unknown;
      message?: unknown;
      details?: { walletError?: unknown };
    };
    return {
      walletError:
        typeof app.details?.walletError === 'string' ? app.details.walletError : 'NOT_A_WALLET_ERROR',
      code: typeof app.code === 'string' ? app.code : 'UNKNOWN',
      publicMessage: typeof app.publicMessage === 'string' ? app.publicMessage : String(app.message),
      message: typeof app.message === 'string' ? app.message : String(error),
    };
  }
  throw new Error('Expected the operation to be rejected, but it succeeded');
}

/**
 * Settle a set of concurrent operations without letting one rejection hide the
 * others. Concurrency assertions need to know how many succeeded *and* how the
 * rest failed.
 */
export async function settle<T>(
  operations: readonly Promise<T>[],
): Promise<{ fulfilled: T[]; walletErrors: string[]; otherErrors: unknown[] }> {
  const results = await Promise.allSettled(operations);
  const fulfilled: T[] = [];
  const walletErrors: string[] = [];
  const otherErrors: unknown[] = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      fulfilled.push(result.value);
      continue;
    }
    const details = (result.reason as { details?: { walletError?: unknown } }).details;
    if (typeof details?.walletError === 'string') walletErrors.push(details.walletError);
    else otherErrors.push(result.reason);
  }

  return { fulfilled, walletErrors, otherErrors };
}

/** Read the raw wallet row, bypassing the module, to check what it actually stored. */
export async function readWalletRow(
  client: pg.Client,
  walletId: string,
): Promise<{ availableMinor: bigint; reservedMinor: bigint; version: bigint; frozen: boolean }> {
  const { rows } = await client.query<{
    available_minor: string;
    reserved_minor: string;
    version: string;
    frozen_at: Date | null;
  }>(`SELECT available_minor, reserved_minor, version, frozen_at FROM wallets WHERE id = $1`, [walletId]);
  const row = rows[0]!;
  return {
    availableMinor: BigInt(row.available_minor),
    reservedMinor: BigInt(row.reserved_minor),
    version: BigInt(row.version),
    frozen: row.frozen_at !== null,
  };
}

/** Sum the ledger directly in SQL, independent of the module's own query. */
export async function ledgerSum(client: pg.Client, walletId: string): Promise<bigint> {
  const { rows } = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount_minor), 0)::text AS total FROM wallet_entries WHERE wallet_id = $1`,
    [walletId],
  );
  return BigInt(rows[0]!.total);
}

export async function entryCount(client: pg.Client, walletId: string): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM wallet_entries WHERE wallet_id = $1`,
    [walletId],
  );
  return Number(rows[0]!.count);
}
