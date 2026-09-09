import { AppError, type Channel, type TokenPair } from '@howlow/shared';
import { loadConfig } from '../../config/index.js';
import { withTransaction, type Tx } from '../../db/index.js';
import { recordAuthEvent, type AuditContext } from './audit.js';
import * as repo from './repository.js';
import { generateRefreshToken, hashToken, signAccessToken } from './tokens.js';

/**
 * Session lifecycle: issue, rotate, revoke.
 *
 * A refresh token is opaque and stored only as a SHA-256 digest. Rotation
 * writes a NEW session row sharing the family_id and revokes the old one, so
 * the family is an audit trail of one login's token chain.
 *
 * Presenting an already-revoked refresh token means the token leaked and is
 * being replayed — the legitimate holder would have the newest one. The whole
 * family is revoked, forcing re-authentication.
 */
function refreshExpiry(): Date {
  return new Date(Date.now() + loadConfig().JWT_REFRESH_TTL_SECONDS * 1000);
}

export interface IssuedSession {
  readonly sessionId: string;
  readonly familyId: string;
  readonly tokens: TokenPair;
}

export async function issueSession(
  input: {
    userId: string;
    roles: readonly string[];
    channel: Channel;
    userAgent?: string | undefined;
    ipAddress?: string | undefined;
  },
  context: AuditContext,
  tx?: Tx,
): Promise<IssuedSession> {
  const refreshToken = generateRefreshToken();
  const session = await repo.createSession(
    {
      userId: input.userId,
      familyId: null,
      refreshTokenHash: hashToken(refreshToken),
      channel: input.channel,
      expiresAt: refreshExpiry(),
      userAgent: input.userAgent,
      ipAddress: input.ipAddress,
    },
    tx,
  );

  const { token: accessToken, expiresIn } = await signAccessToken({
    userId: input.userId,
    sessionId: session.id,
    channel: input.channel,
    roles: input.roles,
  });

  await recordAuthEvent('SESSION_CREATED', context, { sessionId: session.id, channel: input.channel }, tx);

  return {
    sessionId: session.id,
    familyId: session.family_id,
    tokens: { accessToken, refreshToken, tokenType: 'Bearer', expiresIn },
  };
}

const INVALID_REFRESH = (): AppError =>
  new AppError({
    code: 'UNAUTHENTICATED',
    message: 'Refresh token is invalid, expired or revoked',
    publicMessage: 'Your session is no longer valid. Please sign in again.',
  });

/**
 * Reuse of an already-revoked refresh token means the token leaked and is being
 * replayed: the legitimate holder would be presenting the newest one. Revoke the
 * whole family so both the attacker's copy and the victim's stop working.
 *
 * Written on its own connection, never inside the caller's transaction. The
 * caller rejects the request immediately afterwards, and a rejection unwinds its
 * transaction — so a revocation recorded on `tx` would be rolled back and reuse
 * detection would do nothing at all.
 */
async function handleReuse(
  session: { id: string; family_id: string; user_id: string },
  context: AuditContext,
): Promise<never> {
  const revoked = await repo.revokeSessionFamily(session.family_id, 'refresh_reuse');
  await recordAuthEvent(
    'REFRESH_REUSE_DETECTED',
    { ...context, actorUserId: session.user_id },
    { familyId: session.family_id, sessionsRevoked: revoked, reusedSessionId: session.id },
  );
  throw INVALID_REFRESH();
}

/** Thrown inside the rotation transaction when the token turns out to be reused. */
class ReuseDetected extends Error {
  constructor(readonly session: { id: string; family_id: string; user_id: string }) {
    super('refresh token reuse detected');
  }
}

/**
 * Rotate a refresh token.
 *
 * The happy path runs in one SERIALIZABLE transaction with a single retry, so
 * two clients racing the same token cannot both be issued a fresh one — the
 * loser sees the token already revoked and is treated as reuse.
 */
export async function rotateSession(refreshToken: string, context: AuditContext): Promise<IssuedSession> {
  const presentedHash = hashToken(refreshToken);

  try {
    return await withTransaction(
      async (tx) => {
        const session = await repo.findSessionByRefreshHash(presentedHash, tx);
        if (!session) throw INVALID_REFRESH();

        if (session.revoked_at !== null) throw new ReuseDetected(session);
        if (session.expires_at.getTime() <= Date.now()) throw INVALID_REFRESH();

        const user = await repo.findUserById(session.user_id, tx);
        if (user?.status !== 'active') throw INVALID_REFRESH();

        const roles = await repo.getUserRoles(user.id, tx);
        const nextToken = generateRefreshToken();
        const next = await repo.createSession(
          {
            userId: user.id,
            familyId: session.family_id,
            refreshTokenHash: hashToken(nextToken),
            channel: session.channel,
            expiresAt: refreshExpiry(),
            userAgent: context.userAgent,
            ipAddress: context.ipAddress,
          },
          tx,
        );

        await repo.revokeSession(session.id, 'rotated', tx);
        await repo.linkRotatedSession(session.id, next.id, tx);

        const { token: accessToken, expiresIn } = await signAccessToken({
          userId: user.id,
          sessionId: next.id,
          channel: session.channel,
          roles,
        });

        await recordAuthEvent(
          'REFRESH_ROTATED',
          { ...context, actorUserId: user.id },
          { familyId: session.family_id, previousSessionId: session.id, sessionId: next.id },
          tx,
        );

        return {
          sessionId: next.id,
          familyId: next.family_id,
          tokens: { accessToken, refreshToken: nextToken, tokenType: 'Bearer', expiresIn },
        };
      },
      { isolationLevel: 'SERIALIZABLE', maxRetries: 1 },
    );
  } catch (error) {
    if (error instanceof ReuseDetected) {
      // The transaction has already rolled back; revoke durably now.
      return handleReuse(error.session, context);
    }
    throw error;
  }
}

export async function revokeByRefreshToken(refreshToken: string, context: AuditContext): Promise<void> {
  await withTransaction(async (tx) => {
    const session = await repo.findSessionByRefreshHash(hashToken(refreshToken), tx);
    // Logging out with an unknown token is not an error worth reporting: it
    // ends in the same state the caller wanted, and reporting it would confirm
    // whether a token exists.
    if (!session) return;
    await repo.revokeSessionFamily(session.family_id, 'logout', tx);
    await recordAuthEvent(
      'SESSION_REVOKED',
      { ...context, actorUserId: session.user_id },
      { familyId: session.family_id, scope: 'family' },
      tx,
    );
  });
}

export async function revokeAllSessions(
  userId: string,
  reason: string,
  context: AuditContext,
  tx?: Tx,
): Promise<number> {
  const revoked = await repo.revokeAllUserSessions(userId, reason, tx);
  await recordAuthEvent(
    'SESSION_REVOKED',
    { ...context, actorUserId: userId },
    { scope: 'all', reason, sessionsRevoked: revoked },
    tx,
  );
  return revoked;
}

/** An access token is only usable while its session is still live. */
export async function isSessionActive(sessionId: string): Promise<boolean> {
  return repo.isSessionActive(sessionId);
}
