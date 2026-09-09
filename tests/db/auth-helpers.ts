import pg from 'pg';
import type * as AuthModule from '@howlow/api/modules/auth';
import { loadEnvFile } from '../../scripts/load-env.mjs';

/**
 * The auth suite exercises real services against real PostgreSQL and Redis, so
 * it cannot wrap everything in one rolled-back transaction the way the schema
 * tests do — the services open their own connections.
 *
 * Instead every test uses a unique phone number, and everything created is
 * removed afterwards by phone prefix.
 */
export const TEST_PHONE_PREFIX = '+25199';

let counter = 0;

/** A unique E.164 number per call, inside the range this suite cleans up. */
export function uniquePhone(): string {
  counter += 1;
  const suffix = String(Date.now() % 100_000).padStart(5, '0');
  return `${TEST_PHONE_PREFIX}${suffix}${String(counter).padStart(2, '0')}`;
}

export function uniqueTelegramId(): string {
  counter += 1;
  return String(900_000_000_000 + (Date.now() % 1_000_000) * 100 + counter);
}

export async function adminClient(): Promise<pg.Client> {
  await loadEnvFile();
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    throw new Error('DATABASE_URL is required for the auth suite.');
  }
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}

/**
 * Remove everything this suite created.
 *
 * `audit_logs` is append-only and `audit_logs.actor_user_id` is ON DELETE
 * RESTRICT, so a user with audit history cannot be deleted by ordinary means —
 * which is the correct production behaviour and exactly what the schema is
 * meant to guarantee. Teardown therefore drops to `session_replication_role =
 * replica` for one transaction, which suspends triggers and referential
 * actions. This is a test-only escape hatch: no application code may do it, and
 * the guarantee it bypasses is asserted by tests/db/immutability.test.ts.
 */
export async function cleanupTestUsers(client: pg.Client): Promise<void> {
  const like = `${TEST_PHONE_PREFIX}%`;
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query(
      `DELETE FROM audit_logs WHERE actor_user_id IN (SELECT id FROM users WHERE phone LIKE $1)`,
      [like],
    );
    await client.query(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE phone LIKE $1)`, [
      like,
    ]);
    await client.query(`DELETE FROM otp_challenges WHERE destination LIKE $1`, [like]);
    await client.query(
      `DELETE FROM telegram_link_tokens WHERE user_id IN (SELECT id FROM users WHERE phone LIKE $1)`,
      [like],
    );
    await client.query(
      `DELETE FROM telegram_accounts WHERE user_id IN (SELECT id FROM users WHERE phone LIKE $1)`,
      [like],
    );
    await client.query(`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE phone LIKE $1)`, [
      like,
    ]);
    await client.query(`DELETE FROM users WHERE phone LIKE $1`, [like]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

/**
 * Run an operation expected to fail and return the error's public shape.
 *
 * `toThrow` matches `Error.message`, which on an AppError is the internal
 * description. What matters to a caller — and to the no-enumeration guarantee —
 * is `publicMessage` and `code`, so assertions are made against those.
 */
export async function rejection(
  operation: Promise<unknown>,
): Promise<{ code: string; publicMessage: string; message: string }> {
  try {
    await operation;
  } catch (error) {
    const app = error as { code?: unknown; publicMessage?: unknown; message?: unknown };
    return {
      code: typeof app.code === 'string' ? app.code : 'UNKNOWN',
      publicMessage: typeof app.publicMessage === 'string' ? app.publicMessage : String(app.message),
      message: typeof app.message === 'string' ? app.message : String(error),
    };
  }
  throw new Error('Expected the operation to be rejected, but it succeeded');
}

/** Register and verify in one step, for tests that need an established account. */
export async function establishedAccount(auth: typeof AuthModule): Promise<{
  phone: string;
  userId: string;
  refreshToken: string;
  accessToken: string;
}> {
  const phone = uniquePhone();
  const dispatched = await auth.register({ phone, displayName: 'Test Account' }, { channel: 'web' });
  if (dispatched.devCode === undefined) throw new Error('devCode missing outside production');

  const verified = await auth.verifyPhone(
    { phone, code: dispatched.devCode, channel: 'web' },
    { channel: 'web' },
  );

  return {
    phone,
    userId: verified.user.id,
    refreshToken: verified.session.tokens.refreshToken,
    accessToken: verified.session.tokens.accessToken,
  };
}
