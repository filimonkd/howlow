import type { NextFunction, Request, Response } from 'express';
import { AppError, REQUEST_ID_HEADER, type ApiError, type ErrorCode } from '@howlow/shared';
import { getLogger } from '../../../shared/index.js';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_REPLAY: 200,
  RATE_LIMITED: 429,
  INSUFFICIENT_FUNDS: 422,
  AUCTION_CLOSED: 409,
  BID_DUPLICATE: 409,
  BID_LIMIT_REACHED: 409,
  INTERNAL: 500,
};

/**
 * The only place in the HTTP channel that maps domain errors onto transport
 * semantics. Business code never sees a status code.
 */
export function errorHandler(error: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(error);
    return;
  }

  const requestIdHeader = res.getHeader(REQUEST_ID_HEADER);
  const requestId = typeof requestIdHeader === 'string' ? requestIdHeader : undefined;

  if (AppError.is(error)) {
    const status = STATUS_BY_CODE[error.code];
    if (status >= 500) {
      getLogger().error({ err: error, requestId, path: req.path }, 'Request failed');
    } else {
      getLogger().warn({ code: error.code, requestId, path: req.path }, 'Request rejected');
    }
    res.status(status).json(toBody(error.code, error.publicMessage, requestId, error.details));
    return;
  }

  getLogger().error({ err: error, requestId, path: req.path }, 'Unhandled error');
  res.status(500).json(toBody('INTERNAL', 'An unexpected error occurred', requestId));
}

/** 404 for any route the HTTP channel does not expose. */
export function notFoundHandler(_req: Request, res: Response): void {
  const requestIdHeader = res.getHeader(REQUEST_ID_HEADER);
  res
    .status(404)
    .json(
      toBody(
        'NOT_FOUND',
        'Route not found',
        typeof requestIdHeader === 'string' ? requestIdHeader : undefined,
      ),
    );
}

function toBody(
  code: ErrorCode,
  message: string,
  requestId: string | undefined,
  details?: Readonly<Record<string, unknown>>,
): ApiError {
  return {
    error: {
      code,
      message,
      ...(requestId === undefined ? {} : { requestId }),
      ...(details === undefined ? {} : { details }),
    },
  };
}
