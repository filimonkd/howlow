import type { Request, Response } from 'express';
import {
  auctionListQuerySchema,
  auctionReasonSchema,
  createAuctionSchema,
  updateAuctionSchema,
} from '@howlow/shared';
import * as auctions from '../../../modules/auctions/index.js';
import * as catalog from '../../../modules/catalog/index.js';
import { requireAuth } from '../middleware/authenticate.js';
import { operationContext, referenceParam, uuidParam } from './http-helpers.js';

/**
 * Auction endpoints.
 *
 * No business logic and, in particular, **no status is ever set from here**:
 * every transition is a named lifecycle call, so there is no request shape that
 * can move an auction to an arbitrary state.
 */

// ---------------------------------------------------------------------------
// Public discovery
// ---------------------------------------------------------------------------

export async function listAuctions(req: Request, res: Response): Promise<void> {
  const query = auctionListQuerySchema.parse(req.query);
  const page = await auctions.listPublicAuctions({
    sort: query.sort,
    limit: query.limit,
    ...(query.status === undefined ? {} : { status: query.status }),
    ...(query.categorySlug === undefined ? {} : { categorySlug: query.categorySlug }),
    ...(query.sellerId === undefined ? {} : { sellerId: query.sellerId }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  });

  res.status(200).json({
    auctions: await Promise.all(
      page.auctions.map(async (auction) =>
        auctions.toSummaryDto(auction, await auctions.imagesForAuction(auction)),
      ),
    ),
    nextCursor: page.nextCursor === null ? null : auctions.encodeCursor(page.nextCursor),
  });
}

/**
 * One auction, by uuid or slug.
 *
 * The public payload carries no bid count, no bidder identity and no
 * uniqueness signal — revealing any of those would let a bidder
 * reverse-engineer the lowest unique bid.
 */
export async function getAuction(req: Request, res: Response): Promise<void> {
  // The *public* read, which refuses a draft, pending or suspended auction.
  const auction = await auctions.getPublicAuction(referenceParam(req, 'publicId'));
  const images = await auctions.imagesForAuction(auction);
  res.status(200).json(auctions.toDetailDto(auction, images));
}

// ---------------------------------------------------------------------------
// Seller
// ---------------------------------------------------------------------------

export async function listMyAuctions(req: Request, res: Response): Promise<void> {
  const { userId } = requireAuth(req);
  const seller = await catalog.getSellerForUser(userId);
  const query = auctionListQuerySchema.parse(req.query);

  const page = await auctions.listAuctionsForOwner({
    sellerId: seller.id,
    sort: query.sort,
    limit: query.limit,
    ...(query.status === undefined ? {} : { status: query.status }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  });

  res.status(200).json({
    auctions: await Promise.all(
      page.auctions.map(async (auction) =>
        auctions.toSummaryDto(auction, await auctions.imagesForAuction(auction)),
      ),
    ),
    nextCursor: page.nextCursor === null ? null : auctions.encodeCursor(page.nextCursor),
  });
}

export async function getMyAuction(req: Request, res: Response): Promise<void> {
  const { userId } = requireAuth(req);
  const seller = await catalog.getSellerForUser(userId);
  const auction = await auctions.getOwnedAuction({
    auctionId: uuidParam(req, 'publicId'),
    sellerId: seller.id,
  });
  res.status(200).json(await adminDetail(auction));
}

export async function createAuction(req: Request, res: Response): Promise<void> {
  const { userId } = requireAuth(req);
  const seller = await catalog.requireApprovedSeller(userId);
  const body = createAuctionSchema.parse(req.body);

  const auction = await auctions.createAuction({
    sellerId: seller.id,
    actorUserId: userId,
    productId: body.productId,
    title: body.title,
    description: body.description,
    currency: body.currency,
    startsAt: new Date(body.startsAt),
    endsAt: new Date(body.endsAt),
    minBidMinor: BigInt(body.minBidMinor),
    maxBidMinor: BigInt(body.maxBidMinor),
    bidIncrementMinor: BigInt(body.bidIncrementMinor),
    maxBidsPerUser: body.maxBidsPerUser,
    bidFeeMinor: BigInt(body.bidFeeMinor),
    winnerPaymentHours: body.winnerPaymentHours,
    ...(body.slug === undefined ? {} : { slug: body.slug }),
    ...(body.shippingNote === undefined ? {} : { shippingNote: body.shippingNote }),
    context: operationContext(req, 'web'),
  });

  res.status(201).json(await adminDetail(await auctions.getAuction(auction.id)));
}

export async function updateAuction(req: Request, res: Response): Promise<void> {
  const { userId } = requireAuth(req);
  const seller = await catalog.getSellerForUser(userId);
  const body = updateAuctionSchema.parse(req.body);

  const auction = await auctions.updateAuction({
    auctionId: uuidParam(req, 'publicId'),
    sellerId: seller.id,
    actorUserId: userId,
    changes: {
      ...(body.title === undefined ? {} : { title: body.title }),
      ...(body.slug === undefined ? {} : { slug: body.slug }),
      ...(body.description === undefined ? {} : { description: body.description }),
      ...(body.shippingNote === undefined ? {} : { shippingNote: body.shippingNote }),
      ...(body.startsAt === undefined ? {} : { startsAt: new Date(body.startsAt) }),
      ...(body.endsAt === undefined ? {} : { endsAt: new Date(body.endsAt) }),
      ...(body.minBidMinor === undefined ? {} : { minBidMinor: BigInt(body.minBidMinor) }),
      ...(body.maxBidMinor === undefined ? {} : { maxBidMinor: BigInt(body.maxBidMinor) }),
      ...(body.bidIncrementMinor === undefined ? {} : { bidIncrementMinor: BigInt(body.bidIncrementMinor) }),
      ...(body.maxBidsPerUser === undefined ? {} : { maxBidsPerUser: body.maxBidsPerUser }),
      ...(body.bidFeeMinor === undefined ? {} : { bidFeeMinor: BigInt(body.bidFeeMinor) }),
      ...(body.winnerPaymentHours === undefined ? {} : { winnerPaymentHours: body.winnerPaymentHours }),
    },
    context: operationContext(req, 'web'),
  });

  res.status(200).json(await adminDetail(await auctions.getAuction(auction.id)));
}

export async function submitAuction(req: Request, res: Response): Promise<void> {
  const { userId } = requireAuth(req);
  const seller = await catalog.getSellerForUser(userId);
  const result = await auctions.submitForApproval({
    auctionId: uuidParam(req, 'publicId'),
    sellerId: seller.id,
    context: operationContext(req, 'web'),
  });
  res.status(200).json(await transitionResponse(result));
}

/** A seller may withdraw their own auction while it has not started. */
export async function cancelMyAuction(req: Request, res: Response): Promise<void> {
  const { userId } = requireAuth(req);
  const seller = await catalog.getSellerForUser(userId);
  const body = auctionReasonSchema.parse(req.body);

  const result = await auctions.cancel({
    auctionId: uuidParam(req, 'publicId'),
    reason: body.reason,
    actorUserId: userId,
    sellerId: seller.id,
    context: operationContext(req, 'web'),
  });
  res.status(200).json(await transitionResponse(result));
}

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

export async function listPendingAuctions(req: Request, res: Response): Promise<void> {
  const query = auctionListQuerySchema.parse(req.query);
  const page = await auctions.listPendingApproval({
    limit: query.limit,
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  });

  res.status(200).json({
    auctions: await Promise.all(
      page.auctions.map(async (auction) =>
        auctions.toSummaryDto(auction, await auctions.imagesForAuction(auction)),
      ),
    ),
    nextCursor: page.nextCursor === null ? null : auctions.encodeCursor(page.nextCursor),
  });
}

export async function getAuctionForStaff(req: Request, res: Response): Promise<void> {
  const auction = await auctions.getAuction(uuidParam(req, 'publicId'));
  res.status(200).json(await adminDetail(auction));
}

export async function approveAuction(req: Request, res: Response): Promise<void> {
  const { userId } = requireAuth(req);
  const result = await auctions.approve({
    auctionId: uuidParam(req, 'publicId'),
    actorUserId: userId,
    context: operationContext(req, 'admin'),
  });
  res.status(200).json(await transitionResponse(result));
}

export async function rejectAuction(req: Request, res: Response): Promise<void> {
  const { userId } = requireAuth(req);
  const body = auctionReasonSchema.parse(req.body);
  const result = await auctions.reject({
    auctionId: uuidParam(req, 'publicId'),
    reason: body.reason,
    actorUserId: userId,
    context: operationContext(req, 'admin'),
  });
  res.status(200).json(await transitionResponse(result));
}

export async function suspendAuction(req: Request, res: Response): Promise<void> {
  const { userId } = requireAuth(req);
  const body = auctionReasonSchema.parse(req.body);
  const result = await auctions.suspend({
    auctionId: uuidParam(req, 'publicId'),
    reason: body.reason,
    actorUserId: userId,
    context: operationContext(req, 'admin'),
  });
  res.status(200).json(await transitionResponse(result));
}

export async function resumeAuction(req: Request, res: Response): Promise<void> {
  const { userId } = requireAuth(req);
  const result = await auctions.resume({
    auctionId: uuidParam(req, 'publicId'),
    actorUserId: userId,
    context: operationContext(req, 'admin'),
  });
  res.status(200).json(await transitionResponse(result));
}

export async function cancelAuction(req: Request, res: Response): Promise<void> {
  const { userId } = requireAuth(req);
  const body = auctionReasonSchema.parse(req.body);
  const result = await auctions.cancel({
    auctionId: uuidParam(req, 'publicId'),
    reason: body.reason,
    actorUserId: userId,
    context: operationContext(req, 'admin'),
  });
  res.status(200).json(await transitionResponse(result));
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

async function adminDetail(auction: auctions.AuctionWithDisplay): Promise<unknown> {
  const images = await auctions.imagesForAuction(auction);
  const product = await catalog.getProduct(auction.productId);
  // Whether *this* auction holds a unit, not whether the product has any
  // reserved: another auction's hold is not this one's.
  const reserved = auctions.holdsInventory(auction.status);
  return auctions.toAdminDetailDto(auction, images, reserved && product.reservedQuantity > 0);
}

/**
 * `changed` tells the caller whether this request did the work or found it
 * already done, which is what makes a retried transition safe to send.
 */
async function transitionResponse(result: auctions.TransitionResult): Promise<unknown> {
  const auction = await auctions.getAuction(result.auction.id);
  return { changed: result.changed, auction: await adminDetail(auction) };
}
