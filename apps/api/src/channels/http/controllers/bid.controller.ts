import type { Request, Response } from 'express';
import { AppError, submitBidsSchema } from '@howlow/shared';
import * as bidding from '../../../modules/bidding/index.js';
import { operationContext, referenceParam } from './http-helpers.js';

/**
 * Bid endpoints.
 *
 * This file contains no bidding logic whatsoever, and that is the point. It
 * reads a body, a header and the authenticated caller, hands them to
 * `bidService.submitBids()`, and serialises what comes back. The Telegram
 * handler does the same thing with a chat message instead of a request. One
 * engine, two adapters.
 *
 * What is deliberately *not* here: no SQL, no wallet call, no auction status
 * check, no bid counting, and no mapping of amounts to anything resembling a
 * uniqueness signal.
 */

/**
 * `Idempotency-Key` is required, not optional.
 *
 * Bidding moves money. A client that retries after a timeout without a key
 * would have no way to distinguish "my bids were placed" from "my bids were
 * not placed", and the safe assumption — retry — would charge twice. Requiring
 * it makes the safe assumption correct.
 *
 * Minimum length rather than a strict uuid: the contract asks for a UUID, and
 * any opaque token of reasonable length serves the same purpose, so a client
 * using its own request id is not punished for it.
 */
function requireIdempotencyKey(req: Request): string {
  const header = req.header('idempotency-key')?.trim();
  if (header === undefined || header.length < 8 || header.length > 255) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'Missing or unusable Idempotency-Key header',
      publicMessage: 'An Idempotency-Key header of 8 to 255 characters is required to place bids.',
    });
  }
  return header;
}

/**
 * An opaque client fingerprint, if the client sent one.
 *
 * Fraud evidence, nothing more: no rule reads it, and a request without it is
 * processed identically. Bounded and shape-checked here so a client cannot use
 * the header to write arbitrary length into the bid row — the column has its
 * own CHECK behind this.
 */
function deviceHash(req: Request): string | undefined {
  const header = req.header('x-device-hash')?.trim();
  if (header === undefined) return undefined;
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(header)) return undefined;
  return header;
}

/**
 * POST /api/v1/auctions/:publicId/bids
 *
 * One or more amounts, atomically. A single bid is a batch of one.
 *
 * 201 on acceptance. A replayed request also answers 201 with the original
 * body — the outcome it reports is true either way, and reporting it
 * differently would make a network retry look like a different result.
 */
export async function submitBids(req: Request, res: Response): Promise<void> {
  const auth = req.auth;
  if (!auth) throw new AppError({ code: 'UNAUTHENTICATED', message: 'submitBids requires auth' });

  const reference = referenceParam(req, 'publicId');
  const idempotencyKey = requireIdempotencyKey(req);
  const body = submitBidsSchema.parse(req.body);

  const outcome = await bidding.submitBids(
    {
      userId: auth.userId,
      auctionReference: reference,
      amountsMinor: body.amountsMinor,
      idempotencyKey,
      channel: 'web',
      ...(req.res?.getHeader('x-request-id') !== undefined
        ? { requestId: String(req.res.getHeader('x-request-id')) }
        : {}),
      ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
      ...(deviceHash(req) !== undefined ? { deviceHash: deviceHash(req) } : {}),
    },
    operationContext(req, 'web'),
  );

  res.status(201).json(bidding.toSubmitResultDto(outcome));
}

/**
 * GET /api/v1/auctions/:publicId/bids
 *
 * The caller's own bids, and what they may still do. Never anyone else's:
 * there is no endpoint on HOWLOW that returns another bidder's amounts, or how
 * many bidders hold one, because either would decide the auction for whoever
 * asked.
 */
export async function listMyBids(req: Request, res: Response): Promise<void> {
  const auth = req.auth;
  if (!auth) throw new AppError({ code: 'UNAUTHENTICATED', message: 'listMyBids requires auth' });

  const result = await bidding.getMyBids({
    userId: auth.userId,
    auctionReference: referenceParam(req, 'publicId'),
  });

  res.status(200).json(bidding.toMyBidsDto(result));
}
