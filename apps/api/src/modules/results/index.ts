/**
 * The results module's public surface. **The one place an auction is decided.**
 *
 * `lubCalculator.ts` holds the only implementation of the winner rule in
 * HOWLOW, and `resultService.ts` is the only thing that runs it and persists
 * what it produced. No channel, no client, no admin tool and no other module
 * computes a winner; they read the result this module wrote.
 *
 * `resultsRepository` is not exported and the ESLint boundary rule refuses the
 * import, for the sharpest reason of any boundary in the codebase: there is no
 * update and no delete in it. A result is inserted once and read forever, and
 * the append-only trigger enforces that in the database as well. There is no
 * result-editing service function here, and nothing that could reach one.
 *
 * Phase 6 ends at a decided auction: a result, a winner's order awaiting
 * payment, refunded fees where no winner emerged, and released inventory where
 * nobody won. Collecting the winner's payment, what happens if they do not pay,
 * shipping and seller payouts are later phases — and none of them may change
 * who won.
 */
export { closeAuction, verifyResult } from './resultService.js';
export type { VerificationReport } from './resultService.js';

export { getMyOutcome, getResult, getResultsFor, toResultDto } from './resultViews.js';

/**
 * The algorithm, exported so tests and verification tooling can call it
 * directly. **Production reaches it through `closeAuction` only** — calling it
 * elsewhere would be computing a winner outside the one place allowed to.
 */
export { amountDistribution, calculateLubV1, countFrozenBids } from './lubCalculator.js';
export type { FrozenStatistics, LubWinner } from './lubCalculator.js';

export { canonicalBidLines, checksumFrozenBids, EMPTY_BID_SET_CHECKSUM } from './checksum.js';

export { refundIdempotencyKey, refundParticipationFees, sweepOutstandingRefunds } from './refunds.js';

export { auctionNotClosed, resultInconsistent, resultNotFound } from './errors.js';

export type { CloseOutcome, ParticipantFees, RefundOutcome, ResultRecord } from './types.js';
