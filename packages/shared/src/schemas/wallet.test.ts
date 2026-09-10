import { describe, expect, it } from 'vitest';
import {
  adminAdjustmentSchema,
  walletEntryDirection,
  walletEntrySchema,
  WALLET_CREDIT_TYPES,
  WALLET_DEBIT_TYPES,
  walletSchema,
  walletTransactionsQuerySchema,
} from './wallet.js';

/**
 * The wire contract, checked without a database.
 *
 * The direction table and the string-only money representation are the two
 * places a mistake would be silent in production, so they are asserted here
 * rather than only exercised through the integration suite.
 */
describe('entry direction', () => {
  it('gives every credit type +1 and every debit type -1', () => {
    for (const type of WALLET_CREDIT_TYPES) expect(walletEntryDirection(type)).toBe(1);
    for (const type of WALLET_DEBIT_TYPES) expect(walletEntryDirection(type)).toBe(-1);
  });

  it('keeps credits and debits disjoint', () => {
    const overlap = WALLET_CREDIT_TYPES.filter((type) =>
      (WALLET_DEBIT_TYPES as readonly string[]).includes(type),
    );
    expect(overlap).toEqual([]);
  });
});

describe('money on the wire', () => {
  const wallet = {
    id: '11111111-1111-4111-8111-111111111111',
    currency: 'ETB',
    availableMinor: '9007199254740993',
    reservedMinor: '0',
    totalMinor: '9007199254740993',
    frozen: false,
    frozenReason: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('accepts an integer minor amount as a string', () => {
    expect(walletSchema.parse(wallet).availableMinor).toBe('9007199254740993');
  });

  it('rejects a JSON number, a decimal and a non-numeric amount', () => {
    for (const availableMinor of [125_000, '125.00', '1e5', 'lots', '']) {
      expect(walletSchema.safeParse({ ...wallet, availableMinor }).success).toBe(false);
    }
  });

  it('requires an entry to carry its position and the balance it produced', () => {
    const entry = {
      id: '22222222-2222-4222-8222-222222222222',
      seq: '3',
      type: 'bid_fee',
      currency: 'ETB',
      amountMinor: '-500',
      balanceAfterMinor: '4500',
      referenceType: null,
      referenceId: null,
      memo: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    expect(walletEntrySchema.parse(entry).seq).toBe('3');
    expect(walletEntrySchema.safeParse({ ...entry, seq: '-1' }).success).toBe(false);
  });
});

describe('admin adjustment requests', () => {
  const valid = { amountMinor: '5000', reason: 'Support case 4821 refund' };

  it('defaults to the platform currency', () => {
    expect(adminAdjustmentSchema.parse(valid).currency).toBe('ETB');
  });

  /**
   * The direction comes from the endpoint, not from a sign, so a negative
   * amount is a caller trying to turn a credit into a debit.
   */
  it('refuses a zero or negative amount', () => {
    for (const amountMinor of ['0', '-5000']) {
      expect(adminAdjustmentSchema.safeParse({ ...valid, amountMinor }).success).toBe(false);
    }
  });

  it('refuses an adjustment without a real reason', () => {
    for (const reason of ['', 'oops', '   ']) {
      expect(adminAdjustmentSchema.safeParse({ ...valid, reason }).success).toBe(false);
    }
  });
});

describe('transaction queries', () => {
  it('defaults the page size and caps it', () => {
    expect(walletTransactionsQuerySchema.parse({}).limit).toBe(20);
    expect(walletTransactionsQuerySchema.parse({ limit: '50' }).limit).toBe(50);
    expect(walletTransactionsQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(walletTransactionsQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });
});
