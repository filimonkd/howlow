import { AppError, type AuctionStatus, type ErrorCode } from '@howlow/shared';

/** Stable auction error codes, carried in `details.auctionError`. */
export const AUCTION_ERRORS = [
  'AUCTION_NOT_FOUND',
  'AUCTION_NOT_OWNED',
  'AUCTION_SLUG_TAKEN',
  'INVALID_TRANSITION',
  'INVALID_AUCTION_CONFIG',
  'AUCTION_IMMUTABLE',
  'PRODUCT_NOT_ELIGIBLE',
  'PRODUCT_ALREADY_COMMITTED',
  'UNAUTHORIZED_AUCTION_OPERATION',
  'AUCTION_NOT_DUE',
] as const;

export type AuctionErrorCode = (typeof AUCTION_ERRORS)[number];

function auctionError(
  auctionCode: AuctionErrorCode,
  appCode: ErrorCode,
  message: string,
  publicMessage: string,
  details: Record<string, unknown> = {},
): AppError {
  return new AppError({
    code: appCode,
    message,
    publicMessage,
    details: { auctionError: auctionCode, ...details },
  });
}

export const auctionNotFound = (reference: string): AppError =>
  auctionError(
    'AUCTION_NOT_FOUND',
    'NOT_FOUND',
    `No auction for ${reference}`,
    'That auction does not exist.',
  );

export const auctionNotOwned = (auctionId: string, sellerId: string): AppError =>
  auctionError(
    'AUCTION_NOT_OWNED',
    'FORBIDDEN',
    `Auction ${auctionId} does not belong to seller ${sellerId}`,
    'That auction belongs to another seller.',
  );

export const auctionSlugTaken = (slug: string): AppError =>
  auctionError(
    'AUCTION_SLUG_TAKEN',
    'CONFLICT',
    `Auction slug ${slug} is already in use`,
    'That auction address is already taken.',
  );

/**
 * The lifecycle refusal.
 *
 * Every transition names the states it may start from, so an impossible move
 * is refused with both states in the message rather than silently applied.
 */
export const invalidTransition = (input: {
  auctionId: string;
  from: AuctionStatus;
  to: AuctionStatus;
  allowedFrom: readonly AuctionStatus[];
}): AppError =>
  auctionError(
    'INVALID_TRANSITION',
    'CONFLICT',
    `Auction ${input.auctionId} cannot move from ${input.from} to ${input.to}; ` +
      `${input.to} is reachable only from ${input.allowedFrom.join(', ')}`,
    `This auction is ${humanStatus(input.from)}, so that is not something it can do now.`,
    { from: input.from, to: input.to },
  );

export const invalidAuctionConfig = (detail: string, publicMessage?: string): AppError =>
  auctionError(
    'INVALID_AUCTION_CONFIG',
    'VALIDATION_FAILED',
    `Invalid auction configuration: ${detail}`,
    publicMessage ?? 'Those auction settings are not valid.',
  );

/**
 * A live auction's terms are what its bidders committed against, so they are
 * fixed. The database trigger refuses this too; the service refuses it first so
 * the caller gets a stable code rather than a constraint name.
 */
export const auctionImmutable = (auctionId: string, status: AuctionStatus): AppError =>
  auctionError(
    'AUCTION_IMMUTABLE',
    'CONFLICT',
    `Auction ${auctionId} is ${status}; its terms can no longer be changed`,
    'This auction has already started, so its terms can no longer be changed.',
    { status },
  );

export const productNotEligible = (detail: string): AppError =>
  auctionError(
    'PRODUCT_NOT_ELIGIBLE',
    'VALIDATION_FAILED',
    `Product is not eligible for auction: ${detail}`,
    'That product cannot be auctioned yet.',
  );

/**
 * One product unit cannot be promised to two auctions at once. Checked when an
 * auction is created and again, under lock, when it opens.
 */
export const productAlreadyCommitted = (input: {
  productId: string;
  conflictingAuctions: number;
  available: number;
}): AppError =>
  auctionError(
    'PRODUCT_ALREADY_COMMITTED',
    'CONFLICT',
    `Product ${input.productId} already has ${input.conflictingAuctions} unfinished auction(s) ` +
      `against ${input.available} available unit(s)`,
    'This product does not have enough stock free for another auction.',
    { available: input.available },
  );

export const unauthorizedAuctionOperation = (detail: string): AppError =>
  auctionError(
    'UNAUTHORIZED_AUCTION_OPERATION',
    'FORBIDDEN',
    `Unauthorized auction operation: ${detail}`,
    'You do not have permission to do that.',
  );

/**
 * The worker ran early. The database clock decides when an auction opens or
 * closes, so a job that fires before its time is refused rather than trusted.
 */
export const auctionNotDue = (input: { auctionId: string; what: 'open' | 'close'; dueAt: Date }): AppError =>
  auctionError(
    'AUCTION_NOT_DUE',
    'CONFLICT',
    `Auction ${input.auctionId} is not due to ${input.what} until ${input.dueAt.toISOString()}`,
    'That auction is not due yet.',
    { dueAt: input.dueAt.toISOString() },
  );

function humanStatus(status: AuctionStatus): string {
  const words: Record<AuctionStatus, string> = {
    draft: 'still a draft',
    pending_approval: 'waiting for review',
    scheduled: 'scheduled but not yet open',
    live: 'live',
    closing: 'closing',
    calculating: 'being decided',
    completed: 'finished',
    cancelled: 'cancelled',
    suspended: 'suspended',
  };
  return words[status];
}
