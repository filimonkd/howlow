import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { AppError, type Channel } from '@howlow/shared';
import { loadConfig } from '../../config/index.js';

/**
 * Access tokens are short-lived JWTs; refresh tokens are opaque random strings.
 *
 * Only a SHA-256 digest of a refresh token is stored. SHA-256 rather than
 * argon2 because the token is already 256 bits of entropy from a CSPRNG — there
 * is no low-entropy secret to slow an attacker down over, and refresh happens
 * often enough that a memory-hard hash would be a self-inflicted denial of
 * service.
 */
export interface AccessTokenClaims extends JWTPayload {
  readonly sub: string;
  readonly sid: string;
  readonly channel: Channel;
  readonly roles: readonly string[];
}

let cachedSecret: Uint8Array | undefined;

function secret(): Uint8Array {
  cachedSecret ??= new TextEncoder().encode(loadConfig().JWT_SECRET);
  return cachedSecret;
}

const ISSUER = 'howlow';
const AUDIENCE = 'howlow-clients';

export async function signAccessToken(claims: {
  userId: string;
  sessionId: string;
  channel: Channel;
  roles: readonly string[];
}): Promise<{ token: string; expiresIn: number }> {
  const env = loadConfig();
  const expiresIn = env.JWT_ACCESS_TTL_SECONDS;
  const token = await new SignJWT({
    sid: claims.sessionId,
    channel: claims.channel,
    roles: [...claims.roles],
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${expiresIn}s`)
    .sign(secret());

  return { token, expiresIn };
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, secret(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });
    if (typeof payload.sub !== 'string' || typeof payload['sid'] !== 'string') {
      throw new Error('malformed claims');
    }
    return payload as AccessTokenClaims;
  } catch {
    throw new AppError({
      code: 'UNAUTHENTICATED',
      message: 'Access token is invalid or expired',
      publicMessage: 'Your session has expired. Please sign in again.',
    });
  }
}

/** 256 bits from the system CSPRNG, URL-safe. */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time comparison for values derived from secrets. */
export function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
