import type { Channel } from '@howlow/shared';
import type { Tx } from '../../db/index.js';
import { getPool } from '../../db/index.js';

/**
 * Authentication audit events.
 *
 * `audit_logs` is append-only in the database, so these rows are evidence. Only
 * non-secret context is recorded: never a password, OTP, refresh token or link
 * token, and never anything from which one could be reconstructed.
 */
export const AUTH_EVENTS = [
  'USER_REGISTERED',
  'PHONE_VERIFIED',
  'LOGIN_SUCCESS',
  'LOGIN_FAILED',
  'PASSWORD_SET',
  'PASSWORD_CHANGED',
  'PASSWORD_RESET_REQUESTED',
  'PASSWORD_RESET_COMPLETED',
  'SESSION_CREATED',
  'SESSION_REVOKED',
  'REFRESH_ROTATED',
  'REFRESH_REUSE_DETECTED',
  'TELEGRAM_LINK_CREATED',
  'TELEGRAM_LINKED',
  'TELEGRAM_UNLINKED',
  'ACCOUNT_LOCKED',
] as const;

export type AuthEvent = (typeof AUTH_EVENTS)[number];

export interface AuditContext {
  readonly actorUserId?: string | undefined;
  readonly channel: Channel;
  readonly ipAddress?: string | undefined;
  readonly userAgent?: string | undefined;
  readonly requestId?: string | undefined;
}

/** Keys that must never reach an audit row, whatever a caller passes. */
const FORBIDDEN_KEYS = new Set([
  'password',
  'newpassword',
  'currentpassword',
  'code',
  'otp',
  'token',
  'refreshtoken',
  'accesstoken',
  'secret',
  'hash',
  'passwordhash',
  'codehash',
  'tokenhash',
]);

function scrub(details: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    safe[key] = FORBIDDEN_KEYS.has(key.toLowerCase().replace(/[_-]/g, '')) ? '[redacted]' : value;
  }
  return safe;
}

export async function recordAuthEvent(
  event: AuthEvent,
  context: AuditContext,
  details: Record<string, unknown> = {},
  tx?: Tx,
): Promise<void> {
  const runner = tx ?? getPool();
  await runner.query(
    `INSERT INTO audit_logs
       (actor_user_id, actor_channel, action, entity_type, entity_id,
        after_data, ip_address, user_agent, request_id)
     VALUES ($1, $2, $3, 'auth', $4, $5::jsonb, $6, $7, $8)`,
    [
      context.actorUserId ?? null,
      context.channel,
      event,
      context.actorUserId ?? null,
      JSON.stringify(scrub(details)),
      context.ipAddress ?? null,
      context.userAgent ?? null,
      context.requestId ?? null,
    ],
  );
}
