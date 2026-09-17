import {
  myBidsSchema,
  submitBidsResultSchema,
  type BidErrorCode,
  type MyBidsDto,
  type SubmitBidsResult,
} from '@howlow/shared';
import { apiFetch, ApiRequestError } from './api.js';
import { getAccessToken } from './auth-api.js';

/**
 * Bidding, from the browser.
 *
 * The website has no bidding logic of its own: it posts amounts to the one
 * endpoint and renders what comes back. Every rule — the ladder, the limit,
 * the fee, whether the auction is open — is decided by the engine, so a
 * browser with stale terms produces a refusal rather than a wrong bid.
 */

/**
 * One idempotency key per *intention*, reused for every retry of it.
 *
 * This is the whole contract. The key is minted when the user commits to a
 * particular set of amounts and kept until that submission resolves: a network
 * retry, a double-clicked button, or a reload that resubmits all carry the
 * same key, so the engine replays the first answer instead of charging again.
 * A fresh key for each attempt would turn a dropped response into a second
 * charge, which is exactly the failure idempotency exists to prevent.
 *
 * A new key is minted only when the user changes what they are submitting.
 */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/**
 * The bearer token, if the session has one.
 *
 * `apiFetch` does not add it: the website's public reads must go out without
 * one, so authorization is the caller's to attach. Both bid endpoints are
 * authenticated, and forgetting this here is what made the first browser run
 * of the real UI answer 401 with a perfectly correct request body.
 */
function authorized(): Record<string, string> {
  const token = getAccessToken();
  return token === undefined ? {} : { Authorization: `Bearer ${token}` };
}

export function submitBids(input: {
  reference: string;
  amountsMinor: readonly string[];
  idempotencyKey: string;
}): Promise<SubmitBidsResult> {
  return apiFetch(
    `/auctions/${encodeURIComponent(input.reference)}/bids`,
    (value) => submitBidsResultSchema.parse(value),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': input.idempotencyKey,
        ...authorized(),
      },
      body: JSON.stringify({ amountsMinor: input.amountsMinor }),
    },
  );
}

/** The caller's own bids. There is no endpoint for anyone else's. */
export function fetchMyBids(reference: string): Promise<MyBidsDto> {
  return apiFetch(`/auctions/${encodeURIComponent(reference)}/bids`, (value) => myBidsSchema.parse(value), {
    headers: authorized(),
  });
}

/**
 * A refusal in words a bidder can act on.
 *
 * Keyed on `details.bidError`, the stable code the API promises, not on the
 * message — a message is for a person and may be reworded, while a code is
 * part of the contract. Falling back to the server's own sentence is
 * deliberate: it is already written for the public, so an unmapped code
 * degrades to something true rather than to "something went wrong".
 *
 * Note what none of these say. No refusal here tells the bidder that an amount
 * is taken *by someone else*, because no refusal on the server does either;
 * `DUPLICATE_AMOUNT` is only ever about the caller's own bids.
 */
const MESSAGES: Record<BidErrorCode, string> = {
  AUCTION_NOT_LIVE: 'This auction is not taking bids right now.',
  AUCTION_NOT_STARTED: 'This auction has not opened yet.',
  AUCTION_ENDED: 'Bidding has closed on this auction.',
  AMOUNT_OUT_OF_RANGE: 'One of your amounts is outside the allowed range.',
  AMOUNT_NOT_ALIGNED: 'One of your amounts is not on the allowed bid steps.',
  AMOUNT_INVALID: 'Bid amounts must be whole numbers.',
  DUPLICATE_AMOUNT: 'You have already bid one of those amounts. Change it and try again.',
  BID_LIMIT_EXCEEDED: 'That is more bids than you have left on this auction.',
  TOO_MANY_AMOUNTS: 'That is more bids than one submission may carry.',
  INSUFFICIENT_FUNDS: 'Your wallet does not have enough to cover the fee. Top it up and try again.',
  WALLET_FROZEN: 'Your wallet is on hold, so bids cannot be charged. Please contact support.',
  IDEMPOTENCY_CONFLICT: 'That submission was already used for different amounts. Start again.',
  IDEMPOTENCY_IN_PROGRESS: 'That submission is still being processed. Try again in a moment.',
  BIDDER_NOT_ELIGIBLE: 'Your account cannot place bids yet.',
  RATE_LIMITED: 'You are bidding very quickly. Wait a moment and try again.',
};

export function bidErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    const code = error.details?.['bidError'];
    if (typeof code === 'string' && code in MESSAGES) {
      return MESSAGES[code as BidErrorCode];
    }
    if (error.code === 'UNAUTHENTICATED') return 'Please sign in to place a bid.';
    if (error.code === 'RATE_LIMITED') return MESSAGES.RATE_LIMITED;
    return error.message;
  }
  return 'Your bids could not be submitted. Please try again.';
}

/** True when retrying the same submission is the right move. */
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) return true;
  const code = error.details?.['bidError'];
  return code === 'IDEMPOTENCY_IN_PROGRESS' || error.code === 'INTERNAL';
}
