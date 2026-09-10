import type { Channel, Currency, WalletEntryType } from '@howlow/shared';

/**
 * Internal wallet types.
 *
 * Amounts are `bigint` everywhere inside the module. They become decimal
 * strings only at the API boundary, and are never JavaScript `number`.
 */
export interface WalletRecord {
  readonly id: string;
  readonly userId: string;
  readonly currency: Currency;
  readonly availableMinor: bigint;
  readonly reservedMinor: bigint;
  /** available + reserved. What the ledger must sum to. */
  readonly totalMinor: bigint;
  readonly version: bigint;
  readonly frozenAt: Date | null;
  readonly frozenReason: string | null;
  readonly updatedAt: Date;
}

export interface WalletEntryRecord {
  readonly id: string;
  readonly walletId: string;
  readonly type: WalletEntryType;
  readonly currency: Currency;
  /** Signed: positive credits, negative debits. */
  readonly amountMinor: bigint;
  readonly balanceAfterMinor: bigint;
  readonly referenceType: string | null;
  readonly referenceId: string | null;
  readonly memo: string | null;
  readonly createdAt: Date;
}

/** What every money movement needs, whichever direction it goes. */
export interface MovementInput {
  /**
   * The wallet to move, already resolved. The ledger takes the wallet lock by
   * primary key and takes no other lock, so wallet *creation* is a separate
   * idempotent step rather than part of a movement.
   */
  readonly walletId: string;
  /** Positive magnitude. The direction comes from `type`, never from a sign. */
  readonly amountMinor: bigint;
  readonly currency?: Currency | undefined;
  readonly type: WalletEntryType;
  readonly referenceType?: string | undefined;
  readonly referenceId?: string | undefined;
  readonly memo?: string | undefined;
  /** Makes a retried request apply exactly once. */
  readonly idempotencyKey?: string | undefined;
  /** The acting user. Absent when the platform acts on its own. */
  readonly actorUserId?: string | undefined;
  readonly channel: Channel;
}

export interface MovementResult {
  readonly walletId: string;
  readonly entryId: string;
  readonly amountMinor: bigint;
  readonly balanceAfterMinor: bigint;
  readonly currency: Currency;
  /** True when a stored idempotent result was returned instead of new work. */
  readonly replayed: boolean;
}
