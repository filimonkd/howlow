import type { Request, Response } from 'express';
import { AppError } from '@howlow/shared';
import * as auctions from '../../../modules/auctions/index.js';
import * as results from '../../../modules/results/index.js';
import { referenceParam } from './http-helpers.js';

/**
 * Result endpoints.
 *
 * No logic here, as everywhere in this directory: the winner was decided by
 * `modules/results` when the auction closed, and these two handlers read what
 * it wrote. **Nothing in the HTTP channel computes a winner**, ranks amounts
 * or counts uniqueness — a channel that could would be a second answer to the
 * question the whole platform exists to answer once.
 *
 * ## What each endpoint may say
 *
 * The public result carries the winning amount, the frozen statistics and the
 * checksum. It names nobody. The winning amount is the answer the auction was
 * asking and every bidder needs it; who won is told to the winner, on their
 * own endpoint.
 *
 * Before the close there is no result at all, so `404` is the honest answer
 * and there is nothing to leak. That matters more than it looks: the
 * uniqueness signal the bidding engine withholds during an auction must not
 * become readable a moment early through a result endpoint that answered
 * partially.
 */

/**
 * GET /api/v1/auctions/:publicId/result
 *
 * The public result of a closed auction.
 *
 * Resolved through `getPublicAuction` so a draft or rejected auction is
 * `404` rather than confirming it exists — the same rule the auction detail
 * endpoint follows, and for the same reason.
 */
export async function getResult(req: Request, res: Response): Promise<void> {
  const reference = referenceParam(req, 'publicId');
  const auction = await auctions.getPublicAuction(reference);

  const result = await results.getResult(auction.id);
  if (!result) throw results.resultNotFound(auction.id);

  res.status(200).json(results.toResultDto(result, auction.currency));
}

/**
 * GET /api/v1/auctions/:publicId/result/me
 *
 * The caller's own outcome: whether they won, what the winning amount was,
 * their own bid count and fees, what came back, and — for the winner only —
 * the order awaiting payment.
 *
 * Everything in the response is either public or the caller's own. There is no
 * parameter that could make it return somebody else's, and no field that
 * describes another bidder.
 */
export async function getMyResult(req: Request, res: Response): Promise<void> {
  const auth = req.auth;
  if (!auth) throw new AppError({ code: 'UNAUTHENTICATED', message: 'getMyResult requires auth' });

  const reference = referenceParam(req, 'publicId');
  const auction = await auctions.getPublicAuction(reference);

  const outcome = await results.getMyOutcome({
    auctionId: auction.id,
    userId: auth.userId,
    currency: auction.currency,
  });
  if (!outcome) throw results.resultNotFound(auction.id);

  res.status(200).json(outcome);
}
