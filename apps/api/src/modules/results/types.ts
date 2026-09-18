import type { AuctionOutcome, Currency } from '@howlow/shared';

/**
 * A stored auction result.
 *
 * Mirrors the `auction_results` row, which is append-only: there is no update
 * path in this module, no result-editing service function and no API that
 * could reach one. Once this row exists, the auction has been decided.
 *
 * Note the two names that differ from the spec's prose. The column is
 * `frozen_bid_checksum` (the spec calls it `input_checksum`) and
 * `participant_count` (the spec calls it `total_participants`), both fixed by
 * Phase 1's migration; renaming a column of an append-only table to match a
 * document would rewrite history for a synonym. The wire contract in
 * `@howlow/shared` uses `checksum` and `participantCount`.
 */
export interface ResultRecord {
  readonly id: string;
  readonly auctionId: string;
  readonly outcome: AuctionOutcome;
  /** Always `LUB_V1`. Persisted so a stored result says which rules produced it. */
  readonly algorithmVersion: string;
  readonly winningBidId: string | null;
  readonly winnerUserId: string | null;
  readonly winningAmountMinor: bigint | null;
  readonly totalBids: number;
  readonly totalValidBids: number;
  readonly uniqueAmountCount: number;
  readonly participantCount: number;
  readonly frozenBidChecksum: string;
  readonly computedAt: Date;
}

/** What one participant paid, and what has come back. */
export interface ParticipantFees {
  readonly userId: string;
  readonly bidCount: number;
  readonly totalFeesMinor: bigint;
}

/** The outcome of closing one auction, as the worker reports it. */
export interface CloseOutcome {
  readonly auctionId: string;
  readonly outcome: AuctionOutcome;
  readonly currency: Currency;
  readonly winningAmountMinor: bigint | null;
  readonly winnerUserId: string | null;
  /** The order created for the winner, if this auction produced one. */
  readonly orderId: string | null;
  /** False when the auction had already been decided and this call did nothing. */
  readonly decided: boolean;
  readonly result: ResultRecord;
}

/** What a refund pass did, per auction. */
export interface RefundOutcome {
  readonly auctionId: string;
  /** Participants who had a fee to return. */
  readonly eligible: number;
  /** Refunds booked by this pass. */
  readonly refunded: number;
  /** Refunds a previous pass had already booked, recognised by idempotency key. */
  readonly alreadyRefunded: number;
  readonly totalRefundedMinor: bigint;
}
