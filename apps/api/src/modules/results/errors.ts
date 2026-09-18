import { AppError, type ResultErrorCode } from '@howlow/shared';

/**
 * Result failures.
 *
 * There are few, because closing is a worker operation rather than a request:
 * most of what could go wrong is a state the service treats as a no-op instead
 * of an error, which is what makes replaying a closing job safe. What is left
 * is the handful of conditions that mean the data is not what the algorithm
 * requires — and those must be loud, because computing a winner from the wrong
 * bid set is worse than computing none.
 *
 * Each carries a stable `details.resultError` from the shared `RESULT_ERRORS`
 * list, the same arrangement the bidding module uses: the transport `code`
 * decides the HTTP status, and the result code is what a client may branch on.
 */

function resultError(
  resultCode: ResultErrorCode,
  appCode: 'CONFLICT' | 'NOT_FOUND' | 'INTERNAL',
  message: string,
  publicMessage: string,
  details: Record<string, unknown> = {},
): AppError {
  return new AppError({
    code: appCode,
    message,
    publicMessage,
    details: { resultError: resultCode, ...details },
  });
}

/**
 * Closing was attempted on an auction that is still accepting bids.
 *
 * **The invariant this protects:** no result may be calculated before the
 * auction has ended. A winner computed from an unfrozen set is not a winner —
 * the next bid could take the winning amount and make it non-unique — so this
 * is refused rather than approximated.
 */
export const auctionNotClosed = (auctionId: string, status: string): AppError =>
  resultError(
    'AUCTION_NOT_CLOSED',
    'CONFLICT',
    `Auction ${auctionId} is ${status}; bidding must have stopped before a result is calculated`,
    'This auction has not finished yet.',
    { status },
  );

/** Asked for the result of an auction that has none — usually one still running. */
export const resultNotFound = (auctionId: string): AppError =>
  resultError(
    'RESULT_NOT_FOUND',
    'NOT_FOUND',
    `Auction ${auctionId} has no result`,
    'This auction has not been decided yet.',
  );

/**
 * A result exists but the winning bid it names is not a valid bid of this
 * auction.
 *
 * Only reachable through data corruption or a manual edit, and it is raised
 * rather than worked around: silently picking a different winner is precisely
 * the thing the whole phase exists to prevent.
 */
export const resultInconsistent = (auctionId: string, detail: string): AppError =>
  resultError(
    'RESULT_INCONSISTENT',
    'INTERNAL',
    `Result for auction ${auctionId} is inconsistent: ${detail}`,
    'This result could not be verified. Support has been notified.',
    { detail },
  );
