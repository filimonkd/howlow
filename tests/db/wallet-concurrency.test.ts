import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as wallet from '@howlow/api/modules/wallet';
import { closePool } from '@howlow/api/db';
import {
  adminClient,
  cleanup,
  createUser,
  entryCount,
  ledgerSum,
  readWalletRow,
  settle,
  walletRejection,
} from './wallet-helpers.js';

/**
 * Concurrency: the tests this module exists to pass.
 *
 * Every one of these runs real, simultaneous transactions against real
 * PostgreSQL. A mock cannot demonstrate that a row lock serialises anything,
 * and an assertion about locking that does not actually run two transactions at
 * once asserts nothing at all.
 *
 * The invariant under test throughout: after any interleaving, the cached
 * balance equals the sum of the ledger, no entry records a balance the replay
 * disagrees with, and the balance never went below zero.
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

/** Every wallet invariant, checked from outside the module's own queries. */
async function assertConsistent(walletId: string): Promise<void> {
  const row = await readWalletRow(client, walletId);
  const sum = await ledgerSum(client, walletId);

  expect(row.availableMinor + row.reservedMinor).toBe(sum);
  expect(row.availableMinor >= 0n).toBe(true);

  const report = await wallet.reconcileWallet(walletId);
  expect(report.consistent).toBe(true);
  expect(report.driftMinor).toBe('0');
  expect(report.runningBalanceBreaks).toBe(0);
}

describe('concurrent wallet operations', () => {
  /**
   * 1. The one that matters most, made deterministic.
   *
   * Two debits of 600 against a balance of 1000: each is affordable alone,
   * together they are not. Rather than firing both and hoping the interleaving
   * is unlucky, this drives it: transaction A applies its debit and holds the
   * lock uncommitted while B tries the same, so the dangerous overlap happens
   * every run rather than occasionally.
   *
   * Without `FOR UPDATE`, B would read the uncommitted-away balance of 1000,
   * pass its own sufficiency check, block only on the UPDATE, and then write
   * 400 over A's 400 — leaving a wallet holding 400 with a ledger summing to
   * -200. With the lock, B waits, reads 400, and is refused.
   */
  it('never lets two concurrent debits overdraw the wallet', async () => {
    const userId = await createUser(client);
    const account = await wallet.getWallet(userId);
    await wallet.credit('deposit', { userId, amountMinor: 1000n, channel: 'system' });

    // `Tx` is just something that can run a query, so a plain client inside a
    // transaction is a legitimate one and lets the test control the overlap.
    const first = await adminClient();
    const second = await adminClient();
    const movement = { walletId: account.id, amountMinor: 600n, type: 'withdrawal', channel: 'web' } as const;

    try {
      await first.query('BEGIN');
      await second.query('BEGIN');

      const applied = await wallet.applyMovement(movement, first);
      expect(applied.balanceAfterMinor).toBe(400n);

      let secondSettled = false;
      const blocked = wallet.applyMovement(movement, second).finally(() => {
        secondSettled = true;
      });

      // A holds the lock, so B cannot have read a balance yet.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(secondSettled).toBe(false);

      await first.query('COMMIT');

      const refusal = await walletRejection(blocked);
      expect(refusal.walletError).toBe('INSUFFICIENT_FUNDS');
      expect(refusal.publicMessage).not.toContain('400');
      await second.query('ROLLBACK');
    } finally {
      await first.end();
      await second.end();
    }

    const row = await readWalletRow(client, account.id);
    expect(row.availableMinor).toBe(400n);
    await assertConsistent(account.id);
  });

  /**
   * 2. No lost updates.
   *
   * Twenty concurrent credits. A read-modify-write without the lock would drop
   * some of them: two transactions reading the same balance and each writing
   * their own total means the second silently discards the first.
   */
  it('applies every one of many concurrent credits', async () => {
    const userId = await createUser(client);
    const account = await wallet.getWallet(userId);

    const credits = Array.from({ length: 20 }, (_, index) =>
      wallet.credit('deposit', {
        userId,
        amountMinor: BigInt(index + 1) * 100n,
        channel: 'system',
      }),
    );

    const { fulfilled, walletErrors, otherErrors } = await settle(credits);
    expect(otherErrors).toEqual([]);
    expect(walletErrors).toEqual([]);
    expect(fulfilled).toHaveLength(20);

    // 100 + 200 + ... + 2000
    const expected = 100n * 210n;
    const row = await readWalletRow(client, account.id);
    expect(row.availableMinor).toBe(expected);
    expect(await entryCount(client, account.id)).toBe(20);
    await assertConsistent(account.id);
  });

  /**
   * 3. Mixed directions.
   *
   * Ten credits and ten debits at once. The final balance must be the
   * arithmetic result whatever order they landed in, and no intermediate state
   * may have gone negative — which the non-negative CHECK on both tables would
   * have refused outright, so a clean run is itself the evidence.
   */
  it('keeps the balance exact under interleaved credits and debits', async () => {
    const userId = await createUser(client);
    const account = await wallet.getWallet(userId);
    await wallet.credit('deposit', { userId, amountMinor: 10_000n, channel: 'system' });

    const operations = [
      ...Array.from({ length: 10 }, () =>
        wallet.credit('deposit', { userId, amountMinor: 250n, channel: 'system' }),
      ),
      ...Array.from({ length: 10 }, () =>
        wallet.debit('bid_fee', { userId, amountMinor: 100n, channel: 'telegram' }),
      ),
    ];

    const { fulfilled, walletErrors, otherErrors } = await settle(operations);
    expect(otherErrors).toEqual([]);
    expect(walletErrors).toEqual([]);
    expect(fulfilled).toHaveLength(20);

    const row = await readWalletRow(client, account.id);
    expect(row.availableMinor).toBe(10_000n + 2500n - 1000n);
    expect(await entryCount(client, account.id)).toBe(21);
    await assertConsistent(account.id);
  });

  /**
   * 4. Idempotency under a race.
   *
   * The same key submitted twice at once — a client that retried before the
   * first attempt answered. Exactly one entry may exist, and both callers must
   * be told the same balance.
   */
  it('applies a concurrently retried operation exactly once', async () => {
    const userId = await createUser(client);
    const account = await wallet.getWallet(userId);
    const idempotencyKey = `concurrent-deposit-${account.id}`;

    const attempt = (): Promise<wallet.MovementResult> =>
      wallet.credit('deposit', { userId, amountMinor: 7500n, idempotencyKey, channel: 'web' });

    const { fulfilled, walletErrors, otherErrors } = await settle([
      attempt(),
      attempt(),
      attempt(),
    ]);

    expect(otherErrors).toEqual([]);
    expect(walletErrors).toEqual([]);
    expect(fulfilled).toHaveLength(3);

    // One did the work; the others replayed it and reported the same outcome.
    expect(fulfilled.filter((result) => !result.replayed)).toHaveLength(1);
    expect(new Set(fulfilled.map((result) => result.entryId)).size).toBe(1);
    expect(new Set(fulfilled.map((result) => result.balanceAfterMinor))).toEqual(new Set([7500n]));

    expect(await entryCount(client, account.id)).toBe(1);
    const row = await readWalletRow(client, account.id);
    expect(row.availableMinor).toBe(7500n);
    await assertConsistent(account.id);
  });

  /**
   * 5. Sustained pressure.
   *
   * Ten debits of 100 against a balance of 550: exactly five can be afforded,
   * and the wallet must stop at 50 rather than anywhere below zero. This is the
   * overdraw test at a scale where a single unserialised read is very likely to
   * be observed rather than merely possible.
   */
  it('affords exactly as many concurrent debits as the balance allows', async () => {
    const userId = await createUser(client);
    const account = await wallet.getWallet(userId);
    await wallet.credit('deposit', { userId, amountMinor: 550n, channel: 'system' });

    const debits = Array.from({ length: 10 }, () =>
      wallet.debit('bid_fee', { userId, amountMinor: 100n, channel: 'telegram' }),
    );

    const { fulfilled, walletErrors, otherErrors } = await settle(debits);

    expect(otherErrors).toEqual([]);
    expect(fulfilled).toHaveLength(5);
    expect(walletErrors).toHaveLength(5);
    expect(new Set(walletErrors)).toEqual(new Set(['INSUFFICIENT_FUNDS']));

    const row = await readWalletRow(client, account.id);
    expect(row.availableMinor).toBe(50n);
    expect(await entryCount(client, account.id)).toBe(6);
    await assertConsistent(account.id);
  });

  /**
   * Direct evidence that the row lock — and not the connection pool, or luck —
   * is what serialises movements.
   *
   * An outer transaction takes the same `FOR UPDATE` lock the ledger takes and
   * holds it. A debit started while it is held must make no progress, and must
   * complete as soon as the lock is released. If the ledger were not locking,
   * the debit would finish immediately and the first assertion would fail.
   */
  it('blocks a movement while the wallet row is locked elsewhere', async () => {
    const userId = await createUser(client);
    const account = await wallet.getWallet(userId);
    await wallet.credit('deposit', { userId, amountMinor: 5000n, channel: 'system' });

    await client.query('BEGIN');
    await client.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [account.id]);

    let settled = false;
    const debit = wallet
      .debit('withdrawal', { userId, amountMinor: 1000n, channel: 'web' })
      .then((result) => {
        settled = true;
        return result;
      });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settled).toBe(false);

    await client.query('COMMIT');
    const result = await debit;

    expect(settled).toBe(true);
    expect(result.balanceAfterMinor).toBe(4000n);
    await assertConsistent(account.id);
  });

  /**
   * Wallet creation is settled by the database, not by a check-then-insert.
   * Ten simultaneous first reads must produce one wallet.
   */
  it('creates exactly one wallet under concurrent first reads', async () => {
    const userId = await createUser(client);

    const { fulfilled, otherErrors } = await settle(
      Array.from({ length: 10 }, () => wallet.getWallet(userId)),
    );
    expect(otherErrors).toEqual([]);
    expect(fulfilled).toHaveLength(10);
    expect(new Set(fulfilled.map((record) => record.id)).size).toBe(1);

    const { rows } = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM wallets WHERE user_id = $1`,
      [userId],
    );
    expect(rows[0]!.count).toBe('1');
  });
});
