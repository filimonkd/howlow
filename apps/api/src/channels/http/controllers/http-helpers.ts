import type { Request } from 'express';
import type { Channel } from '@howlow/shared';
import { AppError, REQUEST_ID_HEADER } from '@howlow/shared';
import type { OperationContext } from '../../../shared/index.js';

/**
 * Shared controller plumbing.
 *
 * Nothing here decides anything: it reads non-secret request context and path
 * parameters so each controller does not repeat the same six lines.
 */
export function operationContext(req: Request, channel: Channel): OperationContext {
  const requestId = req.res?.getHeader(REQUEST_ID_HEADER);
  return {
    channel,
    ipAddress: req.ip,
    userAgent: req.header('user-agent'),
    requestId: typeof requestId === 'string' ? requestId : undefined,
  };
}

/**
 * A uuid path parameter.
 *
 * Express types a param as `string | string[]` because a repeated segment can
 * match more than once, and a malformed value must produce a 400 rather than
 * reaching the database and surfacing as a 500 — which is what a bare
 * `req.params[...]` would do for `/products/not-a-uuid`.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function uuidParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: `Path parameter ${name} is not a uuid: ${String(value)}`,
      publicMessage: 'That identifier is not valid.',
    });
  }
  return value;
}

/** A path parameter that may be a uuid or a slug, since both are public references. */
export function referenceParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.length === 0 || value.length > 160) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: `Path parameter ${name} is missing or unusable`,
      publicMessage: 'That identifier is not valid.',
    });
  }
  return value;
}

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** An opaque `<timestamp>|<id>` pagination cursor. */
export function encodeCursor(input: { at: Date; id: string }): string {
  return Buffer.from(`${input.at.toISOString()}|${input.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(value: string): { at: Date; id: string } {
  const [timestamp, id] = Buffer.from(value, 'base64url').toString('utf8').split('|');
  const at = timestamp === undefined ? new Date(Number.NaN) : new Date(timestamp);
  if (id === undefined || id === '' || Number.isNaN(at.getTime())) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'Malformed pagination cursor',
      publicMessage: 'That page cursor is not valid.',
    });
  }
  return { at, id };
}
