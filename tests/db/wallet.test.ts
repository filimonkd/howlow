import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as wallet from '@howlow/api/modules/wallet';
import { closePool, withTransaction } from '@howlow/api/db';
import {
  adminClient,
  cleanup,
  createUser,
  entryCount,
  ledgerSum,
  readWalletRow,
  walletRejection,
} from './wallet-helpers.js';

/**
 * Wallet and ledger behaviour, against real PostgreSQL.
 *
 * The invariant every test here ultimately protects: a balance only ever
 * changes together with the ledger entry that explains it, in one transaction,
 * and the ledger is never rewritten.
 */
let client: pg.Client;

beforeAll(async () => {
  client = await adminClient();
});

afterAll(async () => {
  await cleanup(client);
  await client.end();
  await closePool();
});

describe('wallet creation', () => {
  it('creates one wallet per user and returns the same one thereafter', async () => {
    const userId = await createUser(client);
    const first = await wallet.getWallet(userId);
    const second = await wallet.getWallet(userId);

    expect(second.id).toBe(first.id);
    expect(first.availableMinor).toBe(0n);
    expect(first.reservedMinor).toBe(0n);
    expect(first.currency).toBe('ETB');
    expect(first.frozenAt).toBeNull();
  });

  it('refuses a second wallet for the same user and currency', async () => {
    const userId = await createUser(client);
    await wallet.getWallet(userId);

    // The uniqueness is the database's, not the application's.
    await expect(
      client.query(`INSERT INTO wallets (user_id, currency) VALUES ($1, 'ETB')`, [userId]),
    ).rejects.toMatchObject({ constraint: 'wallets_user_currency_key' });
  });
});

describe('the ledger', () => {
  it('records a credit with the balance it produced', async () => {
    const userId = await createUser(client);
    const account = await wallet.getWallet(userId);

    const result = await wallet.credit('deposit', {
      userId,
      amountMinor: 250_000n,
      memo: 'Test deposit',
      channel: 'web',
    });

    expect(result.amountMinor).toBe(250_000n);
    expect(result.balanceAfterMinor).toBe(250_000n);
    expect(result.replayed).toBe(false);

    const page = await wallet.getTransactions(userId, { limit: 10 });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({
      seq: 1n,
      type: 'deposit',
      amountMinor: 250_000n,
      balanceAfterMinor: 250_000n,
      memo: 'Test deposit',
    });

    expect(await ledgerSum(client, account.id)).toBe(250_000n);
    expect((await readWalletRow(client, account.id)).availableMinor).toBe(250_000n);
  });

  it('records a debit as a negative entry', async () => {
    const userId = await createUser(client);
    const account = await wallet.getWallet(userId);
    await wallet.credit('deposit', { userId, amountMinor: 5000n, channel: 'system' });

    const result = await wallet.debit('bid_fee', { userId, amountMinor: 500n, channel: 'telegram' });

    expect(result.amountMinor).toBe(-500n);
    expect(result.balanceAfterMinor).toBe(4500n);
    expect(await ledgerSum(client, account.id)).toBe(4500n);
  });

  /**
   * The sign comes from the entry type, never from the caller. A negative
   * "credit" must not become a debit by the back door.
   */
  it('refuses a non-positive amount rather than inferring a direction from it', async () => {
    const userId = await createUser(client);

    for (const amountMinor of [0n, -100n]) {
      const refusal = await walletRejection(
        wallet.credit('deposit', { userId, amountMinor, channel: 'web' }),
      );
      expect(refusal.walletError).toBe('INVALID_AMOUNT');
    }
  });

  it('never lets a debit take the balance below zero', async () => {
    const userId = await createUser(client);
    const account = await wallet.getWallet(userId);
    await wallet.credit('deposit', { userId, amountMinor: 100n, channel: 'system' });

    const refusal = await walletRejection(
      wallet.debit('withdrawal', { userId, amountMinor: 101n, channel: 'web' }),
    );
    expect(refusal.walletError).toBe('INSUFFICIENT_FUNDS');
    expect(refusal.code).toBe('INSUFFICIENT_FUNDS');

    // Nothing was written: the refusal left no entry and no balance change.
    expect(await entryCount(client, account.id)).toBe(1);
    expect((await readWalletRow(client, account.id)).availableMinor).toBe(100n);
  });

  it('cannot be updated or deleted, even by an operator', async () => {
    const userId = await createUser(client);
    const account = await wallet.getWallet(userId);
    await wallet.credit('deposit', { userId, amountMinor: 1000n, channel: 'system' });

    await expect(
      client.query(`UPDATE wallet_entries SET amount_minor = 999999 WHERE wallet_id = $1`, [account.id]),
    ).rejects.toThrow();
    await expect(
      client.query(`DELETE FROM wallet_entries WHERE wallet_id = $1`, [account.id]),
    ).rejects.toThrow();

    expect(await ledgerSum(client, account.id)).toBe(1000n);
  });

  /**
   * A correction is a new entry, never an edit. After the refund the ledger
   * holds both movements and the original debit is untouched.
   */
  it('corrects a movement with a compensating entry', async () => {
    const userId = await createUser(client);
    const account = await wallet.getWallet(userId);
    await wallet.credit('deposit', { userId, amountMinor: 5000n, channel: 'system' });

    const fee = await wallet.debit('bid_fee', {
      userId,
      amountMinor: 500n,
      referenceType: 'bid',
      referenceId: account.id,
      channel: 'telegram',
    });

    const refunded = await wallet.refund('bid_fee_refund', {
      userId,
      amountMinor: 500n,
      referenceType: 'bid',
      referenceId: account.id,
      memo: 'Auction cancelled',
      channel: 'system',
    });

    expect(refunded.balanceAfterMinor).toBe(5000n);
    expect(await entryCount(client, account.id)).toBe(3);

    const { rows } = await client.query<{ amount_minor: string }>(
      `SELECT amount_minor FROM wallet_entries WHERE id = $1`,
      [fee.entryId],
    );
    expect(rows[0]?.amount_minor).toBe('-500');
  });

  /**
   * A balance change and its entry are one transaction. When the caller's
   * transaction rolls back, neither survives — there is no ordering in which a
   * crash leaves a balance without its explanation.
   */
  it('writes the balance and the entry together, or not at all', async () => {
    const userId = await createUser(client);
    const account = await wallet.getWallet(userId);

    await expect(
      withTransaction(async (tx) => {
        await wallet.credit('deposit', { userId, amountMinor: 9999n, channel: 'web' }, tx);
        throw new Error('caller failed after the movement');
      }),
    ).rejects.toThrow('caller failed after the movement');

    expect(await entryCount(client, account.id)).toBe(0);
    expect((await readWalletRow(client, account.id)).availableMinor).toBe(0n);
  });

  it('serialises the movement sequence without gaps', async () => {
    const userId = await createUser(client);
    const account = await wallet.getWallet(userId);
    for (let index = 0; index < 5; index += 1) {
      await wallet.credit('deposit', { userId, amountMinor: 100n, channel: 'system' });
    }

    const page = await wallet.getTransactions(userId, { limit: 10 });
    expect(page.entries.map((entry) => entry.seq)).toEqual([5n, 4n, 3n, 2n, 1n]);

    const report = await wallet.reconcileWallet(account.id);
    expect(report.sequenceGaps).toBe(0);
  });
});

describe('idempotency', () => {
  it('applies a retried operation once and reports the same result', async () => {
    const userId = await createUser(client);
    const account = await wallet.getWallet(userId);
    const idempotencyKey = `deposit-retry-${account.id}`;

    const first = await wallet.credit('deposit', {
      userId,
      amountMinor: 1200n,
      idempotencyKey,
      channel: 'web',
    });
    const retry = await wallet.credit('deposit', {
      userId,
      amountMinor: 1200n,
      idempotencyKey,
      channel: 'web',
    });

    expect(first.replayed).toBe(false);
    expect(retry.replayed).toBe(true);
    expect(retry.entryId).toBe(first.entryId);
    expect(retry.balanceAfterMinor).toBe(1200n);

    expect(await entryCount(client, account.id)).toBe(1);
    expect((await readWalletRow(client, account.id)).availableMinor).toBe(1200n);
  });

  /**
   * The same key with different details is a client bug, and replaying the
   * stored result would answer for the wrong request. Refusing is the only safe
   * response.
   */
  it('refuses a key reused for a different movement', async () => {
    const userId = await createUser(client);
    const account = await wallet.getWallet(userId);
    const idempotencyKey = `reused-${account.id}`;

    await wallet.credit('deposit', { userId, amountMinor: 1000n, idempotencyKey, channel: 'web' });

    const differentAmount = await walletRejection(
      wallet.credit('deposit', { userId, amountMinor: 2000n, idempotencyKey, channel: 'web' }),
    );
    expect(differentAmount.walletError).toBe('IDEMPOTENCY_CONFLICT');

    const differentType = await walletRejection(
      wallet.credit('prize_payout', { userId, amountMinor: 1000n, idempotencyKey, channel: 'web' }),
    );
    expect(differentType.walletError).toBe('IDEMPOTENCY_CONFLICT');

    expect(await entryCount(client, account.id)).toBe(1);
  });

  it('treats different keys as different operations', async () => {
    const userId = await createUser(client);
    const account = await wallet.getWallet(userId);

    await wallet.credit('deposit', {
      userId,
      amountMinor: 500n,
      idempotencyKey: 'a-key-one',
      channel: 'web',
    });
    await wallet.credit('deposit', {
      userId,
      amountMinor: 500n,
      idempotencyKey: 'a-key-two',
      channel: 'web',
    });

    expect(await entryCount(client, account.id)).toBe(2);
    expect((await readWalletRow(client, account.id)).availableMinor).toBe(1000n);
  });

  it('leaves an unkeyed operation free to repeat', async () => {
    const userId = await createUser(client);
    const account = await wallet.getWallet(userId);

    await wallet.credit('deposit', { userId, amountMinor: 300n, channel: 'web' });
    await wallet.credit('deposit', { userId, amountMinor: 300n, channel: 'web' });

    expect(await entryCount(client, account.id)).toBe(2);
    expect((await readWalletRow(client, account.id)).availableMinor).toBe(600n);
  });
});

describe('money representation', () => {
  /**
   * A balance beyond 2^53 must survive the round trip. This is the whole reason
   * money is BIGINT in the database, `bigint` in TypeScript and a decimal
   * string on the wire.
   */
  it('handles a balance larger than a double can represent exactly', async () => {
    const userId = await createUser(client);
    const account = await wallet.getWallet(userId);
    const huge = 9_007_199_254_740_993n; // 2^53 + 1

    const result = await wallet.credit('deposit', { userId, amountMinor: huge, channel: 'system' });
    expect(result.balanceAfterMinor).toBe(huge);

    const reread = await wallet.getWallet(userId);
    expect(reread.availableMinor).toBe(huge);

    const dto = wallet.toWalletDto(reread);
    expect(dto.availableMinor).toBe('9007199254740993');
    // The point of the string: parsing it as a number would lose the last digit.
    expect(String(Number(dto.availableMinor))).not.toBe(dto.availableMinor);

    expect(await ledgerSum(client, account.id)).toBe(huge);
  });

  it('serialises every amount as a string, never a JSON number', async () => {
    const userId = await createUser(client);
    await wallet.credit('deposit', { userId, amountMinor: 12_345n, channel: 'system' });

    const account = await wallet.getWallet(userId);
    const page = await wallet.getTransactions(userId, { limit: 5 });
    const body: unknown = JSON.parse(
      JSON.stringify({
        wallet: wallet.toWalletDto(account),
        entries: page.entries.map(wallet.toWalletEntryDto),
      }),
    );

    const amounts = JSON.stringify(body).match(
      /"(available|reserved|total|amount|balanceAfter)Minor":[^,}]+/g,
    );
    expect(amounts).not.toBeNull();
    for (const amount of amounts ?? []) {
      expect(amount).toMatch(/":"-?\d+"$/);
    }
  });
});

describe('pagination', () => {
  it('walks the ledger without repeating or skipping an entry', async () => {
    const userId = await createUser(client);
    for (let index = 0; index < 7; index += 1) {
      await wallet.credit('deposit', { userId, amountMinor: BigInt(index + 1), channel: 'system' });
    }

    const seen: bigint[] = [];
    let cursor: bigint | undefined;
    for (;;) {
      const page = await wallet.getTransactions(userId, { limit: 3, beforeSeq: cursor });
      seen.push(...page.entries.map((entry) => entry.seq));
      if (page.nextSeq === null) break;
      cursor = page.nextSeq;
    }

    expect(seen).toEqual([7n, 6n, 5n, 4n, 3n, 2n, 1n]);
  });

  it('round-trips an opaque cursor and refuses a malformed one', () => {
    expect(wallet.decodeCursor(wallet.encodeCursor(42n))).toBe(42n);
    expect(() => wallet.decodeCursor('not-a-cursor')).toThrow();
  });
});
