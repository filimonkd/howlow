import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as auth from '@howlow/api/modules/auth';
import { closePool, closeRedis, getRedis } from '@howlow/api/db';
import {
  adminClient,
  cleanupTestUsers,
  establishedAccount,
  rejection,
  uniquePhone,
  uniqueTelegramId,
} from './auth-helpers.js';

/**
 * Phase 2 acceptance, against real PostgreSQL and Redis, calling the same
 * services both channels call.
 *
 * Failures are asserted through `rejection()`, which reports `publicMessage`
 * and `code` — the surface a caller actually sees. `toThrow` would match the
 * internal message instead, and it is the public wording that carries the
 * no-enumeration guarantee.
 */
const WEB = { channel: 'web' } as const;
const TELEGRAM = { channel: 'telegram' } as const;

let db: pg.Client;

/** Extract the raw link token from a deep link. */
const tokenOf = (deepLink: string): string => deepLink.split('start=link_')[1]!;

beforeAll(async () => {
  db = await adminClient();
  await cleanupTestUsers(db);
  process.env['TELEGRAM_BOT_USERNAME'] ??= 'howlow_test_bot';
});

afterAll(async () => {
  await cleanupTestUsers(db);
  await db.end();
  await Promise.allSettled([closePool(), closeRedis()]);
});

describe('registration and phone verification', () => {
  it('registers with a phone and activates on a correct code', async () => {
    const phone = uniquePhone();
    const dispatched = await auth.register({ phone, displayName: 'Abebe' }, WEB);
    expect(dispatched.otpSent).toBe(true);
    expect(dispatched.devCode).toMatch(/^\d{6}$/);

    const pending = await db.query<{ status: string }>(`SELECT status FROM users WHERE phone = $1`, [phone]);
    expect(pending.rows[0]?.status).toBe('pending');

    const verified = await auth.verifyPhone({ phone, code: dispatched.devCode!, channel: 'web' }, WEB);
    expect(verified.user.status).toBe('active');
    expect(verified.user.phoneVerified).toBe(true);
    expect(verified.user.roles).toContain('user');
    expect(verified.session.tokens.accessToken).toBeTruthy();
  });

  it('never stores the OTP in plaintext', async () => {
    const phone = uniquePhone();
    const dispatched = await auth.register({ phone, displayName: 'Hash check' }, WEB);
    const stored = await db.query<{ code_hash: string }>(
      `SELECT code_hash FROM otp_challenges WHERE destination = $1`,
      [phone],
    );
    expect(stored.rows[0]?.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0]?.code_hash).not.toContain(dispatched.devCode!);
  });

  it('rejects an incorrect code', async () => {
    const phone = uniquePhone();
    const dispatched = await auth.register({ phone, displayName: 'Wrong code' }, WEB);
    const wrong = dispatched.devCode === '000000' ? '111111' : '000000';

    const failure = await rejection(auth.verifyPhone({ phone, code: wrong, channel: 'web' }, WEB));
    expect(failure.code).toBe('VALIDATION_FAILED');
    expect(failure.publicMessage).toMatch(/incorrect or has expired/);
  });

  it('rejects an expired code', async () => {
    const phone = uniquePhone();
    const dispatched = await auth.register({ phone, displayName: 'Expired' }, WEB);
    // Backdate the whole row: the schema requires expires_at > created_at, so
    // an "expired" challenge is one issued in the past, not one with an expiry
    // before its own creation.
    await db.query(
      `UPDATE otp_challenges
       SET created_at = now() - interval '10 minutes', expires_at = now() - interval '5 minutes'
       WHERE destination = $1`,
      [phone],
    );

    const failure = await rejection(
      auth.verifyPhone({ phone, code: dispatched.devCode!, channel: 'web' }, WEB),
    );
    expect(failure.publicMessage).toMatch(/incorrect or has expired/);
  });

  it('burns the challenge after too many attempts, even with the right code', async () => {
    const phone = uniquePhone();
    const dispatched = await auth.register({ phone, displayName: 'Attempts' }, WEB);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await rejection(auth.verifyPhone({ phone, code: '000001', channel: 'web' }, WEB));
    }

    // The attempt budget is spent, so even the correct code is refused.
    const failure = await rejection(
      auth.verifyPhone({ phone, code: dispatched.devCode!, channel: 'web' }, WEB),
    );
    expect(failure.publicMessage).toMatch(/incorrect or has expired/);

    const burned = await db.query<{ consumed_at: Date | null }>(
      `SELECT consumed_at FROM otp_challenges WHERE destination = $1`,
      [phone],
    );
    expect(burned.rows[0]?.consumed_at).not.toBeNull();
  });

  it('enforces a resend cooldown', async () => {
    const phone = uniquePhone();
    await auth.register({ phone, displayName: 'Cooldown' }, WEB);

    const failure = await rejection(auth.register({ phone, displayName: 'Cooldown' }, WEB));
    expect(failure.code).toBe('RATE_LIMITED');
    expect(failure.publicMessage).toMatch(/wait a moment/i);
  });

  it('does not reveal whether a phone is already registered', async () => {
    const account = await establishedAccount(auth);
    const response = await auth.register({ phone: account.phone, displayName: 'Someone else' }, WEB);
    // Identical shape to a genuine registration, and no code is issued.
    expect(response.otpSent).toBe(true);
    expect(response.devCode).toBeUndefined();
  });
});

describe('passwords', () => {
  it('stores only an argon2id hash and signs in with the password', async () => {
    const account = await establishedAccount(auth);
    const password = 'correct horse battery staple';
    await auth.changePassword({ userId: account.userId, newPassword: password }, WEB);

    const stored = await db.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE id = $1`,
      [account.userId],
    );
    expect(stored.rows[0]?.password_hash).toMatch(/^\$argon2id\$/);
    expect(stored.rows[0]?.password_hash).not.toContain(password);

    const signedIn = await auth.loginWithPassword({ phone: account.phone, password, channel: 'web' }, WEB);
    expect(signedIn.user.id).toBe(account.userId);
    expect(signedIn.user.hasPassword).toBe(true);
  });

  it('rejects a wrong password identically to an unknown account', async () => {
    const account = await establishedAccount(auth);
    await auth.changePassword({ userId: account.userId, newPassword: 'a-real-password-1' }, WEB);

    const wrong = await rejection(
      auth.loginWithPassword({ phone: account.phone, password: 'not-the-password', channel: 'web' }, WEB),
    );
    const unknown = await rejection(
      auth.loginWithPassword({ phone: uniquePhone(), password: 'anything-at-all', channel: 'web' }, WEB),
    );

    // Identical code and wording: the response cannot be used to test which
    // phone numbers hold accounts.
    expect(wrong.code).toBe(unknown.code);
    expect(wrong.publicMessage).toBe(unknown.publicMessage);
  });

  it('requires the current password to change an existing one', async () => {
    const account = await establishedAccount(auth);
    await auth.changePassword({ userId: account.userId, newPassword: 'first-password-12' }, WEB);

    const failure = await rejection(
      auth.changePassword({ userId: account.userId, newPassword: 'second-password-12' }, WEB),
    );
    expect(failure.publicMessage).toMatch(/current password/i);

    await auth.changePassword(
      {
        userId: account.userId,
        currentPassword: 'first-password-12',
        newPassword: 'second-password-12',
      },
      WEB,
    );
  });

  it('revokes every other session when the password changes', async () => {
    const account = await establishedAccount(auth);
    await auth.changePassword({ userId: account.userId, newPassword: 'initial-password-1' }, WEB);
    await auth.changePassword(
      {
        userId: account.userId,
        currentPassword: 'initial-password-1',
        newPassword: 'rotated-password-12',
      },
      WEB,
    );

    const failure = await rejection(auth.rotateSession(account.refreshToken, WEB));
    expect(failure.publicMessage).toMatch(/no longer valid/i);
  });

  it('resets a forgotten password with an OTP and revokes sessions', async () => {
    const account = await establishedAccount(auth);
    const dispatched = await auth.requestPasswordReset(account.phone, WEB);

    await auth.resetPassword(
      { phone: account.phone, code: dispatched.devCode!, newPassword: 'brand-new-password' },
      WEB,
    );

    const signedIn = await auth.loginWithPassword(
      { phone: account.phone, password: 'brand-new-password', channel: 'web' },
      WEB,
    );
    expect(signedIn.user.id).toBe(account.userId);
    await rejection(auth.rotateSession(account.refreshToken, WEB));
  });

  it('locks the account after repeated wrong passwords', async () => {
    const account = await establishedAccount(auth);
    await auth.changePassword({ userId: account.userId, newPassword: 'lockout-password-1' }, WEB);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await rejection(
        auth.loginWithPassword({ phone: account.phone, password: 'wrong', channel: 'web' }, WEB),
      );
    }

    // Even the correct password is refused while the lock holds.
    const locked = await rejection(
      auth.loginWithPassword({ phone: account.phone, password: 'lockout-password-1', channel: 'web' }, WEB),
    );
    expect(locked.publicMessage).toMatch(/temporarily locked/i);

    const row = await db.query<{ locked_until: Date | null }>(
      `SELECT locked_until FROM users WHERE id = $1`,
      [account.userId],
    );
    expect(row.rows[0]?.locked_until).not.toBeNull();
  });
});

describe('refresh token rotation', () => {
  it('rotates, stores only a hash, and issues a different token each time', async () => {
    const account = await establishedAccount(auth);

    const stored = await db.query<{ refresh_token_hash: string }>(
      `SELECT refresh_token_hash FROM sessions WHERE user_id = $1`,
      [account.userId],
    );
    expect(stored.rows[0]?.refresh_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0]?.refresh_token_hash).not.toBe(account.refreshToken);

    const rotated = await auth.rotateSession(account.refreshToken, WEB);
    expect(rotated.tokens.refreshToken).not.toBe(account.refreshToken);

    const again = await auth.rotateSession(rotated.tokens.refreshToken, WEB);
    expect(again.tokens.refreshToken).not.toBe(rotated.tokens.refreshToken);
  });

  it('detects reuse of a rotated token and revokes the whole family', async () => {
    const account = await establishedAccount(auth);
    const rotated = await auth.rotateSession(account.refreshToken, WEB);

    // Replaying the superseded token — the attacker's copy — must fail.
    const replay = await rejection(auth.rotateSession(account.refreshToken, WEB));
    expect(replay.publicMessage).toMatch(/no longer valid/i);

    // And the legitimate holder's newest token must stop working too: we cannot
    // tell which party is the thief, so the family is burned.
    await rejection(auth.rotateSession(rotated.tokens.refreshToken, WEB));

    const family = await db.query<{ reuse_detected_at: Date | null; revoked_at: Date | null }>(
      `SELECT reuse_detected_at, revoked_at FROM sessions WHERE family_id = $1 ORDER BY issued_at`,
      [rotated.familyId],
    );
    expect(family.rows.length).toBeGreaterThanOrEqual(2);
    expect(family.rows.every((row) => row.revoked_at !== null)).toBe(true);
    expect(family.rows.some((row) => row.reuse_detected_at !== null)).toBe(true);

    const audited = await db.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE actor_user_id = $1 AND action = 'REFRESH_REUSE_DETECTED'`,
      [account.userId],
    );
    expect(audited.rowCount).toBeGreaterThan(0);
  });

  it('revokes the session family on logout', async () => {
    const account = await establishedAccount(auth);
    await auth.revokeByRefreshToken(account.refreshToken, WEB);
    await rejection(auth.rotateSession(account.refreshToken, WEB));
  });

  it('rejects an unknown refresh token', async () => {
    const failure = await rejection(auth.rotateSession('not-a-real-refresh-token-value', WEB));
    expect(failure.code).toBe('UNAUTHENTICATED');
    expect(failure.publicMessage).toMatch(/no longer valid/i);
  });
});

describe('telegram identity', () => {
  it('links a Telegram account through a website-initiated token', async () => {
    const account = await establishedAccount(auth);
    const link = await auth.createLinkToken(account.userId, WEB);
    expect(link.deepLink).toMatch(/^https:\/\/t\.me\/.+\?start=link_/);

    const token = tokenOf(link.deepLink);
    const stored = await db.query<{ token_hash: string }>(
      `SELECT token_hash FROM telegram_link_tokens WHERE user_id = $1 AND consumed_at IS NULL`,
      [account.userId],
    );
    expect(stored.rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0]?.token_hash).not.toBe(token);

    const telegramUserId = uniqueTelegramId();
    const linked = await auth.confirmLink(
      { token, identity: { telegramUserId, username: 'tester' } },
      TELEGRAM,
    );
    expect(linked.id).toBe(account.userId);

    const resolved = await auth.resolveTelegramUser(telegramUserId);
    expect(resolved?.id).toBe(account.userId);

    const status = await auth.getTelegramStatus(account.userId);
    expect(status.linked).toBe(true);
    expect(status.telegramUserId).toBe(telegramUserId);
  });

  it('refuses a reused link token', async () => {
    const account = await establishedAccount(auth);
    const token = tokenOf((await auth.createLinkToken(account.userId, WEB)).deepLink);

    await auth.confirmLink({ token, identity: { telegramUserId: uniqueTelegramId() } }, TELEGRAM);

    const failure = await rejection(
      auth.confirmLink({ token, identity: { telegramUserId: uniqueTelegramId() } }, TELEGRAM),
    );
    expect(failure.publicMessage).toMatch(/already been used/i);
  });

  it('refuses an expired link token', async () => {
    const account = await establishedAccount(auth);
    const token = tokenOf((await auth.createLinkToken(account.userId, WEB)).deepLink);

    await db.query(
      `UPDATE telegram_link_tokens
       SET created_at = now() - interval '30 minutes', expires_at = now() - interval '15 minutes'
       WHERE user_id = $1 AND consumed_at IS NULL`,
      [account.userId],
    );

    const failure = await rejection(
      auth.confirmLink({ token, identity: { telegramUserId: uniqueTelegramId() } }, TELEGRAM),
    );
    expect(failure.publicMessage).toMatch(/expired/i);
  });

  it('refuses a Telegram account already held by another HOWLOW user', async () => {
    const first = await establishedAccount(auth);
    const second = await establishedAccount(auth);
    const telegramUserId = uniqueTelegramId();

    await auth.confirmLink(
      {
        token: tokenOf((await auth.createLinkToken(first.userId, WEB)).deepLink),
        identity: { telegramUserId },
      },
      TELEGRAM,
    );

    const failure = await rejection(
      auth.confirmLink(
        {
          token: tokenOf((await auth.createLinkToken(second.userId, WEB)).deepLink),
          identity: { telegramUserId },
        },
        TELEGRAM,
      ),
    );
    expect(failure.publicMessage).toMatch(/already connected to another/i);
  });

  it('treats the same person on both channels as one account', async () => {
    const account = await establishedAccount(auth);
    const telegramUserId = uniqueTelegramId();
    await auth.confirmLink(
      {
        token: tokenOf((await auth.createLinkToken(account.userId, WEB)).deepLink),
        identity: { telegramUserId },
      },
      TELEGRAM,
    );

    const fromWeb = await auth.getPublicUser(account.userId);
    const fromTelegram = await auth.resolveTelegramUser(telegramUserId);

    expect(fromTelegram?.id).toBe(fromWeb.id);
    expect(fromTelegram?.roles).toEqual(fromWeb.roles);

    const count = await db.query<{ count: string }>(`SELECT count(*) FROM users WHERE phone = $1`, [
      account.phone,
    ]);
    expect(count.rows[0]?.count).toBe('1');
  });

  it('never treats the Telegram username as identity', async () => {
    const first = await establishedAccount(auth);
    const second = await establishedAccount(auth);
    const sharedUsername = 'duplicate_handle';

    await auth.confirmLink(
      {
        token: tokenOf((await auth.createLinkToken(first.userId, WEB)).deepLink),
        identity: { telegramUserId: uniqueTelegramId(), username: sharedUsername },
      },
      TELEGRAM,
    );

    // A different Telegram id with the same handle is a different person.
    const linked = await auth.confirmLink(
      {
        token: tokenOf((await auth.createLinkToken(second.userId, WEB)).deepLink),
        identity: { telegramUserId: uniqueTelegramId(), username: sharedUsername },
      },
      TELEGRAM,
    );
    expect(linked.id).toBe(second.userId);
  });

  it('unlinks, keeps the account reachable, and refuses a second unlink', async () => {
    const account = await establishedAccount(auth);
    await auth.confirmLink(
      {
        token: tokenOf((await auth.createLinkToken(account.userId, WEB)).deepLink),
        identity: { telegramUserId: uniqueTelegramId() },
      },
      TELEGRAM,
    );

    await auth.unlinkTelegram(account.userId, WEB);
    expect((await auth.getTelegramStatus(account.userId)).linked).toBe(false);

    const failure = await rejection(auth.unlinkTelegram(account.userId, WEB));
    expect(failure.publicMessage).toMatch(/not connected/i);
  });

  it('does not resolve an unlinked Telegram id to any account', async () => {
    expect(await auth.resolveTelegramUser(uniqueTelegramId())).toBeUndefined();
  });
});

describe('authorization', () => {
  it('resolves roles from the HOWLOW user, not the channel', async () => {
    const account = await establishedAccount(auth);
    const roles = await auth.loadRoles(account.userId);
    expect(roles).toContain('user');

    expect(auth.hasAnyRole(roles, ['admin'])).toBe(false);
    expect(auth.hasAnyRole(roles, ['user'])).toBe(true);

    let publicMessage = '';
    try {
      auth.assertRole(roles, ['admin']);
    } catch (error) {
      publicMessage = (error as { publicMessage: string }).publicMessage;
    }
    // The refusal never names the role the caller was missing.
    expect(publicMessage).toMatch(/permission/i);
    expect(publicMessage).not.toMatch(/admin/i);
  });

  it('lets super_admin satisfy any role requirement', () => {
    expect(auth.hasAnyRole(['super_admin'], ['finance'])).toBe(true);
    expect(auth.hasAnyRole(['admin'], ['finance'])).toBe(false);
  });
});

describe('rate limiting', () => {
  it('refuses further attempts once a limit is exhausted', async () => {
    const subject = `test-subject-${String(Date.now())}`;
    const { limit } = auth.RATE_LIMITS.login;

    for (let attempt = 0; attempt < limit; attempt += 1) {
      await auth.enforceRateLimit('login', subject);
    }

    const failure = await rejection(auth.enforceRateLimit('login', subject));
    expect(failure.code).toBe('RATE_LIMITED');
    expect(failure.publicMessage).toMatch(/too many attempts/i);

    await getRedis().del(`ratelimit:login:${subject}`);
  });
});

describe('audit trail', () => {
  it('records authentication events without any secret', async () => {
    const account = await establishedAccount(auth);
    await auth.changePassword({ userId: account.userId, newPassword: 'audited-password-1' }, WEB);

    const events = await db.query<{ action: string; after_data: unknown }>(
      `SELECT action, after_data FROM audit_logs WHERE actor_user_id = $1 ORDER BY created_at`,
      [account.userId],
    );
    const actions = events.rows.map((row) => row.action);
    expect(actions).toContain('USER_REGISTERED');
    expect(actions).toContain('PHONE_VERIFIED');
    expect(actions).toContain('SESSION_CREATED');
    expect(actions).toContain('PASSWORD_SET');

    const serialised = JSON.stringify(events.rows);
    expect(serialised).not.toContain('audited-password-1');
    expect(serialised).not.toContain(account.refreshToken);
    expect(serialised).not.toMatch(/\$argon2id\$/);
  });
});
