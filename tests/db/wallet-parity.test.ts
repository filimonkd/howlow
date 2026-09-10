import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as auth from '@howlow/api/modules/auth';
import * as wallet from '@howlow/api/modules/wallet';
import { closePool } from '@howlow/api/db';
import { adminClient, cleanupTestUsers, establishedAccount, uniqueTelegramId } from './auth-helpers.js';

/**
 * Channel parity.
 *
 * The invariant: one account has one wallet and one ledger, whichever channel
 * is asking. The website resolves the user from an access token, the Telegram
 * bot resolves the same user from the numeric Telegram id, and both then call
 * the same wallet module — so there is no second balance to disagree with the
 * first.
 *
 * These tests call the module the way each channel's adapter does, rather than
 * going over HTTP, because the parity being proved is that the two adapters
 * reach identical state through identical calls.
 */
let db: pg.Client;

/** Extract the raw link token from a deep link. */
const tokenOf = (deepLink: string): string => deepLink.split('start=link_')[1]!;

beforeAll(async () => {
  // Linking builds a deep link, which needs a bot username. Any value will do:
  // nothing in these tests reaches Telegram.
  process.env['TELEGRAM_BOT_USERNAME'] ??= 'howlow_test_bot';
  db = await adminClient();
});

afterAll(async () => {
  await cleanupTestUsers(db);
  await db.end();
  await closePool();
});

/** An account reachable from both channels, as a linked user really is. */
async function linkedAccount(): Promise<{ userId: string; telegramUserId: string }> {
  const account = await establishedAccount(auth);
  const telegramUserId = uniqueTelegramId();
  const link = await auth.createLinkToken(account.userId, { channel: 'web' });
  await auth.confirmLink(
    { token: tokenOf(link.deepLink), identity: { telegramUserId, username: 'parity-tester' } },
    { channel: 'telegram' },
  );
  return { userId: account.userId, telegramUserId };
}

describe('one wallet across both channels', () => {
  /**
   * Activating the account creates the wallet, so a user who has only ever
   * verified their phone already has one — no channel has to create it first,
   * and neither can create a second.
   */
  it('gives a verified account its wallet immediately', async () => {
    const account = await establishedAccount(auth);

    const { rows } = await db.query<{ count: string; available_minor: string }>(
      `SELECT COUNT(*)::text AS count, COALESCE(MIN(available_minor)::text, '') AS available_minor
       FROM wallets WHERE user_id = $1`,
      [account.userId],
    );
    expect(rows[0]?.count).toBe('1');
    expect(rows[0]?.available_minor).toBe('0');
  });

  it('shows the Telegram user the same wallet the website shows', async () => {
    const { userId, telegramUserId } = await linkedAccount();

    // What the Telegram handler does: resolve identity, then read the wallet.
    const fromTelegram = await auth.resolveTelegramUser(telegramUserId);
    expect(fromTelegram?.id).toBe(userId);

    const telegramView = await wallet.getWallet(fromTelegram!.id);
    const websiteView = await wallet.getWallet(userId);

    expect(telegramView.id).toBe(websiteView.id);
    expect(telegramView.availableMinor).toBe(websiteView.availableMinor);
  });

  it('reflects a Telegram debit in the website view, and the reverse', async () => {
    const { userId, telegramUserId } = await linkedAccount();
    await wallet.credit('deposit', { userId, amountMinor: 10_000n, channel: 'web' });

    const telegramUser = await auth.resolveTelegramUser(telegramUserId);
    await wallet.debit('bid_fee', {
      userId: telegramUser!.id,
      amountMinor: 1500n,
      channel: 'telegram',
    });

    const websiteWallet = await wallet.getWallet(userId);
    expect(websiteWallet.availableMinor).toBe(8500n);

    await wallet.credit('deposit', { userId, amountMinor: 500n, channel: 'web' });
    const telegramWallet = await wallet.getWallet(telegramUser!.id);
    expect(telegramWallet.availableMinor).toBe(9000n);
    expect(telegramWallet.id).toBe(websiteWallet.id);
  });

  it('records movements from both channels in one ledger', async () => {
    const { userId, telegramUserId } = await linkedAccount();
    const account = await wallet.getWallet(userId);
    const telegramUser = await auth.resolveTelegramUser(telegramUserId);

    await wallet.credit('deposit', { userId, amountMinor: 2000n, channel: 'web' });
    await wallet.debit('bid_fee', { userId: telegramUser!.id, amountMinor: 300n, channel: 'telegram' });

    const page = await wallet.getTransactions(userId, { limit: 10 });
    expect(page.entries).toHaveLength(2);

    const { rows } = await db.query<{ created_channel: string; count: string }>(
      `SELECT created_channel, COUNT(*)::text AS count FROM wallet_entries
       WHERE wallet_id = $1 GROUP BY created_channel ORDER BY created_channel::text`,
      [account.id],
    );
    // One ledger, with each entry recording which channel it came through.
    expect(rows).toEqual([
      { created_channel: 'telegram', count: '1' },
      { created_channel: 'web', count: '1' },
    ]);

    const report = await wallet.reconcileWallet(account.id);
    expect(report.consistent).toBe(true);
  });

  it('freezes for both channels at once', async () => {
    const financeUserId = (await establishedAccount(auth)).userId;
    await db.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'finance')`, [financeUserId]);

    const { userId, telegramUserId } = await linkedAccount();
    const account = await wallet.getWallet(userId);
    await wallet.credit('deposit', { userId, amountMinor: 1000n, channel: 'web' });

    await wallet.freezeWallet({
      walletId: account.id,
      reason: 'Fraud review in progress',
      actorUserId: financeUserId,
      channel: 'web',
    });

    const telegramUser = await auth.resolveTelegramUser(telegramUserId);
    for (const [channel, actingUserId] of [
      ['web', userId],
      ['telegram', telegramUser!.id],
    ] as const) {
      await expect(
        wallet.debit('withdrawal', { userId: actingUserId, amountMinor: 100n, channel }),
      ).rejects.toMatchObject({ details: { walletError: 'WALLET_FROZEN' } });
    }

    // And it reads as frozen from both, rather than only being enforced on one.
    expect((await wallet.getWallet(userId)).frozenAt).not.toBeNull();
    expect((await wallet.getWallet(telegramUser!.id)).frozenAt).not.toBeNull();
  });

  /**
   * The website and the Telegram bot format the same wallet differently, but
   * both format the *same numbers* — neither computes a balance of its own.
   */
  it('serialises the same figures for both channels', async () => {
    const { userId } = await linkedAccount();
    await wallet.credit('deposit', { userId, amountMinor: 123_456n, channel: 'web' });

    const account = await wallet.getWallet(userId);
    const dto = wallet.toWalletDto(account);

    expect(dto.availableMinor).toBe('123456');
    expect(dto.availableMinor).toBe(account.availableMinor.toString());
    expect(dto.totalMinor).toBe((account.availableMinor + account.reservedMinor).toString());
  });
});
