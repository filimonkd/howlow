import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as bidding from '@howlow/api/modules/bidding';
import * as auctions from '@howlow/api/modules/auctions';
import * as wallet from '@howlow/api/modules/wallet';
import { closePool } from '@howlow/api/db';
import { adminClient, cleanup, cleanupCategories, domainRejection } from './catalog-helpers.js';
import {
  countAuditRows,
  createBidder,
  createLiveAuction,
  forceStatus,
  forceWindow,
  fundWallet,
  placeBids,
  readAuditPayloads,
  readAuctionCounters,
  readBidFeeEntries,
  readBids,
  readParticipant,
  walletBalance,
} from './bidding-helpers.js';

/**
 * The bidding engine against a real PostgreSQL.
 *
 * These call `submitBids()` directly, which is where the transaction, the
 * locks and the constraints actually live. The channel wiring is proven
 * separately by `scripts/smoke-bidding.mjs` — module tests passing while a
 * route was broken is a mistake this project has already made twice.
 *
 * The default fixture auction runs 100..5000 in steps of 100, a 500 fee, and a
 * 25-bid limit.
 */
let db: pg.Client;

beforeAll(async () => {
  db = await adminClient();
});

afterAll(async () => {
  await cleanup(db);
  await cleanupCategories(db);
  await db.end();
  await closePool();
});

describe('accepting bids', () => {
  it('accepts a single bid, charges once and records it', async () => {
    const auction = await createLiveAuction(db);
    const bidder = await createBidder(db);
    const before = await walletBalance(bidder.userId);

    const outcome = await placeBids({
      userId: bidder.userId,
      auctionId: auction.auctionId,
      amountsMinor: [100],
    });

    expect(outcome.bids).toHaveLength(1);
    expect(outcome.bids[0]!.amountMinor).toBe(100n);
    expect(outcome.bids[0]!.status).toBe('valid');
    expect(outcome.totalFeeMinor).toBe(500n);
    expect(outcome.bidCount).toBe(1);
    expect(outcome.bidsRemaining).toBe(24);
    expect(outcome.replayed).toBe(false);
    expect(await walletBalance(bidder.userId)).toBe(before - 500n);
  });

  it('accepts a batch atomically and charges per bid', async () => {
    const auction = await createLiveAuction(db);
    const bidder = await createBidder(db);
    const before = await walletBalance(bidder.userId);

    const outcome = await placeBids({
      userId: bidder.userId,
      auctionId: auction.auctionId,
      amountsMinor: [100, 300, 700, 1300],
    });

    expect(outcome.bids).toHaveLength(4);
    expect(outcome.totalFeeMinor).toBe(2000n);
    expect(await walletBalance(bidder.userId)).toBe(before - 2000n);

    const rows = await readBids(db, auction.auctionId);
    expect(rows.map((row) => row.amountMinor)).toEqual([100n, 300n, 700n, 1300n]);
    // Every bid carries the per-bid fee, not the batch total.
    expect(rows.every((row) => row.feeMinor === 500n)).toBe(true);
  });

  it('charges one ledger entry for a batch, not one per bid', async () => {
    const auction = await createLiveAuction(db);
    const bidder = await createBidder(db);

    await placeBids({
      userId: bidder.userId,
      auctionId: auction.auctionId,
      amountsMinor: [100, 200, 300, 400, 500],
    });

    const entries = await readBidFeeEntries(db, {
      userId: bidder.userId,
      auctionId: auction.auctionId,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.amountMinor).toBe(-2500n);
  });

  it('links every bid in a batch to the entry that paid for it', async () => {
    const auction = await createLiveAuction(db);
    const bidder = await createBidder(db);

    await placeBids({ userId: bidder.userId, auctionId: auction.auctionId, amountsMinor: [100, 200] });

    const rows = await readBids(db, auction.auctionId);
    expect(rows.every((row) => row.walletEntryId !== null)).toBe(true);
    expect(new Set(rows.map((row) => row.walletEntryId)).size).toBe(1);
  });

  it('accepts the minimum and the maximum amount', async () => {
    const auction = await createLiveAuction(db);
    const bidder = await createBidder(db);

    const outcome = await placeBids({
      userId: bidder.userId,
      auctionId: auction.auctionId,
      amountsMinor: [100, 5000],
    });
    expect(outcome.bids.map((bid) => bid.amountMinor).sort()).toEqual([100n, 5000n]);
  });

  it('accepts a full ladder up to the auction limit', async () => {
    const auction = await createLiveAuction(db, { maxBidsPerUser: 10 });
    const bidder = await createBidder(db);
    const ladder = Array.from({ length: 10 }, (_, index) => 100 + index * 100);

    const outcome = await placeBids({
      userId: bidder.userId,
      auctionId: auction.auctionId,
      amountsMinor: ladder,
    });
    expect(outcome.bids).toHaveLength(10);
    expect(outcome.bidsRemaining).toBe(0);
  });
});

describe('amount rules', () => {
  it.each([
    ['below the minimum', [50], 'AMOUNT_OUT_OF_RANGE'],
    ['above the maximum', [5100], 'AMOUNT_OUT_OF_RANGE'],
    ['off the increment ladder', [150], 'AMOUNT_NOT_ALIGNED'],
    ['not an integer', ['12.5'], 'AMOUNT_INVALID'],
    ['zero', ['0'], 'AMOUNT_INVALID'],
    ['negative', ['-100'], 'AMOUNT_INVALID'],
  ])('refuses an amount %s', async (_label, amountsMinor, expected) => {
    const auction = await createLiveAuction(db);
    const bidder = await createBidder(db);

    const refusal = await domainRejection(
      placeBids({ userId: bidder.userId, auctionId: auction.auctionId, amountsMinor }),
    );
    expect(refusal.domainCode).toBe(expected);

    expect(await readBids(db, auction.auctionId)).toHaveLength(0);
  });

  it('refuses the whole batch when one amount is wrong, and charges nothing', async () => {
    const auction = await createLiveAuction(db);
    const bidder = await createBidder(db);
    const before = await walletBalance(bidder.userId);

    const refusal = await domainRejection(
      placeBids({
        userId: bidder.userId,
        auctionId: auction.auctionId,
        amountsMinor: [100, 200, 250, 300],
      }),
    );
    expect(refusal.domainCode).toBe('AMOUNT_NOT_ALIGNED');
    expect(await readBids(db, auction.auctionId)).toHaveLength(0);
    expect(await walletBalance(bidder.userId)).toBe(before);
  });

  it('refuses more amounts than one request may carry', async () => {
    const auction = await createLiveAuction(db, { maxBidsPerUser: 1000 });
    const bidder = await createBidder(db);
    const tooMany = Array.from({ length: 101 }, (_, index) => 100 + index * 100);

    const refusal = await domainRejection(
      placeBids({ userId: bidder.userId, auctionId: auction.auctionId, amountsMinor: tooMany }),
    );
    expect(refusal.domainCode).toBe('TOO_MANY_AMOUNTS');
  });

  /**
   * The ladder is measured from the minimum, not from zero, and the maximum is
   * always on it because the auction's own configuration guarantees
   * `(max - min) % increment = 0`.
   */
  it('measures the ladder from the minimum', async () => {
    const auction = await createLiveAuction(db, {
      minBidMinor: 250n,
      maxBidMinor: 1250n,
      bidIncrementMinor: 500n,
    });
    const bidder = await createBidder(db);

    const outcome = await placeBids({
      userId: bidder.userId,
      auctionId: auction.auctionId,
      amountsMinor: [250, 750, 1250],
    });
    expect(outcome.bids).toHaveLength(3);

    const refusal = await domainRejection(
      placeBids({ userId: bidder.userId, auctionId: auction.auctionId, amountsMinor: [500] }),
    );
    expect(refusal.domainCode).toBe('AMOUNT_NOT_ALIGNED');
  });
});

describe('the duplicate rule', () => {
  it('refuses a repeat inside one request, and writes nothing', async () => {
    const auction = await createLiveAuction(db);
    const bidder = await createBidder(db);
    const before = await walletBalance(bidder.userId);

    const refusal = await domainRejection(
      placeBids({
        userId: bidder.userId,
        auctionId: auction.auctionId,
        amountsMinor: [100, 200, 200, 300],
      }),
    );
    expect(refusal.domainCode).toBe('DUPLICATE_AMOUNT');
    expect(await readBids(db, auction.auctionId)).toHaveLength(0);
    expect(await walletBalance(bidder.userId)).toBe(before);
  });

  it('refuses an amount the bidder already holds', async () => {
    const auction = await createLiveAuction(db);
    const bidder = await createBidder(db);

    await placeBids({ userId: bidder.userId, auctionId: auction.auctionId, amountsMinor: [200] });
    const refusal = await domainRejection(
      placeBids({ userId: bidder.userId, auctionId: auction.auctionId, amountsMinor: [200] }),
    );
    expect(refusal.domainCode).toBe('DUPLICATE_AMOUNT');
    expect(await readBids(db, auction.auctionId)).toHaveLength(1);
  });

  it('refuses a whole batch that collides on one existing amount', async () => {
    const auction = await createLiveAuction(db);
    const bidder = await createBidder(db);

    await placeBids({ userId: bidder.userId, auctionId: auction.auctionId, amountsMinor: [200] });
    const before = await walletBalance(bidder.userId);

    const refusal = await domainRejection(
      placeBids({
        userId: bidder.userId,
        auctionId: auction.auctionId,
        amountsMinor: [100, 200, 300],
      }),
    );
    expect(refusal.domainCode).toBe('DUPLICATE_AMOUNT');
    // 100 and 300 must not exist: no partial acceptance.
    expect(await readBids(db, auction.auctionId)).toHaveLength(1);
    expect(await walletBalance(bidder.userId)).toBe(before);
  });

  /**
   * **Two different users on the same amount is the mechanism, not a
   * collision.** The auction awards the lowest amount nobody matched, so this
   * has to be allowed or there would be nothing to be unique about.
   */
  it('allows two different bidders to hold the same amount', async () => {
    const auction = await createLiveAuction(db);
    const first = await createBidder(db);
    const second = await createBidder(db);

    await placeBids({ userId: first.userId, auctionId: auction.auctionId, amountsMinor: [2700] });
    await placeBids({ userId: second.userId, auctionId: auction.auctionId, amountsMinor: [2700] });

    const rows = await readBids(db, auction.auctionId);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === 'valid')).toBe(true);
    expect(new Set(rows.map((row) => row.userId)).size).toBe(2);
  });
});

describe('the bid limit', () => {
  it('refuses a batch that would cross the limit, and writes none of it', async () => {
    const auction = await createLiveAuction(db, { maxBidsPerUser: 3 });
    const bidder = await createBidder(db);

    await placeBids({ userId: bidder.userId, auctionId: auction.auctionId, amountsMinor: [100, 200] });
    const refusal = await domainRejection(
      placeBids({ userId: bidder.userId, auctionId: auction.auctionId, amountsMinor: [300, 400] }),
    );
    expect(refusal.domainCode).toBe('BID_LIMIT_EXCEEDED');
    expect(await readBids(db, auction.auctionId)).toHaveLength(2);
  });

  it('refuses any bid once the limit is full', async () => {
    const auction = await createLiveAuction(db, { maxBidsPerUser: 2 });
    const bidder = await createBidder(db);

    await placeBids({ userId: bidder.userId, auctionId: auction.auctionId, amountsMinor: [100, 200] });
    const refusal = await domainRejection(
      placeBids({ userId: bidder.userId, auctionId: auction.auctionId, amountsMinor: [300] }),
    );
    expect(refusal.domainCode).toBe('BID_LIMIT_EXCEEDED');
    expect(refusal.publicMessage).toContain('all your bids');
  });

  /** The limit is per auction, so a different auction is untouched. */
  it('counts the limit per auction, not per user', async () => {
    const first = await createLiveAuction(db, { maxBidsPerUser: 1 });
    const second = await createLiveAuction(db, { maxBidsPerUser: 1 });
    const bidder = await createBidder(db);

    await placeBids({ userId: bidder.userId, auctionId: first.auctionId, amountsMinor: [100] });
    const outcome = await placeBids({
      userId: bidder.userId,
      auctionId: second.auctionId,
      amountsMinor: [100],
    });
    expect(outcome.bids).toHaveLength(1);
  });

  /**
   * One limit across both channels. The brief is explicit that it is not 100
   * on the website plus 100 on Telegram, and the participant row is what makes
   * that true — the channel is only written to the bid.
   */
  it('shares one limit across channels', async () => {
    const auction = await createLiveAuction(db, { maxBidsPerUser: 2 });
    const bidder = await createBidder(db);

    await placeBids({
      userId: bidder.userId,
      auctionId: auction.auctionId,
      amountsMinor: [100],
      channel: 'web',
    });
    await placeBids({
      userId: bidder.userId,
      auctionId: auction.auctionId,
      amountsMinor: [200],
      channel: 'telegram',
    });

    const refusal = await domainRejection(
      placeBids({
        userId: bidder.userId,
        auctionId: auction.auctionId,
        amountsMinor: [300],
        channel: 'telegram',
      }),
    );
    expect(refusal.domainCode).toBe('BID_LIMIT_EXCEEDED');

    const rows = await readBids(db, auction.auctionId);
    expect(rows.map((row) => row.channel).sort()).toEqual(['telegram', 'web']);
  });
});

describe('auction state', () => {
  /** Every status that is not `live` refuses, and each for the right reason. */
  it.each([
    'draft',
    'pending_approval',
    'scheduled',
    'closing',
    'calculating',
    'completed',
    'cancelled',
    'suspended',
  ])('refuses a bid on a %s auction', async (status) => {
    const auction = await createLiveAuction(db);
    const bidder = await createBidder(db);
    await forceStatus(db, { auctionId: auction.auctionId, status, actorUserId: bidder.userId });

    const refusal = await domainRejection(
      placeBids({ userId: bidder.userId, auctionId: auction.auctionId, amountsMinor: [100] }),
    );
    // A non-public status resolves as NOT_FOUND before the status check,
    // which is correct: the response must not confirm a draft exists.
    expect(['AUCTION_NOT_LIVE', 'AUCTION_NOT_FOUND']).toContain(refusal.domainCode);
    expect(await readBids(db, auction.auctionId)).toHaveLength(0);
  });

  /**
   * Live by status, past its deadline by the clock. The close job may not have
   * run yet, and the engine must refuse anyway — which is why the time check
   * does not trust the status.
   */
  it('refuses a bid after ends_at even while the status is live', async () => {
    const auction = await createLiveAuction(db);
    const bidder = await createBidder(db);
    await forceWindow(db, {
      auctionId: auction.auctionId,
      startsAt: '-2 hours',
      endsAt: '-1 second',
    });

    const refusal = await domainRejection(
      placeBids({ userId: bidder.userId, auctionId: auction.auctionId, amountsMinor: [100] }),
    );
    expect(refusal.domainCode).toBe('AUCTION_ENDED');
  });

  it('refuses a bid before starts_at even while the status is live', async () => {
    const auction = await createLiveAuction(db);
    const bidder = await createBidder(db);
    await forceWindow(db, {
      auctionId: auction.auctionId,
      startsAt: '1 hour',
      endsAt: '2 hours',
    });

    const refusal = await domainRejection(
      placeBids({ userId: bidder.userId, auctionId: auction.auctionId, amountsMinor: [100] }),
    );
    expect(refusal.domainCode).toBe('AUCTION_NOT_STARTED');
  });

  /**
   * A live auction that holds no inventory cannot deliver what it is selling,
   * so it must not take money. An inconsistency rather than a user error, and
   * refusing is the safe side.
   */
  it('refuses a bid when the auction no longer holds its unit', async () => {
    const auction = await createLiveAuction(db);
    const bidder = await createBidder(db);
    await db.query(
      `UPDATE inventory_reservations SET state = 'released', released_at = now()
        WHERE auction_id = $1`,
      [auction.auctionId],
    );

    const refusal = await domainRejection(
      placeBids({ userId: bidder.userId, auctionId: auction.auctionId, amountsMinor: [100] }),
    );
    expect(refusal.domainCode).toBe('AUCTION_NOT_LIVE');
    expect(await readBids(db, auction.auctionId)).toHaveLength(0);
  });
});

describe('the bidder', () => {
  it('refuses a bid from an account that is not active', async () => {
    const auction = await createLiveAuction(db);
    const bidder = await createBidder(db);
    await db.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [bidder.userId]);

    const refusal = await domainRejection(
      placeBids({ userId: bidder.userId, auctionId: auction.auctionId, amountsMinor: [100] }),
    );
    expect(refusal.domainCode).toBe('BIDDER_NOT_ELIGIBLE');
  });

  it('refuses a bid from an unverified phone', async () => {
    const auction = await createLiveAuction(db);
    const bidder = await createBidder(db);
    await db.query(`UPDATE users SET phone_verified_at = NULL WHERE id = $1`, [bidder.userId]);

    const refusal = await domainRejection(
      placeBids({ userId: bidder.userId, auctionId: auction.auctionId, amountsMinor: [100] }),
    );
    expect(refusal.domainCode).toBe('BIDDER_NOT_ELIGIBLE');
    expect(refusal.publicMessage).toContain('Verify your phone');
  });
});

describe('the wallet', () => {
  it('refuses a bid the wallet cannot cover, and writes nothing', async () => {
    const auction = await createLiveAuction(db);
    const bidder = await createBidder(db, { fundMinor: 400n });

    const refusal = await domainRejection(
      placeBids({ userId: bidder.userId, auctionId: auction.auctionId, amountsMinor: [100] }),
    );
    expect(refusal.domainCode).toBe('INSUFFICIENT_FUNDS');
    expect(refusal.code).toBe('INSUFFICIENT_FUNDS');
    expect(await readBids(db, auction.auctionId)).toHaveLength(0);
    expect(await walletBalance(bidder.userId)).toBe(400n);
  });

  it('refuses a batch the wallet can only partly cover', async () => {
    const auction = await createLiveAuction(db);
    // Enough for two bids, asked for three.
    const bidder = await createBidder(db, { fundMinor: 1200n });

    const refusal = await domainRejection(
      placeBids({
        userId: bidder.userId,
        auctionId: auction.auctionId,
        amountsMinor: [100, 200, 300],
      }),
    );
    expect(refusal.domainCode).toBe('INSUFFICIENT_FUNDS');
    expect(await readBids(db, auction.auctionId)).toHaveLength(0);
    expect(await walletBalance(bidder.userId)).toBe(1200n);
  });

  it('accepts a batch that costs exactly the balance', async () => {
    const auction = await createLiveAuction(db);
    const bidder = await createBidder(db, { fundMinor: 1500n });

    const outcome = await placeBids({
      userId: bidder.userId,
      auctionId: auction.auctionId,
      amountsMinor: [100, 200, 300],
    });
    expect(outcome.bids).toHaveLength(3);
    expect(await walletBalance(bidder.userId)).toBe(0n);
  });

  it('refuses a bid from a frozen wallet', async () => {
    const auction = await createLiveAuction(db);
    const bidder = await createBidder(db);
    const account = await wallet.getWallet(bidder.userId);
    const finance = await createBidder(db, { fundMinor: 0n });
    await db.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'finance')`, [finance.userId]);
    await wallet.freezeWallet({
      walletId: account.id,
      reason: 'under review',
      actorUserId: finance.userId,
      channel: 'admin',
    });

    const refusal = await domainRejection(
      placeBids({ userId: bidder.userId, auctionId: auction.auctionId, amountsMinor: [100] }),
    );
    expect(refusal.domainCode).toBe('WALLET_FROZEN');
    expect(await readBids(db, auction.auctionId)).toHaveLength(0);
  });

  /**
   * A zero fee moves no money, so there is no entry to write.
   * `wallet_entries_amount_non_zero` would refuse one anyway; the engine must
   * not try.
   */
  it('writes no ledger entry when the fee is zero', async () => {
    const auction = await createLiveAuction(db, { bidFeeMinor: 0n });
    const bidder = await createBidder(db, { fundMinor: 0n });

    const outcome = await placeBids({
      userId: bidder.userId,
      auctionId: auction.auctionId,
      amountsMinor: [100, 200],
    });
    expect(outcome.totalFeeMinor).toBe(0n);
    expect(outcome.bids).toHaveLength(2);
    expect(await readBidFeeEntries(db, { userId: bidder.userId, auctionId: auction.auctionId })).toHaveLength(
      0,
    );

    // The bids exist and carry no entry, which is the honest representation.
    const rows = await readBids(db, auction.auctionId);
    expect(rows.every((row) => row.walletEntryId === null)).toBe(true);
    expect(rows.every((row) => row.feeMinor === 0n)).toBe(true);
  });

  it('bids on a free auction with an empty wallet', async () => {
    const auction = await createLiveAuction(db, { bidFeeMinor: 0n });
    const bidder = await createBidder(db, { fundMinor: 0n });

    const outcome = await placeBids({
      userId: bidder.userId,
      auctionId: auction.auctionId,
      amountsMinor: [100],
    });
    expect(outcome.bids).toHaveLength(1);
    expect(outcome.walletBalanceMinor).toBe(0n);
  });
});

describe('idempotency', () => {
  it('replays a retry with the original numbers and charges once', async () => {
    const auction = await createLiveAuction(db);
    const bidder = await createBidder(db);
    const key = 'retry-key-0000000001';

    const first = await placeBids({
      userId: bidder.userId,
      auctionId: auction.auctionId,
      amountsMinor: [100, 200],
      idempotencyKey: key,
    });
    const balanceAfterFirst = await walletBalance(bidder.userId);

    const second = await placeBids({
      userId: bidder.userId,
      auctionId: auction.auctionId,
      amountsMinor: [100, 200],
      idempotencyKey: key,
    });

    expect(second.replayed).toBe(true);
    expect(second.bids.map((bid) => bid.amountMinor)).toEqual([100n, 200n]);
    expect(second.totalFeeMinor).toBe(first.totalFeeMinor);
    expect(second.walletBalanceMinor).toBe(first.walletBalanceMinor);
    expect(second.bidCount).toBe(first.bidCount);
    expect(await walletBalance(bidder.userId)).toBe(balanceAfterFirst);
    expect(await readBids(db, auction.auctionId)).toHaveLength(2);
    expect(await readBidFeeEntries(db, { userId: bidder.userId, auctionId: auction.auctionId })).toHaveLength(
      1,
    );
  });

  it('replays regardless of the order the amounts arrive in', async () => {
    const auction = await createLiveAuction(db);
    const bidder = await createBidder(db);
    const key = 'order-key-0000000001';

    await placeBids({
      userId: bidder.userId,
      auctionId: auction.auctionId,
      amountsMinor: [100, 200, 300],
      idempotencyKey: key,
    });
    const replay = await placeBids({
      userId: bidder.userId,
      auctionId: auction.auctionId,
      amountsMinor: [300, 100, 200],
      idempotencyKey: key,
    });
    expect(replay.replayed).toBe(true);
  });

  it('refuses the same key carrying different amounts', async () => {
    const auction = await createLiveAuction(db);
    const bidder = await createBidder(db);
    const key = 'conflict-key-00000001';

    await placeBids({
      userId: bidder.userId,
      auctionId: auction.auctionId,
      amountsMinor: [100],
      idempotencyKey: key,
    });
    const refusal = await domainRejection(
      placeBids({
        userId: bidder.userId,
        auctionId: auction.auctionId,
        amountsMinor: [200],
        idempotencyKey: key,
      }),
    );
    expect(refusal.domainCode).toBe('IDEMPOTENCY_CONFLICT');
    expect(await readBids(db, auction.auctionId)).toHaveLength(1);
  });

  it('refuses the same key on a different auction', async () => {
    const first = await createLiveAuction(db);
    const second = await createLiveAuction(db);
    const bidder = await createBidder(db);
    const key = 'cross-auction-key-001';

    await placeBids({
      userId: bidder.userId,
      auctionId: first.auctionId,
      amountsMinor: [100],
      idempotencyKey: key,
    });
    const refusal = await domainRejection(
      placeBids({
        userId: bidder.userId,
        auctionId: second.auctionId,
        amountsMinor: [100],
        idempotencyKey: key,
      }),
    );
    expect(refusal.domainCode).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('refuses another user presenting the same key', async () => {
    const auction = await createLiveAuction(db);
    const owner = await createBidder(db);
    const stranger = await createBidder(db);
    const key = 'shared-key-000000001';

    await placeBids({
      userId: owner.userId,
      auctionId: auction.auctionId,
      amountsMinor: [100],
      idempotencyKey: key,
    });
    const refusal = await domainRejection(
      placeBids({
        userId: stranger.userId,
        auctionId: auction.auctionId,
        amountsMinor: [100],
        idempotencyKey: key,
      }),
    );
    expect(refusal.domainCode).toBe('IDEMPOTENCY_CONFLICT');
  });

  /**
   * A refused bid must not burn the key. The client fixes the balance and
   * retries the same intent — if the key were consumed, the retry would come
   * back as a conflict and the user could never complete the submission.
   */
  it('leaves the key usable after a failed submission', async () => {
    const auction = await createLiveAuction(db);
    const bidder = await createBidder(db, { fundMinor: 100n });
    const key = 'recoverable-key-00001';

    const refusal = await domainRejection(
      placeBids({
        userId: bidder.userId,
        auctionId: auction.auctionId,
        amountsMinor: [100],
        idempotencyKey: key,
      }),
    );
    expect(refusal.domainCode).toBe('INSUFFICIENT_FUNDS');

    await fundWallet(bidder.userId, 1000n);
    const outcome = await placeBids({
      userId: bidder.userId,
      auctionId: auction.auctionId,
      amountsMinor: [100],
      idempotencyKey: key,
    });
    expect(outcome.replayed).toBe(false);
    expect(outcome.bids).toHaveLength(1);
  });
});

describe('counters', () => {
  it('sets the participant row on a first bid and updates it after', async () => {
    const auction = await createLiveAuction(db);
    const bidder = await createBidder(db);

    await placeBids({
      userId: bidder.userId,
      auctionId: auction.auctionId,
      amountsMinor: [100, 200],
      channel: 'telegram',
    });
    const first = await readParticipant(db, {
      auctionId: auction.auctionId,
      userId: bidder.userId,
    });
    expect(first?.bidCount).toBe(2);
    expect(first?.totalFeesMinor).toBe(1000n);
    expect(first?.firstBidAt).not.toBeNull();
    expect(first?.joinedChannel).toBe('telegram');

    await placeBids({
      userId: bidder.userId,
      auctionId: auction.auctionId,
      amountsMinor: [300],
      channel: 'web',
    });
    const second = await readParticipant(db, {
      auctionId: auction.auctionId,
      userId: bidder.userId,
    });
    expect(second?.bidCount).toBe(3);
    expect(second?.totalFeesMinor).toBe(1500n);
    // first_bid_at is set once and never moves; last_bid_at tracks the latest.
    expect(second?.firstBidAt?.getTime()).toBe(first?.firstBidAt?.getTime());
    expect(second!.lastBidAt!.getTime()).toBeGreaterThanOrEqual(first!.lastBidAt!.getTime());
    // The channel a participant joined through does not change afterwards.
    expect(second?.joinedChannel).toBe('telegram');
  });

  it('counts a participant once however many bids they place', async () => {
    const auction = await createLiveAuction(db);
    const bidder = await createBidder(db);

    await placeBids({ userId: bidder.userId, auctionId: auction.auctionId, amountsMinor: [100, 200] });
    await placeBids({ userId: bidder.userId, auctionId: auction.auctionId, amountsMinor: [300] });

    expect(await readAuctionCounters(db, auction.auctionId)).toEqual({
      totalBids: 3,
      totalParticipants: 1,
    });
  });

  it('counts each bidder once and every bid', async () => {
    const auction = await createLiveAuction(db);
    const first = await createBidder(db);
    const second = await createBidder(db);
    const third = await createBidder(db);

    await placeBids({ userId: first.userId, auctionId: auction.auctionId, amountsMinor: [100, 200] });
    await placeBids({ userId: second.userId, auctionId: auction.auctionId, amountsMinor: [100] });
    await placeBids({ userId: third.userId, auctionId: auction.auctionId, amountsMinor: [300, 400, 500] });

    expect(await readAuctionCounters(db, auction.auctionId)).toEqual({
      totalBids: 6,
      totalParticipants: 3,
    });
    // And the stored counters agree with the rows they count.
    expect(await bidding.recountAuction(auction.auctionId)).toEqual({
      totalBids: 6,
      totalParticipants: 3,
    });
  });

  it('leaves the counters alone when a submission is refused', async () => {
    const auction = await createLiveAuction(db);
    const bidder = await createBidder(db);

    await placeBids({ userId: bidder.userId, auctionId: auction.auctionId, amountsMinor: [100] });
    await domainRejection(
      placeBids({ userId: bidder.userId, auctionId: auction.auctionId, amountsMinor: [100] }),
    );

    expect(await readAuctionCounters(db, auction.auctionId)).toEqual({
      totalBids: 1,
      totalParticipants: 1,
    });
  });

  it('does not double-count a replayed submission', async () => {
    const auction = await createLiveAuction(db);
    const bidder = await createBidder(db);
    const key = 'counter-replay-000001';

    await placeBids({
      userId: bidder.userId,
      auctionId: auction.auctionId,
      amountsMinor: [100, 200],
      idempotencyKey: key,
    });
    await placeBids({
      userId: bidder.userId,
      auctionId: auction.auctionId,
      amountsMinor: [100, 200],
      idempotencyKey: key,
    });

    expect(await readAuctionCounters(db, auction.auctionId)).toEqual({
      totalBids: 2,
      totalParticipants: 1,
    });
    expect(
      (await readParticipant(db, { auctionId: auction.auctionId, userId: bidder.userId }))?.bidCount,
    ).toBe(2);
  });
});

describe('metadata and audit', () => {
  it('records the channel, address and device on every bid in the batch', async () => {
    const auction = await createLiveAuction(db);
    const bidder = await createBidder(db);

    await placeBids({
      userId: bidder.userId,
      auctionId: auction.auctionId,
      amountsMinor: [100, 200],
      channel: 'telegram',
      ipAddress: '203.0.113.7',
      deviceHash: 'device-hash-for-tests',
    });

    const rows = await readBids(db, auction.auctionId);
    expect(rows.every((row) => row.channel === 'telegram')).toBe(true);
    expect(rows.every((row) => row.ipAddress === '203.0.113.7')).toBe(true);
    expect(rows.every((row) => row.deviceHash === 'device-hash-for-tests')).toBe(true);
  });

  /**
   * The channel is provenance. Nothing about a bid differs because it came
   * from Telegram — same fee, same status, same standing — and Phase 6's
   * winner algorithm must not be able to tell.
   */
  it('treats a Telegram bid and a web bid identically', async () => {
    const auction = await createLiveAuction(db);
    const bidder = await createBidder(db);

    const web = await placeBids({
      userId: bidder.userId,
      auctionId: auction.auctionId,
      amountsMinor: [100],
      channel: 'web',
    });
    const telegram = await placeBids({
      userId: bidder.userId,
      auctionId: auction.auctionId,
      amountsMinor: [200],
      channel: 'telegram',
    });

    expect(telegram.totalFeeMinor).toBe(web.totalFeeMinor);
    expect(telegram.bids[0]!.status).toBe(web.bids[0]!.status);
    expect(telegram.bids[0]!.feeMinor).toBe(web.bids[0]!.feeMinor);
  });

  it('writes one audit row per accepted submission', async () => {
    const auction = await createLiveAuction(db);
    const bidder = await createBidder(db);

    await placeBids({ userId: bidder.userId, auctionId: auction.auctionId, amountsMinor: [100, 200] });
    await placeBids({ userId: bidder.userId, auctionId: auction.auctionId, amountsMinor: [300] });
    await domainRejection(
      placeBids({ userId: bidder.userId, auctionId: auction.auctionId, amountsMinor: [300] }),
    );

    expect(await countAuditRows(db, auction.auctionId)).toBe(2);
  });

  /**
   * `writeAuditLog` also emits a structured log line, so anything in `details`
   * reaches the application log. A user's ladder there would be their whole
   * strategy sitting in a log aggregator.
   */
  it('records a submission without the amounts', async () => {
    const auction = await createLiveAuction(db);
    const bidder = await createBidder(db);

    await placeBids({
      userId: bidder.userId,
      auctionId: auction.auctionId,
      amountsMinor: [1700, 2300, 4900],
    });

    const payloads = await readAuditPayloads(db, auction.auctionId);
    expect(payloads).toHaveLength(1);
    const serialised = JSON.stringify(payloads[0]);
    expect(serialised).not.toContain('1700');
    expect(serialised).not.toContain('2300');
    expect(serialised).not.toContain('4900');
    // What it does carry: how many, for how much, and whether it was a first bid.
    expect(payloads[0]).toMatchObject({ bidCount: 3, feeMinor: '1500', firstBid: true });
  });
});

describe('reads', () => {
  it('returns the caller their own bids and allowance', async () => {
    const auction = await createLiveAuction(db, { maxBidsPerUser: 5 });
    const bidder = await createBidder(db);
    const other = await createBidder(db);

    await placeBids({ userId: bidder.userId, auctionId: auction.auctionId, amountsMinor: [100, 200] });
    await placeBids({ userId: other.userId, auctionId: auction.auctionId, amountsMinor: [300] });

    const mine = await bidding.getMyBids({
      userId: bidder.userId,
      auctionReference: auction.auctionId,
    });
    expect(mine.bids).toHaveLength(2);
    expect(mine.bidCount).toBe(2);
    expect(mine.bidsRemaining).toBe(3);
    expect(mine.totalFeesMinor).toBe(1000n);
    // Never another bidder's amounts.
    expect(mine.bids.map((bid) => bid.amountMinor)).toEqual([100n, 200n]);
  });

  it('reports a full allowance to a user who has not bid', async () => {
    const auction = await createLiveAuction(db, { maxBidsPerUser: 7 });
    const bidder = await createBidder(db);

    const allowance = await bidding.getAllowance({
      userId: bidder.userId,
      auctionId: auction.auctionId,
    });
    expect(allowance).toMatchObject({ bidCount: 0, maxBidsPerUser: 7, bidsRemaining: 7 });
  });

  /**
   * The wire shape is where a uniqueness leak would show, so it is asserted
   * here rather than only in the smoke test: `valid` becomes `submitted`, and
   * no field names another bidder or an amount's occupancy.
   */
  it('maps a bid to the wire without any uniqueness signal', async () => {
    const auction = await createLiveAuction(db);
    const bidder = await createBidder(db);
    const outcome = await placeBids({
      userId: bidder.userId,
      auctionId: auction.auctionId,
      amountsMinor: [100],
    });

    const dto = bidding.toSubmitResultDto(outcome);
    expect(dto.bids[0]!.status).toBe('submitted');
    const keys = Object.keys(dto.bids[0]!);
    for (const forbidden of ['unique', 'isUnique', 'bidderCount', 'occupancy', 'matched']) {
      expect(keys).not.toContain(forbidden);
    }
    const serialised = JSON.stringify(dto);
    expect(serialised).not.toContain('unique');
    // Money crosses the wire as a string, never a JSON number.
    expect(serialised).toContain('"totalFeeMinor":"500"');
  });
});

describe('the Phase 6 boundary', () => {
  /**
   * The engine ends at accepted bids. Nothing here counts unique amounts,
   * ranks them, or writes a result — and an auction may perfectly well be
   * live with zero bids.
   */
  it('writes no auction result and no order', async () => {
    const auction = await createLiveAuction(db);
    const bidder = await createBidder(db);
    await placeBids({ userId: bidder.userId, auctionId: auction.auctionId, amountsMinor: [100, 200] });

    const { rows } = await db.query<{ results: string; orders: string }>(
      `SELECT (SELECT count(*) FROM auction_results WHERE auction_id = $1) AS results,
              (SELECT count(*) FROM orders WHERE auction_id = $1) AS orders`,
      [auction.auctionId],
    );
    expect(rows[0]).toEqual({ results: '0', orders: '0' });
  });

  it('leaves the auction live and its status untouched by bidding', async () => {
    const auction = await createLiveAuction(db);
    const bidder = await createBidder(db);
    await placeBids({ userId: bidder.userId, auctionId: auction.auctionId, amountsMinor: [100] });

    const after = await auctions.getAuction(auction.auctionId);
    expect(after.status).toBe('live');
    expect(after.closedAt).toBeNull();
  });
});
