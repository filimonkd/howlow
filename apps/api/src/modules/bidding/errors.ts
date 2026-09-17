import { AppError, type BidErrorCode, type ErrorCode } from '@howlow/shared';

/**
 * Bid refusals.
 *
 * Every one carries a stable `details.bidError` from the shared `BID_ERRORS`
 * list, so both channels map the same code to their own wording and neither
 * has to parse a message. The transport `code` is what decides the HTTP
 * status; the bid code is what a client may branch on.
 *
 * Refusals say what is wrong without saying anything about other bidders. In
 * particular `DUPLICATE_AMOUNT` names an amount only when the amount is the
 * *caller's own* — telling someone their 27 collides with a stranger's would
 * hand them the uniqueness signal the auction exists to withhold.
 */
function bidError(
  bidCode: BidErrorCode,
  appCode: ErrorCode,
  message: string,
  publicMessage: string,
  details: Record<string, unknown> = {},
): AppError {
  return new AppError({
    code: appCode,
    message,
    publicMessage,
    details: { bidError: bidCode, ...details },
  });
}

// ---------------------------------------------------------------------------
// Auction state
// ---------------------------------------------------------------------------

export const auctionNotLive = (auctionId: string, status: string): AppError =>
  bidError(
    'AUCTION_NOT_LIVE',
    'AUCTION_CLOSED',
    `Auction ${auctionId} is ${status} and does not accept bids`,
    'This auction is not accepting bids.',
    { status },
  );

/**
 * The auction is live by status but the database clock says it has not opened.
 *
 * A separate code from `AUCTION_NOT_LIVE` because the remedy differs: a bidder
 * who is early should wait, and the client can say when.
 */
export const auctionNotStarted = (auctionId: string, startsAt: Date): AppError =>
  bidError(
    'AUCTION_NOT_STARTED',
    'AUCTION_CLOSED',
    `Auction ${auctionId} starts at ${startsAt.toISOString()}`,
    'This auction has not started yet.',
    { startsAt: startsAt.toISOString() },
  );

export const auctionEnded = (auctionId: string, endsAt: Date): AppError =>
  bidError(
    'AUCTION_ENDED',
    'AUCTION_CLOSED',
    `Auction ${auctionId} ended at ${endsAt.toISOString()}`,
    'Bidding on this auction has closed.',
    { endsAt: endsAt.toISOString() },
  );

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

export const amountOutOfRange = (amountMinor: bigint, minMinor: bigint, maxMinor: bigint): AppError =>
  bidError(
    'AMOUNT_OUT_OF_RANGE',
    'VALIDATION_FAILED',
    `Bid ${amountMinor.toString()} is outside ${minMinor.toString()}..${maxMinor.toString()}`,
    'That amount is outside the allowed bid range.',
    {
      amountMinor: amountMinor.toString(),
      minBidMinor: minMinor.toString(),
      maxBidMinor: maxMinor.toString(),
    },
  );

/**
 * The amount is in range but not on the ladder.
 *
 * The valid amounts are `min, min + increment, min + 2·increment, …`, so a bid
 * of 150 in a 100..900 auction stepping by 100 is refused. The message carries
 * the increment so a client can round for the user rather than guess.
 */
export const amountNotAligned = (amountMinor: bigint, minMinor: bigint, incrementMinor: bigint): AppError =>
  bidError(
    'AMOUNT_NOT_ALIGNED',
    'VALIDATION_FAILED',
    `Bid ${amountMinor.toString()} is not ${minMinor.toString()} plus a multiple of ${incrementMinor.toString()}`,
    'That amount is not one of the allowed bid steps.',
    {
      amountMinor: amountMinor.toString(),
      minBidMinor: minMinor.toString(),
      bidIncrementMinor: incrementMinor.toString(),
    },
  );

export const amountInvalid = (raw: string): AppError =>
  bidError(
    'AMOUNT_INVALID',
    'VALIDATION_FAILED',
    `Bid amount ${raw} is not a positive integer`,
    'That is not a valid bid amount.',
    { amount: raw },
  );

export const tooManyAmounts = (count: number, max: number): AppError =>
  bidError(
    'TOO_MANY_AMOUNTS',
    'VALIDATION_FAILED',
    `Request carries ${String(count)} amounts; the maximum is ${String(max)}`,
    `A single submission may carry at most ${String(max)} bids.`,
    { count, max },
  );

// ---------------------------------------------------------------------------
// Duplicates and limits
// ---------------------------------------------------------------------------

/**
 * The caller already holds this amount, or asked for it twice in one request.
 *
 * Always about the caller's own bids. Two different users bidding the same
 * amount is not a duplicate and is never refused — it is the mechanism the
 * auction runs on.
 */
export const duplicateAmount = (amountsMinor: readonly bigint[]): AppError =>
  bidError(
    'DUPLICATE_AMOUNT',
    'BID_DUPLICATE',
    `Amounts already bid by this user: ${amountsMinor.map((a) => a.toString()).join(', ')}`,
    amountsMinor.length === 1
      ? 'You have already bid that amount.'
      : 'You have already bid some of those amounts.',
    { amountsMinor: amountsMinor.map((amount) => amount.toString()) },
  );

/** The database refused the insert on the duplicate index; we did not race it successfully. */
export const duplicateAmountUnknown = (): AppError =>
  bidError(
    'DUPLICATE_AMOUNT',
    'BID_DUPLICATE',
    'A bid in this batch duplicates one the user already holds',
    'You have already bid one of those amounts.',
  );

export const bidLimitExceeded = (bidCount: number, requested: number, max: number): AppError =>
  bidError(
    'BID_LIMIT_EXCEEDED',
    'BID_LIMIT_REACHED',
    `User holds ${String(bidCount)} of ${String(max)} bids and requested ${String(requested)} more`,
    max - bidCount <= 0
      ? 'You have used all your bids on this auction.'
      : `You have ${String(max - bidCount)} bid(s) left on this auction.`,
    { bidCount, requested, maxBidsPerUser: max, bidsRemaining: Math.max(0, max - bidCount) },
  );

// ---------------------------------------------------------------------------
// Eligibility and idempotency
// ---------------------------------------------------------------------------

export const bidderNotEligible = (userId: string, reason: string): AppError =>
  bidError('BIDDER_NOT_ELIGIBLE', 'FORBIDDEN', `User ${userId} may not bid: ${reason}`, reason);

export const idempotencyConflict = (key: string): AppError =>
  bidError(
    'IDEMPOTENCY_CONFLICT',
    'CONFLICT',
    `Idempotency key ${key} was already used for a different request`,
    'That submission key was already used for a different set of bids.',
  );

/**
 * A request with this key is still running.
 *
 * Returned rather than waiting: the first attempt holds row locks on the
 * auction and the wallet, so a second attempt that waited would sit on those
 * locks and could turn one slow request into a pile-up. A client retries.
 */
export const idempotencyInProgress = (key: string): AppError =>
  bidError(
    'IDEMPOTENCY_IN_PROGRESS',
    'CONFLICT',
    `Idempotency key ${key} is already being processed`,
    'That submission is still being processed. Please try again in a moment.',
  );

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Wallet refusals, restated in the bid vocabulary.
 *
 * The wallet module raises its own errors carrying `details.walletError`,
 * which is right for wallet callers. A bidding client is told to branch on
 * `details.bidError`, so a debit refused for insufficient funds would arrive
 * with the correct HTTP status and no bid code at all — and every client
 * mapping bid errors would fall through to a generic message on the two
 * failures bidders hit most. Found by probing the real endpoint, not by
 * reading the module.
 *
 * The wallet's own code is kept in `details.walletError` so nothing is lost
 * for debugging; what is added is the `bidError` the contract promises.
 */
export function asBidWalletError(error: AppError): AppError {
  const walletCode = error.details?.['walletError'];

  if (walletCode === 'INSUFFICIENT_FUNDS') {
    return bidError(
      'INSUFFICIENT_FUNDS',
      'INSUFFICIENT_FUNDS',
      error.message,
      'Your wallet does not have enough to cover the fee for those bids.',
      { ...error.details },
    );
  }
  if (walletCode === 'WALLET_FROZEN') {
    return bidError(
      'WALLET_FROZEN',
      'FORBIDDEN',
      error.message,
      'Your wallet is on hold, so bids cannot be charged. Please contact support.',
      { ...error.details },
    );
  }
  if (walletCode === 'IDEMPOTENCY_CONFLICT' || walletCode === 'DUPLICATE_OPERATION') {
    return bidError(
      'IDEMPOTENCY_CONFLICT',
      'CONFLICT',
      error.message,
      'That submission key was already used for a different charge.',
      { ...error.details },
    );
  }
  // Anything else — a currency mismatch, a ledger integrity failure — is not a
  // bidding condition and is not dressed up as one. It travels unchanged.
  return error;
}
