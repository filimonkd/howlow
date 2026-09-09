import type { Channel, Role } from '@howlow/shared';
import { getPool, type Tx } from '../../db/index.js';

/**
 * Every SQL statement the auth module runs. Services compose these; nothing
 * outside this file writes auth SQL, so the queries touching credentials can be
 * reviewed in one place.
 */
export interface UserRow {
  id: string;
  phone: string | null;
  email: string | null;
  display_name: string;
  password_hash: string | null;
  status: 'pending' | 'active' | 'suspended' | 'deleted';
  phone_verified_at: Date | null;
  email_verified_at: Date | null;
  failed_login_attempts: number;
  locked_until: Date | null;
  created_at: Date;
}

export interface SessionRow {
  id: string;
  user_id: string;
  family_id: string;
  refresh_token_hash: string;
  channel: Channel;
  expires_at: Date;
  revoked_at: Date | null;
  reuse_detected_at: Date | null;
}

type Runner = Pick<Tx, 'query'>;
const runner = (tx?: Tx): Runner => tx ?? getPool();

const USER_COLUMNS = `id, phone, email, display_name, password_hash, status,
  phone_verified_at, email_verified_at, failed_login_attempts, locked_until, created_at`;

export async function findUserByPhone(phone: string, tx?: Tx): Promise<UserRow | undefined> {
  const { rows } = await runner(tx).query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE phone = $1 AND status <> 'deleted'`,
    [phone],
  );
  return rows[0];
}

export async function findUserById(id: string, tx?: Tx): Promise<UserRow | undefined> {
  const { rows } = await runner(tx).query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE id = $1 AND status <> 'deleted'`,
    [id],
  );
  return rows[0];
}

export async function createPendingUser(
  input: { phone: string; displayName: string; email?: string | undefined },
  tx?: Tx,
): Promise<UserRow> {
  const { rows } = await runner(tx).query<UserRow>(
    `INSERT INTO users (phone, display_name, email, status)
     VALUES ($1, $2, $3, 'pending')
     RETURNING ${USER_COLUMNS}`,
    [input.phone, input.displayName, input.email ?? null],
  );
  return rows[0]!;
}

export async function activateUser(userId: string, tx?: Tx): Promise<void> {
  await runner(tx).query(
    `UPDATE users
     SET status = 'active', phone_verified_at = COALESCE(phone_verified_at, now()),
         failed_login_attempts = 0, locked_until = NULL
     WHERE id = $1`,
    [userId],
  );
}

export async function setPasswordHash(userId: string, passwordHash: string, tx?: Tx): Promise<void> {
  await runner(tx).query(`UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1`, [
    userId,
    passwordHash,
  ]);
}

export async function recordFailedLogin(
  userId: string,
  lockAfter: number,
  lockMinutes: number,
  tx?: Tx,
): Promise<number> {
  const { rows } = await runner(tx).query<{ failed_login_attempts: number }>(
    `UPDATE users
     SET failed_login_attempts = failed_login_attempts + 1,
         locked_until = CASE
           WHEN failed_login_attempts + 1 >= $2 THEN now() + ($3 || ' minutes')::interval
           ELSE locked_until
         END
     WHERE id = $1
     RETURNING failed_login_attempts`,
    [userId, lockAfter, String(lockMinutes)],
  );
  return rows[0]?.failed_login_attempts ?? 0;
}

export async function clearLoginFailures(userId: string, tx?: Tx): Promise<void> {
  await runner(tx).query(
    `UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`,
    [userId],
  );
}

export async function getUserRoles(userId: string, tx?: Tx): Promise<Role[]> {
  const { rows } = await runner(tx).query<{ role: Role }>(
    `SELECT role FROM user_roles WHERE user_id = $1 ORDER BY role`,
    [userId],
  );
  return rows.map((row) => row.role);
}

export async function grantRole(userId: string, role: Role, tx?: Tx): Promise<void> {
  await runner(tx).query(`INSERT INTO user_roles (user_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
    userId,
    role,
  ]);
}

// ---------------------------------------------------------------------------
// OTP challenges
// ---------------------------------------------------------------------------

export interface OtpRow {
  id: string;
  user_id: string | null;
  destination: string;
  purpose: string;
  code_hash: string;
  attempts: number;
  max_attempts: number;
  sent_count: number;
  last_sent_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
}

export async function findLiveOtp(
  destination: string,
  purpose: string,
  tx?: Tx,
): Promise<OtpRow | undefined> {
  const { rows } = await runner(tx).query<OtpRow>(
    `SELECT * FROM otp_challenges
     WHERE destination = $1 AND purpose = $2::otp_purpose AND consumed_at IS NULL`,
    [destination, purpose],
  );
  return rows[0];
}

/**
 * Issue or re-issue a challenge. The live-challenge index permits only one
 * unconsumed row per destination and purpose, so a resend replaces the code in
 * place and increments the send count rather than accumulating rows an attacker
 * could guess against in parallel.
 */
export async function upsertOtpChallenge(
  input: {
    userId: string | null;
    destination: string;
    purpose: string;
    codeHash: string;
    maxAttempts: number;
    expiresAt: Date;
  },
  tx?: Tx,
): Promise<OtpRow> {
  const existing = await findLiveOtp(input.destination, input.purpose, tx);
  if (existing) {
    const { rows } = await runner(tx).query<OtpRow>(
      `UPDATE otp_challenges
       SET code_hash = $2, attempts = 0, expires_at = $3,
           sent_count = sent_count + 1, last_sent_at = now(), user_id = COALESCE($4, user_id)
       WHERE id = $1
       RETURNING *`,
      [existing.id, input.codeHash, input.expiresAt, input.userId],
    );
    return rows[0]!;
  }

  const { rows } = await runner(tx).query<OtpRow>(
    `INSERT INTO otp_challenges
       (user_id, destination, purpose, code_hash, max_attempts, expires_at)
     VALUES ($1, $2, $3::otp_purpose, $4, $5, $6)
     RETURNING *`,
    [input.userId, input.destination, input.purpose, input.codeHash, input.maxAttempts, input.expiresAt],
  );
  return rows[0]!;
}

export async function incrementOtpAttempts(id: string, tx?: Tx): Promise<number> {
  const { rows } = await runner(tx).query<{ attempts: number }>(
    `UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts`,
    [id],
  );
  return rows[0]?.attempts ?? 0;
}

export async function consumeOtp(id: string, tx?: Tx): Promise<void> {
  await runner(tx).query(`UPDATE otp_challenges SET consumed_at = now() WHERE id = $1`, [id]);
}

/** Burn a challenge that has run out of attempts, so it cannot be retried. */
export async function exhaustOtp(id: string, tx?: Tx): Promise<void> {
  await runner(tx).query(
    `UPDATE otp_challenges SET consumed_at = now(), attempts = max_attempts WHERE id = $1`,
    [id],
  );
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function createSession(
  input: {
    userId: string;
    familyId: string | null;
    refreshTokenHash: string;
    channel: Channel;
    expiresAt: Date;
    userAgent?: string | undefined;
    ipAddress?: string | undefined;
  },
  tx?: Tx,
): Promise<SessionRow> {
  const { rows } = await runner(tx).query<SessionRow>(
    `INSERT INTO sessions
       (user_id, family_id, refresh_token_hash, channel, expires_at, user_agent, ip_address)
     VALUES ($1, COALESCE($2, gen_random_uuid()), $3, $4, $5, $6, $7)
     RETURNING id, user_id, family_id, refresh_token_hash, channel, expires_at,
               revoked_at, reuse_detected_at`,
    [
      input.userId,
      input.familyId,
      input.refreshTokenHash,
      input.channel,
      input.expiresAt,
      input.userAgent ?? null,
      input.ipAddress ?? null,
    ],
  );
  return rows[0]!;
}

export async function findSessionByRefreshHash(
  refreshTokenHash: string,
  tx?: Tx,
): Promise<SessionRow | undefined> {
  const { rows } = await runner(tx).query<SessionRow>(
    `SELECT id, user_id, family_id, refresh_token_hash, channel, expires_at,
            revoked_at, reuse_detected_at
     FROM sessions WHERE refresh_token_hash = $1`,
    [refreshTokenHash],
  );
  return rows[0];
}

export async function revokeSession(id: string, reason: string, tx?: Tx): Promise<void> {
  await runner(tx).query(
    `UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()), revoked_reason = $2
     WHERE id = $1`,
    [id, reason],
  );
}

export async function linkRotatedSession(previousId: string, nextId: string, tx?: Tx): Promise<void> {
  await runner(tx).query(`UPDATE sessions SET replaced_by_session_id = $2 WHERE id = $1`, [
    previousId,
    nextId,
  ]);
}

/** Revoke every session in a token family. Used on refresh-token reuse. */
export async function revokeSessionFamily(familyId: string, reason: string, tx?: Tx): Promise<number> {
  const result = await runner(tx).query(
    `UPDATE sessions
     SET revoked_at = COALESCE(revoked_at, now()), revoked_reason = $2,
         reuse_detected_at = CASE WHEN $2 = 'refresh_reuse' THEN now() ELSE reuse_detected_at END
     WHERE family_id = $1 AND revoked_at IS NULL`,
    [familyId, reason],
  );
  return result.rowCount ?? 0;
}

export async function revokeAllUserSessions(userId: string, reason: string, tx?: Tx): Promise<number> {
  const result = await runner(tx).query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = $2
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, reason],
  );
  return result.rowCount ?? 0;
}

export async function isSessionActive(sessionId: string, tx?: Tx): Promise<boolean> {
  const { rows } = await runner(tx).query<{ active: boolean }>(
    `SELECT (revoked_at IS NULL AND expires_at > now()) AS active FROM sessions WHERE id = $1`,
    [sessionId],
  );
  return rows[0]?.active ?? false;
}

// ---------------------------------------------------------------------------
// Telegram identity
// ---------------------------------------------------------------------------

export interface TelegramAccountRow {
  id: string;
  user_id: string;
  telegram_user_id: string;
  username: string | null;
  linked_at: Date;
}

export async function findTelegramAccountByTelegramId(
  telegramUserId: string,
  tx?: Tx,
): Promise<TelegramAccountRow | undefined> {
  const { rows } = await runner(tx).query<TelegramAccountRow>(
    `SELECT id, user_id, telegram_user_id, username, linked_at
     FROM telegram_accounts WHERE telegram_user_id = $1`,
    [telegramUserId],
  );
  return rows[0];
}

export async function findTelegramAccountByUserId(
  userId: string,
  tx?: Tx,
): Promise<TelegramAccountRow | undefined> {
  const { rows } = await runner(tx).query<TelegramAccountRow>(
    `SELECT id, user_id, telegram_user_id, username, linked_at
     FROM telegram_accounts WHERE user_id = $1`,
    [userId],
  );
  return rows[0];
}

export async function createTelegramAccount(
  input: {
    userId: string;
    telegramUserId: string;
    username?: string | undefined;
    firstName?: string | undefined;
    lastName?: string | undefined;
    languageCode?: string | undefined;
  },
  tx?: Tx,
): Promise<TelegramAccountRow> {
  const { rows } = await runner(tx).query<TelegramAccountRow>(
    `INSERT INTO telegram_accounts
       (user_id, telegram_user_id, username, first_name, last_name, language_code)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, user_id, telegram_user_id, username, linked_at`,
    [
      input.userId,
      input.telegramUserId,
      input.username ?? null,
      input.firstName ?? null,
      input.lastName ?? null,
      input.languageCode ?? null,
    ],
  );
  return rows[0]!;
}

export async function deleteTelegramAccount(userId: string, tx?: Tx): Promise<boolean> {
  const result = await runner(tx).query(`DELETE FROM telegram_accounts WHERE user_id = $1`, [userId]);
  return (result.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Telegram link tokens
// ---------------------------------------------------------------------------

export interface LinkTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  consumed_at: Date | null;
}

export async function replaceLinkToken(
  input: { userId: string; tokenHash: string; expiresAt: Date },
  tx?: Tx,
): Promise<LinkTokenRow> {
  // Only one live token per user is permitted, so issuing a new one retires the
  // old: an abandoned link must not stay usable once it has been superseded.
  await runner(tx).query(
    `UPDATE telegram_link_tokens
     SET consumed_at = now(), consumed_by_telegram_user_id = 0
     WHERE user_id = $1 AND consumed_at IS NULL`,
    [input.userId],
  );
  const { rows } = await runner(tx).query<LinkTokenRow>(
    `INSERT INTO telegram_link_tokens (user_id, token_hash, expires_at, created_channel)
     VALUES ($1, $2, $3, 'web')
     RETURNING id, user_id, token_hash, expires_at, consumed_at`,
    [input.userId, input.tokenHash, input.expiresAt],
  );
  return rows[0]!;
}

/**
 * Claim a link token for exclusive use inside the caller's transaction.
 *
 * `FOR UPDATE` means two Telegram confirmations racing on the same token
 * serialise here, and the second sees it already consumed. Single use is
 * therefore enforced by the database, not by the order the handlers happen to
 * run in.
 */
export async function claimLinkToken(tokenHash: string, tx: Tx): Promise<LinkTokenRow | undefined> {
  const { rows } = await tx.query<LinkTokenRow>(
    `SELECT id, user_id, token_hash, expires_at, consumed_at
     FROM telegram_link_tokens WHERE token_hash = $1 FOR UPDATE`,
    [tokenHash],
  );
  return rows[0];
}

export async function markLinkTokenConsumed(id: string, telegramUserId: string, tx: Tx): Promise<void> {
  await tx.query(
    `UPDATE telegram_link_tokens
     SET consumed_at = now(), consumed_by_telegram_user_id = $2
     WHERE id = $1`,
    [id, telegramUserId],
  );
}
