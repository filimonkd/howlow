import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as wallet from '@howlow/api/modules/wallet';
import { closePool } from '@howlow/api/db';
import {
  adminClient,
  cleanup,
  createUser,
  entryCount,
  readWalletRow,
  walletRejection,
} from './wallet-helpers.js';

/**
 * Finance operations, freezing, reconciliation and who is allowed to do them.
 *
 * Authorization is asserted here at the module boundary rather than through
 * HTTP, because that is where the guarantee has to hold: a route added later
 * without a role gate must still not be able to move someone's money.
 */
let client: pg.Client;
let financeUserId: string;
let ordinaryUserId: string;

beforeAll(async () => {
  client = await adminClient();
  financeUserId = await createUser(client, { roles: ['finance'] });
  ordinaryUserId = await createUser(client);
});

afterAll(async () => {
  await cleanup(client);
  await client.end();
  await closePool();
});

const REASON = 'Manual correction after a support investigation';

describe('finance adjustments', () => {
  it('credits a wallet and records who did it and why', async () => {
    const userId = await createUser(client);
    const account = await wallet.getWallet(userId);

    const result = await wallet.adminCredit({
      walletId: account.id,
      amountMinor: 15_000n,
      reason: REASON,
      actorUserId: financeUserId,
      channel: 'web',
    });

    expect(result.amountMinor).toBe(15_000n);
    expect(result.balanceAfterMinor).toBe(15_000n);

    const { rows } = await client.query<{
      entry_type: string;
      memo: string | null;
      created_by: string | null;
    }>(`SELECT entry_type, memo, created_by FROM wallet_entries WHERE id = $1`, [result.entryId]);
    expect(rows[0]).toMatchObject({
      entry_type: 'admin_credit',
      memo: REASON,
      created_by: financeUserId,
    });

    // And in the audit trail, under the actor who performed it.
    const audit = await client.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE entity_type = 'wallet' AND entity_id = $1
         AND actor_user_id = $2 ORDER BY id DESC LIMIT 1`,
      [account.id, financeUserId],
    );
    expect(audit.rows[0]?.action).toBe('wallet.admin_credited');
  });

  it('debits a wallet and refuses to overdraw it', async () => {
    const userId = await createUser(client);
    const account = await wallet.getWallet(userId);
    await wallet.credit('deposit', { userId, amountMinor: 1000n, channel: 'system' });

    await wallet.adminDebit({
      walletId: account.id,
      amountMinor: 400n,
      reason: REASON,
      actorUserId: financeUserId,
      channel: 'web',
    });
    expect((await readWalletRow(client, account.id)).availableMinor).toBe(600n);

    const refusal = await walletRejection(
      wallet.adminDebit({
        walletId: account.id,
        amountMinor: 601n,
        reason: REASON,
        actorUserId: financeUserId,
        channel: 'web',
      }),
    );
    expect(refusal.walletError).toBe('INSUFFICIENT_FUNDS');
    expect((await readWalletRow(client, account.id)).availableMinor).toBe(600n);
  });

  it('refuses an adjustment from someone without a finance role', async () => {
    const userId = await createUser(client);
    const account = await wallet.getWallet(userId);

    for (const operation of [wallet.adminCredit, wallet.adminDebit]) {
      const refusal = await walletRejection(
        operation({
          walletId: account.id,
          amountMinor: 100n,
          reason: REASON,
          actorUserId: ordinaryUserId,
          channel: 'web',
        }),
      );
      expect(refusal.walletError).toBe('UNAUTHORIZED_WALLET_OPERATION');
      expect(refusal.code).toBe('FORBIDDEN');
    }

    expect(await entryCount(client, account.id)).toBe(0);
  });

  it('refuses to adjust a wallet that does not exist', async () => {
    const refusal = await walletRejection(
      wallet.adminCredit({
        walletId: '00000000-0000-4000-8000-000000000000',
        amountMinor: 100n,
        reason: REASON,
        actorUserId: financeUserId,
        channel: 'web',
      }),
    );
    expect(refusal.walletError).toBe('WALLET_NOT_FOUND');
  });

  it('lets an operator find a wallet by its id or by its owner', async () => {
    const userId = await createUser(client);
    const account = await wallet.getWallet(userId);

    expect((await wallet.resolveWalletForAdmin(account.id, financeUserId)).id).toBe(account.id);
    expect((await wallet.resolveWalletForAdmin(userId, financeUserId)).id).toBe(account.id);

    const refusal = await walletRejection(wallet.resolveWalletForAdmin(account.id, ordinaryUserId));
    expect(refusal.walletError).toBe('UNAUTHORIZED_WALLET_OPERATION');
  });
});

describe('freezing a wallet', () => {
  it('stops debits while leaving credits and reads working', async () => {
    const userId = await createUser(client);
    const account = await wallet.getWallet(userId);
    await wallet.credit('deposit', { userId, amountMinor: 5000n, channel: 'system' });

    const frozen = await wallet.freezeWallet({
      walletId: account.id,
      reason: 'Fraud review in progress',
      actorUserId: financeUserId,
      channel: 'web',
    });
    expect(frozen.frozenAt).not.toBeNull();
    expect(frozen.frozenReason).toBe('Fraud review in progress');

    const refusal = await walletRejection(
      wallet.debit('withdrawal', { userId, amountMinor: 100n, channel: 'web' }),
    );
    expect(refusal.walletError).toBe('WALLET_FROZEN');

    // Money can still arrive, and the owner can still read their wallet.
    const credited = await wallet.credit('deposit', { userId, amountMinor: 250n, channel: 'system' });
    expect(credited.balanceAfterMinor).toBe(5250n);

    const read = await wallet.getWallet(userId);
    expect(read.frozenAt).not.toBeNull();
    expect(read.availableMinor).toBe(5250n);
    expect((await wallet.getTransactions(userId, { limit: 5 })).entries.length).toBeGreaterThan(0);
  });

  it('allows debits again once unfrozen', async () => {
    const userId = await createUser(client);
    const account = await wallet.getWallet(userId);
    await wallet.credit('deposit', { userId, amountMinor: 1000n, channel: 'system' });

    await wallet.freezeWallet({
      walletId: account.id,
      reason: 'Fraud review in progress',
      actorUserId: financeUserId,
      channel: 'web',
    });
    const thawed = await wallet.unfreezeWallet({
      walletId: account.id,
      reason: 'Review completed, no action needed',
      actorUserId: financeUserId,
      channel: 'web',
    });

    expect(thawed.frozenAt).toBeNull();
    expect(thawed.frozenReason).toBeNull();

    const debited = await wallet.debit('withdrawal', { userId, amountMinor: 100n, channel: 'web' });
    expect(debited.balanceAfterMinor).toBe(900n);
  });

  it('is idempotent in both directions', async () => {
    const userId = await createUser(client);
    const account = await wallet.getWallet(userId);
    const args = { walletId: account.id, actorUserId: financeUserId, channel: 'web' } as const;

    await wallet.freezeWallet({ ...args, reason: 'Fraud review in progress' });
    const again = await wallet.freezeWallet({ ...args, reason: 'A different reason entirely' });
    // The original freeze stands; a second freeze does not overwrite its reason.
    expect(again.frozenReason).toBe('Fraud review in progress');

    await wallet.unfreezeWallet({ ...args, reason: 'Review completed' });
    const stillThawed = await wallet.unfreezeWallet({ ...args, reason: 'Review completed' });
    expect(stillThawed.frozenAt).toBeNull();
  });

  /**
   * A freeze is a financial control, not an account suspension: it must not
   * touch `users.status`, which is an authentication decision.
   */
  it('does not suspend the account', async () => {
    const userId = await createUser(client);
    const account = await wallet.getWallet(userId);

    await wallet.freezeWallet({
      walletId: account.id,
      reason: 'Fraud review in progress',
      actorUserId: financeUserId,
      channel: 'web',
    });

    const { rows } = await client.query<{ status: string }>(
      `SELECT status FROM users WHERE id = $1`,
      [userId],
    );
    expect(rows[0]?.status).toBe('active');
  });

  it('refuses a freeze from someone without a finance role', async () => {
    const userId = await createUser(client);
    const account = await wallet.getWallet(userId);

    const refusal = await walletRejection(
      wallet.freezeWallet({
        walletId: account.id,
        reason: 'I would like this frozen',
        actorUserId: ordinaryUserId,
        channel: 'web',
      }),
    );
    expect(refusal.walletError).toBe('UNAUTHORIZED_WALLET_OPERATION');
    expect((await readWalletRow(client, account.id)).frozen).toBe(false);
  });
});

describe('reconciliation', () => {
  it('reports a healthy wallet as consistent', async () => {
    const userId = await createUser(client);
    const account = await wallet.getWallet(userId);
    await wallet.credit('deposit', { userId, amountMinor: 4000n, channel: 'system' });
    await wallet.debit('bid_fee', { userId, amountMinor: 500n, channel: 'telegram' });

    const report = await wallet.reconcileWallet(account.id);
    expect(report).toMatchObject({
      walletId: account.id,
      consistent: true,
      cachedTotalMinor: '3500',
      ledgerTotalMinor: '3500',
      driftMinor: '0',
      entryCount: 2,
      runningBalanceBreaks: 0,
      sequenceGaps: 0,
    });
  });

  /**
   * Drift is what happens if a balance is ever changed without its entry.
   * Simulated here by editing the cached balance directly — which no
   * application code may do, and which is why the check exists.
   */
  it('detects a cached balance that no longer matches the ledger', async () => {
    const userId = await createUser(client);
    const account = await wallet.getWallet(userId);
    await wallet.credit('deposit', { userId, amountMinor: 1000n, channel: 'system' });

    await client.query(`UPDATE wallets SET available_minor = 999 WHERE id = $1`, [account.id]);

    const report = await wallet.reconcileWallet(account.id);
    expect(report.consistent).toBe(false);
    expect(report.cachedTotalMinor).toBe('999');
    expect(report.ledgerTotalMinor).toBe('1000');
    expect(report.driftMinor).toBe('1');

    // Detected, not repaired: the balance is exactly as it was found.
    expect((await readWalletRow(client, account.id)).availableMinor).toBe(999n);

    const audit = await client.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE entity_type = 'wallet' AND entity_id = $1
         AND action = 'wallet.reconciliation_failed'`,
      [account.id],
    );
    expect(audit.rows).toHaveLength(1);
  });

  /**
   * A ledger can sum correctly and still be wrong in the middle. An entry
   * inserted out of band carries a `balance_after_minor` that the replay
   * disagrees with, which is what an unserialised write would leave behind.
   */
  it('detects an entry whose recorded balance the replay disagrees with', async () => {
    const userId = await createUser(client);
    const account = await wallet.getWallet(userId);
    await wallet.credit('deposit', { userId, amountMinor: 1000n, channel: 'system' });

    await client.query(
      `INSERT INTO wallet_entries
         (wallet_id, user_id, seq, entry_type, currency, amount_minor, balance_after_minor)
       VALUES ($1, $2, 2, 'deposit', 'ETB', 500, 4242)`,
      [account.id, userId],
    );
    await client.query(`UPDATE wallets SET available_minor = 1500 WHERE id = $1`, [account.id]);

    const report = await wallet.reconcileWallet(account.id);
    expect(report.driftMinor).toBe('0');
    expect(report.runningBalanceBreaks).toBe(1);
    expect(report.consistent).toBe(false);
  });

  /**
   * Drift and the replay can both come out clean if an entry is removed along
   * with the balance it produced. A gap in the sequence cannot be hidden that
   * way, which is the point of checking it separately.
   */
  it('detects a missing entry that drift alone would not reveal', async () => {
    const userId = await createUser(client);
    const account = await wallet.getWallet(userId);
    await wallet.credit('deposit', { userId, amountMinor: 1000n, channel: 'system' });
    await wallet.credit('deposit', { userId, amountMinor: 500n, channel: 'system' });

    // wallet_entries is append-only, so removing a row needs the same
    // test-only escape hatch the teardown uses. No application code may do it.
    await client.query('BEGIN');
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query(`DELETE FROM wallet_entries WHERE wallet_id = $1 AND seq = 1`, [account.id]);
    await client.query(`UPDATE wallets SET available_minor = 500 WHERE id = $1`, [account.id]);
    await client.query('COMMIT');

    const report = await wallet.reconcileWallet(account.id);
    expect(report.driftMinor).toBe('0');
    expect(report.sequenceGaps).toBe(1);
    expect(report.consistent).toBe(false);
  });

  it('reports only the inconsistent wallets in a full sweep', async () => {
    const healthyUserId = await createUser(client);
    const brokenUserId = await createUser(client);
    const healthy = await wallet.getWallet(healthyUserId);
    const broken = await wallet.getWallet(brokenUserId);

    await wallet.credit('deposit', { userId: healthyUserId, amountMinor: 100n, channel: 'system' });
    await wallet.credit('deposit', { userId: brokenUserId, amountMinor: 100n, channel: 'system' });
    await client.query(`UPDATE wallets SET available_minor = 7 WHERE id = $1`, [broken.id]);

    const sweep = await wallet.reconcileAllWallets({ batchSize: 5 });
    const reported = sweep.inconsistent.map((report) => report.walletId);

    expect(reported).toContain(broken.id);
    expect(reported).not.toContain(healthy.id);
    expect(sweep.walletsChecked).toBeGreaterThanOrEqual(2);

    // Still not repaired by the sweep.
    expect((await readWalletRow(client, broken.id)).availableMinor).toBe(7n);
  });
});
