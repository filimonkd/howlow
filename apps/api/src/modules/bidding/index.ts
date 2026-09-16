/**
 * The bidding module's public surface.
 *
 * **`submitBids` is the only way to place a bid.** The HTTP controller and the
 * Telegram handler both call it; there is no second path, no channel-specific
 * variant, and no way to insert a bid, charge a fee or move a counter without
 * going through it. `bidRepository` is not exported and the ESLint boundary
 * rule refuses to let anything outside this directory import it, for the same
 * reason the wallet's repository is sealed: a bid without its fee and its
 * counters is not a cheaper bid, it is a corrupt auction.
 *
 * Phase 5 ends at accepted bids. Nothing here counts unique amounts, ranks
 * them or picks a winner — that is Phase 6, and it reads `bids`, which this
 * module has already made trustworthy.
 */
export {
  getAllowance,
  getMyBids,
  submitBids,
  toBidDto,
  toMyBidsDto,
  toSubmitResultDto,
} from './bidService.js';

export { recountAuction } from './bidRepository.js';

export { BID_SCOPE, IDEMPOTENCY_TTL_SECONDS, bidRequestHash } from './idempotency.js';

export {
  assertAmountAllowed,
  assertAmountsAllowed,
  assertNoRepeats,
  ladderSize,
  parseAmounts,
  totalFee,
} from './validation.js';
export type { AuctionBidTerms } from './validation.js';

export type {
  BidAllowance,
  BidRecord,
  ParticipantRecord,
  SubmitBidsInput,
  SubmitBidsOutcome,
} from './types.js';
