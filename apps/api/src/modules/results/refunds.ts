import { AppError } from '@howlow/shared';
import { withTransaction } from '../../db/index.js';
import { getLogger, writeAuditLog, type OperationContext } from '../../shared/index.js';
import { refund } from '../wallet/index.js';
import * as repo from './resultsRepository.js';
import type { RefundOutcome } from './types.js';

/**
 * Participation-fee refunds.
 *
 * ## When fees come back
 *
 * A participation fee buys a place in an auction that runs. So:
 *
 *   * **`winner`** — nothing is refunded. The auction ran, somebody won, and
 *     everyone who entered got what they paid for: a chance.
 *   * **`no_unique_bid`** — every fee comes back. The auction failed to produce
 *     a result, so the fee bought nothing.
 *   * **`no_bids`** — nobody paid anything, so there is nothing to return.
 *   * **`cancelled`** — every fee comes back. HOWLOW ended the auction, not
 *     the bidders, and keeping their money for an auction the platform pulled
 *     is indefensible.
 *
 * ## Why this is a separate pass
 *
 * The closing transaction holds the auction row from the moment it starts
 * until it commits, and it must: the result, the winner's order and the status
 * are one atomic fact. Refunds cannot join it. Each refund takes a wallet lock
 * — that is what the wallet module does, and correctly — so folding N refunds
 * into the closing transaction would mean holding the auction lock across N
 * wallet locks. For a thousand-participant auction that is a thousand locks in
 * one transaction, a transaction long enough to matter, and an ordering
 * (auction → wallet, then wallet, then wallet…) whose worst case is a pool
 * exhausted by closing jobs waiting on each other's wallets. Phase 5 has
 * already demonstrated what that failure looks like in practice.
 *
 * So refunds run afterwards, **one wallet per transaction**, and the auction
 * lock is not held at all. The cost of splitting is that a crash can leave an
 * auction decided with some fees returned and some not. That cost is paid for
 * by two things:
 *
 *   1. **Exactly-once per participant.** Each refund carries a deterministic
 *      idempotency key, `auction-refund:<auctionId>:<userId>`, and the wallet
 *      module's own entry-level idempotency turns a repeat into a replay that
 *      moves no money. Running this pass ten times books one refund.
 *   2. **A recovery query.** `findAuctionsWithUnpaidRefunds` reads the ledger
 *      for auctions whose refunds are incomplete, so the next sweep finishes
 *      what a crash interrupted. Nothing has to remember; the ledger is asked.
 *
 * That combination is what makes the split safe rather than merely convenient.
 *
 * ## What is never done here
 *
 * No statement in this file writes to `wallets` or `wallet_entries`. Refunds
 * go through `modules/wallet`'s `refund`, which books the credit and its
 * ledger entry in one transaction — the rule that no balance may change
 * without its entry is enforced by there being one place a balance can change,
 * and this is not that place.
 *
 * The amount is `auction_participants.total_fees_minor`: what the participant
 * was actually charged, accumulated bid by bid at the rate in force when each
 * bid was placed. It is never recomputed as `bid_count × bid_fee_minor`, which
 * would agree today and hand somebody the wrong amount the first time a fee
 * changed.
 */

/** The reference every participation-fee refund carries, for the ledger join. */
const REFUND_REFERENCE_TYPE = 'auction';

/**
 * The idempotency key for one participant's refund of one auction.
 *
 * Deterministic on purpose, and derived from nothing that could vary between
 * attempts — no timestamp, no request id, no attempt counter. Two passes over
 * the same auction compute the same key for the same person, so the second one
 * replays instead of paying twice. This is the whole of the exactly-once
 * guarantee, so it must not be changed once auctions have been closed with it:
 * a new key format would make every already-refunded participant look unpaid.
 */
export const refundIdempotencyKey = (auctionId: string, userId: string): string =>
  `auction-refund:${auctionId}:${userId}`;

/**
 * Return every outstanding participation fee for one auction.
 *
 * Safe to call repeatedly, and meant to be: the worker calls it after closing,
 * and the recovery sweep calls it again for anything left unfinished. A
 * participant already refunded costs one replayed wallet call and no movement.
 *
 * Refunds are attempted one at a time rather than concurrently. They touch
 * different wallets so they would not contend, but a burst of parallel
 * transactions from a single closing job is how a connection pool gets
 * exhausted, and nothing here is latency-critical: a fee arriving a second
 * later is invisible, a pool that cannot serve a bid is not.
 */
export async function refundParticipationFees(input: {
  auctionId: string;
  context?: OperationContext | undefined;
}): Promise<RefundOutcome> {
  const payers = await repo.listFeePayers(input.auctionId);

  let refunded = 0;
  let alreadyRefunded = 0;
  let totalRefundedMinor = 0n;

  for (const payer of payers) {
    const movement = await refund('bid_fee_refund', {
      userId: payer.userId,
      amountMinor: payer.totalFeesMinor,
      referenceType: REFUND_REFERENCE_TYPE,
      referenceId: input.auctionId,
      memo: 'Participation fees returned: the auction produced no winner',
      idempotencyKey: refundIdempotencyKey(input.auctionId, payer.userId),
      channel: input.context?.channel ?? 'system',
      ...(input.context?.actorUserId === undefined ? {} : { actorUserId: input.context.actorUserId }),
    });

    if (movement.replayed) {
      alreadyRefunded += 1;
      continue;
    }
    refunded += 1;
    totalRefundedMinor += payer.totalFeesMinor;
  }

  // One audit row for the pass, written only when it actually moved money. A
  // replay that found everything already refunded did nothing worth recording,
  // and recording it would make one refund look like several.
  if (refunded > 0) {
    await withTransaction((tx) =>
      writeAuditLog(
        {
          action: 'auction.participation_fees_refunded',
          entityType: 'auction',
          entityId: input.auctionId,
          actorUserId: input.context?.actorUserId,
          channel: input.context?.channel ?? 'system',
          requestId: input.context?.requestId,
          details: {
            eligible: payers.length,
            refunded,
            alreadyRefunded,
            totalRefundedMinor: totalRefundedMinor.toString(),
          },
        },
        tx,
      ),
    );
  }

  return {
    auctionId: input.auctionId,
    eligible: payers.length,
    refunded,
    alreadyRefunded,
    totalRefundedMinor,
  };
}

/**
 * Finish the refunds a previous pass did not.
 *
 * The recovery half of the split described above. Reads the ledger for decided
 * auctions with participants who paid a fee and have no `bid_fee_refund` entry
 * against that auction, and runs the pass for each. Returns what it did, per
 * auction, so the worker can log something meaningful rather than "done".
 *
 * A failure on one auction does not stop the others: this is a sweep, and the
 * point of a sweep is that it makes progress. Each failure is logged with the
 * auction it belongs to and the next sweep will find it again, because the
 * query asks the ledger rather than a flag somebody has to clear.
 */
export async function sweepOutstandingRefunds(input: {
  limit?: number | undefined;
  context?: OperationContext | undefined;
}): Promise<readonly RefundOutcome[]> {
  const limit = input.limit ?? 50;
  const auctionIds = await repo.findAuctionsWithUnpaidRefunds(limit);
  const outcomes: RefundOutcome[] = [];

  for (const auctionId of auctionIds) {
    try {
      const context = input.context;
      outcomes.push(
        await refundParticipationFees(context === undefined ? { auctionId } : { auctionId, context }),
      );
    } catch (error) {
      getLogger().error(
        {
          err: error,
          auctionId,
          ...(AppError.is(error) ? { code: error.code } : {}),
        },
        'Participation-fee refunds could not be completed for this auction; the sweep will retry it',
      );
    }
  }

  return outcomes;
}
