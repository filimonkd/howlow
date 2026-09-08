/**
 * Channel-independent error taxonomy.
 *
 * Domain and application services throw these. Channel adapters (HTTP,
 * Telegram) translate them into a transport-specific response. No business
 * meaning is attached to HTTP status codes anywhere else.
 */

export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'IDEMPOTENCY_REPLAY',
  'RATE_LIMITED',
  'INSUFFICIENT_FUNDS',
  'AUCTION_CLOSED',
  'BID_DUPLICATE',
  'BID_LIMIT_REACHED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface AppErrorOptions {
  readonly code: ErrorCode;
  readonly message: string;
  /** Safe to show a user of any channel. Never contains internal detail. */
  readonly publicMessage?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly publicMessage: string;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(options: AppErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = options.code;
    this.publicMessage = options.publicMessage ?? options.message;
    this.details = options.details;
  }

  static is(value: unknown): value is AppError {
    return value instanceof AppError;
  }
}

export const notFound = (message: string, details?: Record<string, unknown>): AppError =>
  new AppError(
    details === undefined ? { code: 'NOT_FOUND', message } : { code: 'NOT_FOUND', message, details },
  );

export const validationFailed = (message: string, details?: Record<string, unknown>): AppError =>
  new AppError(
    details === undefined
      ? { code: 'VALIDATION_FAILED', message }
      : { code: 'VALIDATION_FAILED', message, details },
  );

export const unauthenticated = (message = 'Authentication required'): AppError =>
  new AppError({ code: 'UNAUTHENTICATED', message });

export const forbidden = (message = 'Not permitted'): AppError =>
  new AppError({ code: 'FORBIDDEN', message });

export const conflict = (message: string): AppError => new AppError({ code: 'CONFLICT', message });

export const internal = (message: string, cause?: unknown): AppError =>
  new AppError({
    code: 'INTERNAL',
    message,
    publicMessage: 'An unexpected error occurred',
    ...(cause === undefined ? {} : { cause }),
  });
