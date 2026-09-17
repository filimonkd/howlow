import type { AuctionResultDto, Currency, MyAuctionOutcomeDto } from '@howlow/shared';
import { ALGORITHM_LUB_V1 } from '@howlow/shared';
import { type Tx } from '../../db/index.js';
import { getMyOrderForAuction, toOrderDto } from '../orders/index.js';
import * as repo from './resultsRepository.js';
import type { ResultRecord } from './types.js';

/**
 * What a result looks like to each kind of reader.
 *
 * ## The disclosure rule
 *
 * Before the close, nothing. There is no result row, so there is nothing to
 * leak — the uniqueness signal the bidding engine withholds stays withheld
 * right up to the moment the outcome is final.
 *
 * After the close:
 *
 *   * **The winning amount is public.** It is the answer the auction was
 *     asking, and every bidder needs it to make sense of their own outcome.
 *   * **The statistics are public.** How many bids, how many bidders, how many
 *     amounts stood alone. These describe the crowd, not any person in it.
 *   * **The checksum is public**, on purpose: it is what lets a result be
 *     re-verified without the bids being published.
 *   * **No bidder is named but the winner**, and even the winner is named only
 *     to themselves. No surface returns a participant list, a per-amount
 *     distribution or anybody else's amounts. A losing bidder learns that they
 *     lost and what the winning amount was — not who beat them, not by how
 *     much, and not what anybody else tried.
 *
 * `unique_amount_count` deserves a note, because it is the one statistic that
 * looks like it might leak: it says how many amounts exactly one bidder chose,
 * across the whole auction, after the auction is over. It names no amount and
 * no bidder, and the auction it describes can no longer be bid on.
 */

/** The public result of a closed auction. */
export function toResultDto(result: ResultRecord, currency: Currency): AuctionResultDto {
  return {
    auctionId: result.auctionId,
    outcome: result.outcome,
    // A literal in the contract, and the column's CHECK agrees. If a stored
    // row ever disagreed, the schema parse would fail loudly rather than
    // publish a result decided by unknown rules.
    algorithmVersion: ALGORITHM_LUB_V1,
    winningAmountMinor: result.winningAmountMinor?.toString() ?? null,
    currency,
    statistics: {
      totalBids: result.totalBids,
      totalValidBids: result.totalValidBids,
      participantCount: result.participantCount,
      uniqueAmountCount: result.uniqueAmountCount,
    },
    checksum: result.frozenBidChecksum,
    computedAt: result.computedAt.toISOString(),
  };
}

export async function getResult(auctionId: string, tx?: Tx): Promise<ResultRecord | undefined> {
  return repo.findResult(auctionId, tx);
}

export async function getResultsFor(
  auctionIds: readonly string[],
  tx?: Tx,
): Promise<Map<string, ResultRecord>> {
  return repo.findResultsFor(auctionIds, tx);
}

/**
 * One caller's own outcome.
 *
 * Everything here is either public (the outcome, the winning amount) or the
 * caller's own (their bid count, their fees, their refund, their order).
 * `won` is the only judgement, and it is about them.
 *
 * Returns `undefined` when the auction has no result yet, which the channel
 * renders as "still running" rather than as an error.
 */
export async function getMyOutcome(
  input: { auctionId: string; userId: string; currency: Currency },
  tx?: Tx,
): Promise<MyAuctionOutcomeDto | undefined> {
  const result = await repo.findResult(input.auctionId, tx);
  if (!result) return undefined;

  const participation = await repo.findParticipation(
    { auctionId: input.auctionId, userId: input.userId },
    tx,
  );
  const refundedMinor = await repo.sumRefunded({ auctionId: input.auctionId, userId: input.userId }, tx);
  const won = result.winnerUserId === input.userId;

  // The order is looked up by (auction, user), so a loser cannot be handed the
  // winner's order even if the winner check above were ever wrong.
  const order = won
    ? await getMyOrderForAuction({ auctionId: input.auctionId, userId: input.userId }, tx)
    : undefined;

  return {
    auctionId: input.auctionId,
    outcome: result.outcome,
    won,
    winningAmountMinor: result.winningAmountMinor?.toString() ?? null,
    currency: input.currency,
    bidCount: participation?.bidCount ?? 0,
    feesPaidMinor: (participation?.totalFeesMinor ?? 0n).toString(),
    refundedMinor: refundedMinor.toString(),
    order: order ? toOrderDto(order) : null,
  };
}
