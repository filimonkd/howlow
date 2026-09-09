import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, createFixtures, expectRejected, type Fixtures } from './helpers.js';

/**
 * Telegram identity maps onto the single HOWLOW user identity, and link tokens
 * are hashed, expiring and single-use.
 */
let client: pg.Client;
let fx: Fixtures;

beforeAll(async () => {
  client = await connect();
  await client.query('BEGIN');
  fx = await createFixtures(client, 'telegram');
});

afterAll(async () => {
  await client.query('ROLLBACK');
  await client.end();
});

describe('telegram_accounts', () => {
  it('links a Telegram account to a HOWLOW user', async () => {
    const linked = await client.query(
      `INSERT INTO telegram_accounts (user_id, telegram_user_id, username)
       VALUES ($1, 987654321, 'howlow_tester') RETURNING id`,
      [fx.userId],
    );
    expect(linked.rowCount).toBe(1);
  });

  it('refuses a second Telegram account for the same user', async () => {
    const failure = await expectRejected(client, () =>
      client.query(`INSERT INTO telegram_accounts (user_id, telegram_user_id) VALUES ($1, 111222333)`, [
        fx.userId,
      ]),
    );
    expect(failure.constraint).toBe('telegram_accounts_user_id_key');
  });

  it('refuses the same Telegram id linked to two HOWLOW users', async () => {
    const failure = await expectRejected(client, () =>
      client.query(`INSERT INTO telegram_accounts (user_id, telegram_user_id) VALUES ($1, 987654321)`, [
        fx.otherUserId,
      ]),
    );
    expect(failure.constraint).toBe('telegram_accounts_telegram_user_id_key');
  });

  it('allows the display username to be reused, because it is not identity', async () => {
    const reused = await client.query(
      `INSERT INTO telegram_accounts (user_id, telegram_user_id, username)
       VALUES ($1, 555666777, 'howlow_tester') RETURNING id`,
      [fx.otherUserId],
    );
    expect(reused.rowCount).toBe(1);
  });
});

describe('telegram_link_tokens', () => {
  it('stores only a hash and expires', async () => {
    const token = await client.query<{ token_hash: string; expires_at: Date }>(
      `INSERT INTO telegram_link_tokens (user_id, token_hash, expires_at)
       VALUES ($1, encode(digest('raw-token-value', 'sha256'), 'hex'), now() + interval '15 minutes')
       RETURNING token_hash, expires_at`,
      [fx.userId],
    );
    const stored = token.rows[0]!;
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.token_hash).not.toContain('raw-token-value');
    expect(stored.expires_at.getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses a token that expires before it was created', async () => {
    const failure = await expectRejected(client, () =>
      client.query(
        `INSERT INTO telegram_link_tokens (user_id, token_hash, expires_at)
         VALUES ($1, 'hash-backwards', now() - interval '1 minute')`,
        [fx.otherUserId],
      ),
    );
    expect(failure.constraint).toBe('telegram_link_tokens_expiry_after_creation');
  });

  it('allows only one live token per user', async () => {
    const failure = await expectRejected(client, () =>
      client.query(
        `INSERT INTO telegram_link_tokens (user_id, token_hash, expires_at)
         VALUES ($1, 'hash-second-live', now() + interval '15 minutes')`,
        [fx.userId],
      ),
    );
    expect(failure.constraint).toBe('telegram_link_tokens_live_key');
  });

  it('records who consumed a token, and both facts together', async () => {
    const halfConsumed = await expectRejected(client, () =>
      client.query(`UPDATE telegram_link_tokens SET consumed_at = now() WHERE user_id = $1`, [fx.userId]),
    );
    expect(halfConsumed.constraint).toBe('telegram_link_tokens_consumption_consistent');

    const consumed = await client.query(
      `UPDATE telegram_link_tokens
       SET consumed_at = now(), consumed_by_telegram_user_id = 987654321
       WHERE user_id = $1`,
      [fx.userId],
    );
    expect(consumed.rowCount).toBe(1);

    // Once consumed, the user may be issued a fresh token.
    const reissued = await client.query(
      `INSERT INTO telegram_link_tokens (user_id, token_hash, expires_at)
       VALUES ($1, 'hash-reissued', now() + interval '15 minutes') RETURNING id`,
      [fx.userId],
    );
    expect(reissued.rowCount).toBe(1);
  });
});

describe('identity uniqueness', () => {
  it('refuses two active users sharing an email, case-insensitively', async () => {
    const failure = await expectRejected(client, () =>
      client.query(
        `INSERT INTO users (email, display_name, status) VALUES ('TELEGRAM-BIDDER@TEST.LOCAL', 'clash', 'active')`,
      ),
    );
    expect(failure.constraint).toBe('users_email_active_key');
  });

  it('frees the email once the account is deleted', async () => {
    await client.query(`UPDATE users SET status = 'deleted' WHERE id = $1`, [fx.otherUserId]);
    const reused = await client.query(
      `INSERT INTO users (email, display_name, status)
       VALUES ('telegram-other@test.local', 'reregistered', 'active') RETURNING id`,
    );
    expect(reused.rowCount).toBe(1);
  });

  it('refuses a phone number that is not E.164', async () => {
    const failure = await expectRejected(client, () =>
      client.query(
        `INSERT INTO users (phone, display_name, status) VALUES ('0911223344', 'bad phone', 'active')`,
      ),
    );
    expect(failure.constraint).toBe('users_phone_e164');
  });
});
