import { AppError, formatMoney, type ErrorCode, type Money } from '@howlow/shared';

/**
 * Stable wallet error codes. Callers and channels branch on these, never on a
 * message; a raw PostgreSQL exception never reaches a client.
 */
export const WALLET_ERRORS = [
  'WALLET_NOT_FOUND',
  'WALLET_FROZEN',
  'INVALID_AMOUNT',
  'INSUFFICIENT_FUNDS',
  'DUPLICATE_OPERATION',
  'IDEMPOTENCY_CONFLICT',
  'LEDGER_INTEGRITY_ERROR',
  'UNAUTHORIZED_WALLET_OPERATION',
  'CURRENCY_MISMATCH',
] as const;

export type WalletErrorCode = (typeof WALLET_ERRORS)[number];

/** Wallet failures carry their own code in `details.walletError`. */
function walletError(
  walletCode: WalletErrorCode,
  appCode: ErrorCode,
  message: string,
  publicMessage: string,
  details: Record<string, unknown> = {},
): AppError {
  return new AppError({
    code: appCode,
    message,
    publicMessage,
    details: { walletError: walletCode, ...details },
  });
}

export const walletNotFound = (userId: string): AppError =>
  walletError(
    'WALLET_NOT_FOUND',
    'NOT_FOUND',
    `No wallet for user ${userId}`,
    'No wallet could be found for this account.',
  );

export const walletFrozen = (walletId: string, reason: string | null): AppError =>
  walletError(
    'WALLET_FROZEN',
    'FORBIDDEN',
    `Wallet ${walletId} is frozen: ${reason ?? 'no reason recorded'}`,
    'This wallet is currently frozen. Please contact support.',
  );

export const invalidAmount = (detail: string): AppError =>
  walletError(
    'INVALID_AMOUNT',
    'VALIDATION_FAILED',
    `Invalid wallet amount: ${detail}`,
    'That amount is not valid.',
  );

/**
 * The requested debit exceeds the balance. The public message deliberately
 * omits the balance: a caller who can attempt a debit can already read the
 * wallet, but an error string is the wrong place to disclose it.
 */
export const insufficientFunds = (requested: Money, available: Money): AppError =>
  walletError(
    'INSUFFICIENT_FUNDS',
    'INSUFFICIENT_FUNDS',
    `Requested ${formatMoney(requested)} but only ${formatMoney(available)} is available`,
    'There is not enough balance in this wallet for that operation.',
  );

export const duplicateOperation = (key: string): AppError =>
  walletError(
    'DUPLICATE_OPERATION',
    'CONFLICT',
    `Operation with idempotency key ${key} has already been applied`,
    'That operation has already been processed.',
  );

/**
 * The same idempotency key arrived with a different request. Replaying the
 * stored response would apply the caller's intent to the wrong request, so the
 * only safe answer is to refuse.
 */
export const idempotencyConflict = (key: string): AppError =>
  walletError(
    'IDEMPOTENCY_CONFLICT',
    'CONFLICT',
    `Idempotency key ${key} was reused with different request parameters`,
    'This request reuses an earlier idempotency key with different details.',
  );

export const ledgerIntegrityError = (walletId: string, detail: string): AppError =>
  walletError(
    'LEDGER_INTEGRITY_ERROR',
    'INTERNAL',
    `Ledger integrity check failed for wallet ${walletId}: ${detail}`,
    'A problem was found with this wallet. Support has been notified.',
    { walletId },
  );

export const unauthorizedWalletOperation = (detail: string): AppError =>
  walletError(
    'UNAUTHORIZED_WALLET_OPERATION',
    'FORBIDDEN',
    `Unauthorized wallet operation: ${detail}`,
    'You do not have permission to perform that wallet operation.',
  );

export const currencyMismatch = (expected: string, received: string): AppError =>
  walletError(
    'CURRENCY_MISMATCH',
    'VALIDATION_FAILED',
    `Wallet holds ${expected} but the operation specified ${received}`,
    'That currency does not match this wallet.',
  );
