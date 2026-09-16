import type { Channel } from '@howlow/shared';
import { getPool, type Tx } from '../db/index.js';
import { getLogger } from './logger.js';

/**
 * The audit-row primitive.
 *
 * `audit_logs` is append-only in the database, so these rows are evidence.
 * Modules wrap this with their own typed event vocabulary — the auth module
 * has its own writer from Phase 2 and the wallet from Phase 3; catalog and
 * auctions share this one rather than adding a third and fourth copy of the
 * same INSERT.
 *
 * `details` is always assembled by the calling module from domain facts, never
 * forwarded from a request body, so no secret can reach an audit row by
 * arriving under an unexpected key.
 */
export interface AuditEntry {
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly actorUserId?: string | undefined;
  readonly channel?: Channel | undefined;
  readonly details?: Record<string, unknown> | undefined;
  readonly before?: Record<string, unknown> | undefined;
  readonly requestId?: string | undefined;
  readonly ipAddress?: string | undefined;
  readonly userAgent?: string | undefined;
}

/**
 * Write one audit row and a matching structured log line.
 *
 * Pass `tx` to write inside the transaction that made the change — a record of
 * something that rolled back would be a record of something that never
 * happened.
 */
export async function writeAuditLog(entry: AuditEntry, tx?: Tx): Promise<void> {
  const runner = tx ?? getPool();
  await runner.query(
    `INSERT INTO audit_logs
       (actor_user_id, actor_channel, action, entity_type, entity_id,
        before_data, after_data, ip_address, user_agent, request_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)`,
    [
      entry.actorUserId ?? null,
      entry.channel ?? 'system',
      entry.action,
      entry.entityType,
      entry.entityId,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.details === undefined ? null : JSON.stringify(entry.details),
      entry.ipAddress ?? null,
      entry.userAgent ?? null,
      entry.requestId ?? null,
    ],
  );
  getLogger().info(
    { event: entry.action, entityType: entry.entityType, entityId: entry.entityId, ...entry.details },
    entry.action,
  );
}

/** Non-secret request context, carried through to the audit row. */
export interface OperationContext {
  readonly actorUserId?: string | undefined;
  readonly channel?: Channel | undefined;
  readonly requestId?: string | undefined;
  readonly ipAddress?: string | undefined;
  readonly userAgent?: string | undefined;
}
