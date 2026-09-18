import {
  auctionResultSchema,
  myAuctionOutcomeSchema,
  type AuctionResultDto,
  type MyAuctionOutcomeDto,
} from '@howlow/shared';
import { apiFetch, ApiRequestError } from './api.js';
import { getAccessToken } from './auth-api.js';

/**
 * Auction results, from the browser.
 *
 * The website reads results; it never derives one. There is no code here that
 * counts amounts, ranks them or works out which stood alone — the winner was
 * decided by the backend when the auction closed, and this fetches what it
 * published. A browser that computed a winner would be a second answer to the
 * question the platform exists to answer once, and the two would eventually
 * disagree in front of a bidder.
 */

/**
 * The bearer token, if the session has one.
 *
 * `apiFetch` does not attach it, because the public result must be readable
 * without one. Only the caller's own outcome needs it — and forgetting this is
 * what made the first browser run of the Phase 5 bid panel answer 401 with a
 * perfectly correct request.
 */
function authorized(): Record<string, string> {
  const token = getAccessToken();
  return token === undefined ? {} : { Authorization: `Bearer ${token}` };
}

/**
 * The public result: the winning amount, the statistics, the checksum.
 *
 * Resolves to `undefined` when the auction has not been decided, which is the
 * ordinary case for anything still running and is not an error worth showing.
 */
export async function fetchResult(reference: string): Promise<AuctionResultDto | undefined> {
  try {
    return await apiFetch(`/auctions/${encodeURIComponent(reference)}/result`, (value) =>
      auctionResultSchema.parse(value),
    );
  } catch (error) {
    if (isNotDecided(error)) return undefined;
    throw error;
  }
}

/** The caller's own outcome. There is no endpoint for anybody else's. */
export async function fetchMyOutcome(reference: string): Promise<MyAuctionOutcomeDto | undefined> {
  if (getAccessToken() === undefined) return undefined;
  try {
    return await apiFetch(
      `/auctions/${encodeURIComponent(reference)}/result/me`,
      (value) => myAuctionOutcomeSchema.parse(value),
      { headers: authorized() },
    );
  } catch (error) {
    if (isNotDecided(error)) return undefined;
    throw error;
  }
}

/**
 * "This auction has no result yet" rather than a failure.
 *
 * Keyed on `details.resultError`, the stable code the API promises, with the
 * transport status as a fallback. An auction still running answers 404 here by
 * design: before the close there is no result to read, and there must not be —
 * a partial answer would leak the uniqueness signal the auction withholds.
 */
function isNotDecided(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) return false;
  return error.details?.['resultError'] === 'RESULT_NOT_FOUND' || error.code === 'NOT_FOUND';
}
