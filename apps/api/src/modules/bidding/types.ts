import type { Channel, Currency } from '@howlow/shared';

/**
 * What the engine is asked to do.
 *
 * This is the one input shape for every channel. `channel`, `ipAddress` and
 * `deviceHash` are provenance: they are written to the bid row for fraud
 * review and they are never read by a rule. There is no branch anywhere in
 * this module on the value of `channel`, and Phase 6's winner algorithm must
 * reach the same answer whatever it says.
 */
export interface SubmitBidsInput {
  readonly userId: string;
  /** Public reference — a uuid or a slug. Internal ids are not client-facing. */
  readonly auctionReference: string;
  /** Amounts as they arrived: positive integer strings in minor units. */
  readonly amountsMinor: readonly string[];
  /** Required. Replay protection for the whole batch. */
  readonly idempotencyKey: string;
  readonly channel: Channel;
  readonly requestId?: string | undefined;
  readonly ipAddress?: string | undefined;
  readonly deviceHash?: string | undefined;
}

/** One bid as it was written. */
export interface BidRecord {
  readonly id: string;
  readonly auctionId: string;
  readonly userId: string;
  readonly amountMinor: bigint;
  readonly feeMinor: bigint;
  readonly status: 'valid' | 'void' | 'refunded';
  readonly channel: Channel;
  readonly idempotencyKey: string | null;
  readonly walletEntryId: string | null;
  readonly requestId: string | null;
  readonly createdAt: Date;
  readonly voidedAt: Date | null;
}

/** The engine's answer. */
export interface SubmitBidsOutcome {
  readonly auctionId: string;
  readonly bids: readonly BidRecord[];
  readonly totalFeeMinor: bigint;
  readonly currency: Currency;
  /** The caller's bid count in this auction after the batch. */
  readonly bidCount: number;
  readonly bidsRemaining: number;
  readonly walletBalanceMinor: bigint;
  /** True when this is the stored answer to a key that had already been processed. */
  readonly replayed: boolean;
  readonly submittedAt: Date;
  /**
   * Auction totals after the batch, for the aggregate publish. Counts only —
   * see the realtime note in bidService.
   */
  readonly auctionTotals: { readonly totalBids: number; readonly totalParticipants: number };
}

/** A user's standing in one auction. */
export interface ParticipantRecord {
  readonly id: string;
  readonly auctionId: string;
  readonly userId: string;
  readonly bidCount: number;
  readonly totalFeesMinor: bigint;
  readonly firstBidAt: Date | null;
  readonly lastBidAt: Date | null;
  readonly joinedChannel: Channel;
}

/** What the caller may still do, for the bid entry UI. */
export interface BidAllowance {
  readonly auctionId: string;
  readonly bidCount: number;
  readonly maxBidsPerUser: number;
  readonly bidsRemaining: number;
  readonly totalFeesMinor: bigint;
  readonly currency: Currency;
}
