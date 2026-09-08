import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { REQUEST_ID_HEADER } from '@howlow/shared';
import { runWithContext } from '../../../shared/index.js';

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** Assign a correlation id and open an async context for the request. */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(REQUEST_ID_HEADER);
  const id = incoming !== undefined && SAFE_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, id);
  runWithContext({ requestId: id, channel: 'web' }, () => {
    next();
  });
}
