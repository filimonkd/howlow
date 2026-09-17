/**
 * The auctions module's public surface.
 *
 * **Every auction status change goes through `lifecycle.ts`.** Nothing outside
 * this directory writes to `auctions` — not a controller, not a Telegram
 * handler, not the worker — so the transition table is the only thing that
 * decides what an auction may do next.
 *
 * Phase 4 owns the lifecycle up to `closing`. Result calculation
 * (`closing → calculating → completed`) belongs to Phase 6; the transitions
 * are declared so that the service will enforce the same previous-state rules,
 * but nothing here performs them.
 */
export {
  createAuction,
  decodeCursor,
  encodeCursor,
  getAuction,
  getAuctionByReference,
  getOwnedAuction,
  getPublicAuction,
  imagesForAuction,
  ladderSize,
  listAuctionsForOwner,
  listPendingApproval,
  listPublicAuctions,
  toAdminDetailDto,
  toDetailDto,
  toSummaryDto,
  updateAuction,
  validateAuctionConfig,
} from './auctionService.js';
export type { AuctionConfig, AuctionListResult } from './auctionService.js';

export { approve, cancel, close, open, reject, resume, submitForApproval, suspend } from './lifecycle.js';
export type { OpenOutcome, TransitionResult } from './lifecycle.js';

export {
  allowedFrom,
  AUCTION_TRANSITIONS,
  canTransition,
  holdsInventory,
  isTerminal,
  RESUMABLE_STATUSES,
  TERMINAL_STATUSES,
  targetOf,
  termsAreLocked,
  TERMS_LOCKED_STATUSES,
} from './transitions.js';
export type { AuctionAction } from './transitions.js';

export {
  databaseNow,
  findDueToClose,
  findDueToOpen,
  findLiveAhead,
  findScheduledAhead,
} from './auctionRepository.js';

/**
 * What the bidding engine is allowed to do to an auction.
 *
 * `auctions` stays owned by this module — nothing outside it writes auction
 * SQL — so the engine takes the row lock and moves the live counters through
 * here rather than reaching for the table. Neither of these is a status
 * change, so the lifecycle transition table is not involved; what the boundary
 * buys is that a status can still only ever be set by `lifecycle.ts`.
 *
 * `lockForBidding` is `lockById` under the name its caller needs. It is the
 * **first** lock in the platform's order (auction → product → wallet), so a
 * wallet debit taken while holding it cannot deadlock against a lifecycle
 * transition doing the same thing in the same order.
 */
export { lockById as lockForBidding, addBidCounters } from './auctionRepository.js';

export { AUCTION_ERRORS } from './errors.js';
export type { AuctionErrorCode } from './errors.js';

export type { AuctionRecord, AuctionTerms, AuctionWithDisplay } from './types.js';
