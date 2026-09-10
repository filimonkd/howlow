import { z } from 'zod';
import { currencySchema, minorAmountSchema } from './common.js';

/**
 * Wallet wire contracts.
 *
 * Every monetary value crosses the API boundary as a **decimal string** of
 * minor units, never a JSON number. A BIGINT balance can exceed 2^53, and
 * JSON.parse would silently round it — so the wire format keeps the value
 * exact and the client decides whether to widen it to BigInt or only display
 * it.
 */

/** Ledger entry types, with their fixed direction. */
export const WALLET_CREDIT_TYPES = [
  'deposit',
  'bid_fee_refund',
  'payment_refund',
  'admin_credit',
  'prize_payout',
] as const;

export const WALLET_DEBIT_TYPES = [
  'withdrawal',
  'bid_fee',
  'auction_payment',
  'admin_debit',
  'seller_payout',
] as const;

/** Reservations, used from Phase 5. They move money between available and reserved. */
export const WALLET_HOLD_TYPES = ['hold', 'hold_release'] as const;

export const walletEntryTypeSchema = z.enum([
  ...WALLET_CREDIT_TYPES,
  ...WALLET_DEBIT_TYPES,
  ...WALLET_HOLD_TYPES,
]);

export type WalletEntryType = z.infer<typeof walletEntryTypeSchema>;
export type WalletCreditType = (typeof WALLET_CREDIT_TYPES)[number];
export type WalletDebitType = (typeof WALLET_DEBIT_TYPES)[number];

/**
 * The direction each type must carry. The service derives the sign from the
 * type rather than trusting a caller-supplied sign, so a credit can never be
 * booked as a debit by passing a negative number.
 */
export function walletEntryDirection(type: WalletEntryType): -1 | 1 {
  return (WALLET_CREDIT_TYPES as readonly string[]).includes(type) ? 1 : -1;
}

export const walletSchema = z.object({
  id: z.uuid(),
  currency: currencySchema,
  /** Spendable balance, minor units, as a decimal string. */
  availableMinor: minorAmountSchema,
  /** Held against in-flight operations. Zero until Phase 5. */
  reservedMinor: minorAmountSchema,
  /** available + reserved. What the ledger must sum to. */
  totalMinor: minorAmountSchema,
  frozen: z.boolean(),
  frozenReason: z.string().nullable(),
  updatedAt: z.iso.datetime(),
});

export type WalletDto = z.infer<typeof walletSchema>;

export const walletEntrySchema = z.object({
  id: z.uuid(),
  /** The wallet's movement number, as a decimal string. The ledger's order. */
  seq: z.string().regex(/^\d{1,19}$/),
  type: walletEntryTypeSchema,
  currency: currencySchema,
  /** Signed: positive credits the wallet, negative debits it. */
  amountMinor: minorAmountSchema,
  /** The wallet's available balance immediately after this entry. */
  balanceAfterMinor: minorAmountSchema,
  referenceType: z.string().nullable(),
  referenceId: z.uuid().nullable(),
  memo: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export type WalletEntryDto = z.infer<typeof walletEntrySchema>;

export const walletTransactionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor: z.string().min(1).max(256).optional(),
});

export const walletTransactionsSchema = z.object({
  entries: z.array(walletEntrySchema),
  nextCursor: z.string().nullable(),
});

/** Finance adjustment request. A reason is mandatory: an unexplained
 *  adjustment to someone's money is not acceptable to leave in the ledger. */
export const adminAdjustmentSchema = z.object({
  amountMinor: minorAmountSchema.refine((value) => !value.startsWith('-') && value !== '0', {
    message: 'Amount must be positive; the direction comes from the operation',
  }),
  currency: currencySchema.default('ETB'),
  reason: z.string().trim().min(8).max(500),
  referenceType: z.string().trim().min(1).max(64).optional(),
  referenceId: z.uuid().optional(),
});

export const walletFreezeSchema = z.object({
  reason: z.string().trim().min(8).max(500),
});

export const reconciliationSchema = z.object({
  walletId: z.uuid(),
  consistent: z.boolean(),
  cachedTotalMinor: minorAmountSchema,
  ledgerTotalMinor: minorAmountSchema,
  driftMinor: minorAmountSchema,
  entryCount: z.number().int().nonnegative(),
  /** Entries whose recorded balance_after does not match the replayed running total. */
  runningBalanceBreaks: z.number().int().nonnegative(),
  /** Missing positions in the wallet's gap-free movement sequence. */
  sequenceGaps: z.number().int().nonnegative(),
  checkedAt: z.iso.datetime(),
});

export type ReconciliationReport = z.infer<typeof reconciliationSchema>;
