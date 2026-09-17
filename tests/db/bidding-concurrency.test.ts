import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as bidding from '@howlow/api/modules/bidding';
import { closePool } from '@howlow/api/db';
import { adminClient, cleanup, cleanupCategories, settle } from './catalog-helpers.js';
import {
  createBidder,
  createLiveAuction,
  forceWindow,
  placeBids,
  readAuctionCounters,
  readBidFeeEntries,
  readBids,
  readParticipant,
  walletBalance,
} from './bidding-helpers.js';

/**
 * The six mandatory concurrency cases, plus the invariants they protect.
 *
 * These are the tests that matter most in the phase. Every one of them would
 * pass against a broken engine if it ran the requests one after another — the
 * whole point is that they are issued together and the *database* decides the
 * order. Each is written so that removing the lock or the constraint it
 * exercises makes it fail, and the effort spent here is in making them
 * deterministic rather than usually-right:
 *
 *   - Requests are built as thunks and started in one `map`, so none of them
 *     has begun before the others are queued.
 *   - Assertions are on the *database* after the dust settles, not only on
 *     what the calls returned, because a counter can be wrong while every
 *     response looks fine.
 *   - Each one asserts the full invariant, not just the happy count: the
 *     wallet, the ledger, the participant row and the auction row have to
 *     agree with the bids that exist.
 *
 * Every case here was checked by deliberately removing the mechanism it
 * exercises and confirming it fails. With the auction row lock and the
 * participant row lock both removed, six of these thirteen fail; with either
 * one restored, TEST 1 passes again, which is how the redundancy noted below
 * came to be documented rather than guessed at.
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

/** Start every operation before awaiting any of them. */
const race = async <T>(thunks: readonly (() => Promise<T>)[]) => settle(thunks.map((thunk) => thunk()));

describe('TEST 1 — same user, concurrent batches at the limit', () => {
  /**
   * The user holds 98 of 100. Two requests each ask for 2 more.
   *
   * Exactly one may succeed: 98 + 2 + 2 is 102. Without serialisation both
   * requests read `bid_count = 98`, both pass the check, and one bidder ends
   * up with 102 bids.
   *
   * **Two independent mechanisms each prevent that**, which is worth stating
   * because it was measured rather than assumed. Breaking either the auction
   * row lock or the participant row lock alone leaves this test passing — the
   * survivor serialises the pair on its own. Breaking both makes it fail with
   * two fulfilled batches and a count of 102. That is defence in depth and it
   * is deliberate: the participant lock is what would still hold if a future
   * operation touched a participant row without taking the auction lock first.
   */
  it('lets exactly one of two batches through and lands on the limit', async () => {
    // The ladder has to hold more than 100 rungs for a 100-bid limit to be
    // reachable at all: 100..20000 in steps of 100 is 200 of them.
    const auction = await createLiveAuction(db, {
      maxBidsPerUser: 100,
      bidFeeMinor: 100n,
      minBidMinor: 100n,
      maxBidMinor: 20_000n,
      bidIncrementMinor: 100n,
    });
    const bidder = await createBidder(db, { fundMinor: 100_000n });

    // 98 bids, in batches the request limit allows.
    const filled = Array.from({ length: 98 }, (_, index) => 100 + index * 100);
    for (let start = 0; start < filled.length; start += 49) {
      await placeBids({
        userId: bidder.userId,
        auctionId: auction.auctionId,
        amountsMinor: filled.slice(start, start + 49),
      });
    }
    expect(
      (await readParticipant(db, { auctionId: auction.auctionId, userId: bidder.userId }))?.bidCount,
    ).toBe(98);

    const outcome = await race([
      () =>
        placeBids({
          userId: bidder.userId,
          auctionId: auction.auctionId,
          amountsMinor: [19_900, 20_000].map(String),
        }),
      () =>
        placeBids({
          userId: bidder.userId,
          auctionId: auction.auctionId,
          amountsMinor: [19_800, 19_700].map(String),
        }),
    ]);

    expect(outcome.otherErrors).toEqual([]);
    expect(outcome.fulfilled).toHaveLength(1);
    expect(outcome.domainErrors).toEqual(['BID_LIMIT_EXCEEDED']);

    const participant = await readParticipant(db, {
      auctionId: auction.auctionId,
      userId: bidder.userId,
    });
    expect(participant?.bidCount).toBe(100);
    // The stored counter and the rows it counts must agree.
    expect(await readBids(db, auction.auctionId)).toHaveLength(100);
    expect(await readAuctionCounters(db, auction.auctionId)).toEqual({
      totalBids: 100,
      totalParticipants: 1,
    });
    // And the fees paid match the bids that exist: 100 bids at 100.
    expect(participant?.totalFeesMinor).toBe(10_000n);
  });
});

describe('TEST 2 — same user, concurrent identical amount', () => {
  /**
   * Two requests, one amount, one bidder.
   *
   * `bids_valid_amount_unique_key` is the arbiter. The engine's preceding
   * SELECT cannot be: both requests run it before either inserts, so both see
   * nothing. What saves the auction is that the second insert loses on the
   * index and the engine abandons its whole transaction.
   */
  it('accepts one and refuses the other as a duplicate', async () => {
    const auction = await createLiveAuction(db, { bidFeeMinor: 100n });
    const bidder = await createBidder(db, { fundMinor: 10_000n });
    const before = await walletBalance(bidder.userId);

    const outcome = await race([
      () => placeBids({ userId: bidder.userId, auctionId: auction.auctionId, amountsMinor: [2700] }),
      () => placeBids({ userId: bidder.userId, auctionId: auction.auctionId, amountsMinor: [2700] }),
    ]);

    expect(outcome.otherErrors).toEqual([]);
    expect(outcome.fulfilled).toHaveLength(1);
    expect(outcome.domainErrors).toEqual(['DUPLICATE_AMOUNT']);

    const rows = await readBids(db, auction.auctionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amountMinor).toBe(2700n);
    // Charged exactly once.
    expect(await walletBalance(bidder.userId)).toBe(before - 100n);
    expect(await readBidFeeEntries(db, { userId: bidder.userId, auctionId: auction.auctionId })).toHaveLength(
      1,
    );
    expect(await readAuctionCounters(db, auction.auctionId)).toEqual({
      totalBids: 1,
      totalParticipants: 1,
    });
  });

  /**
   * The same race through one batch each, where the collision is on one amount
   * out of three. The loser must write none of its three, not two of them.
   */
  it('refuses the losing batch whole', async () => {
    const auction = await createLiveAuction(db, { bidFeeMinor: 100n });
    const bidder = await createBidder(db, { fundMinor: 10_000n });

    const outcome = await race([
      () =>
        placeBids({
          userId: bidder.userId,
          auctionId: auction.auctionId,
          amountsMinor: [100, 200, 300],
        }),
      () =>
        placeBids({
          userId: bidder.userId,
          auctionId: auction.auctionId,
          amountsMinor: [300, 400, 500],
        }),
    ]);

    expect(outcome.otherErrors).toEqual([]);
    expect(outcome.fulfilled).toHaveLength(1);
    expect(outcome.domainErrors).toEqual(['DUPLICATE_AMOUNT']);
    // Three bids, from whichever batch won — never four, five or six.
    expect(await readBids(db, auction.auctionId)).toHaveLength(3);
  });
});

describe('TEST 3 — different users, same amount', () => {
  /**
   * **Both must succeed.** This is the mechanism the auction runs on: the
   * winner is the lowest amount nobody else matched, so two bidders choosing
   * 27 is the situation the platform exists to resolve, not a conflict to
   * serialise away.
   *
   * It is also the test that would fail if the duplicate index were widened to
   * `(auction_id, amount_minor)` — a plausible-looking mistake that would
   * quietly make the game unplayable.
   */
  it('accepts the same amount from two different bidders', async () => {
    const auction = await createLiveAuction(db, { bidFeeMinor: 100n });
    const first = await createBidder(db, { fundMinor: 10_000n });
    const second = await createBidder(db, { fundMinor: 10_000n });

    const outcome = await race([
      () => placeBids({ userId: first.userId, auctionId: auction.auctionId, amountsMinor: [2700] }),
      () => placeBids({ userId: second.userId, auctionId: auction.auctionId, amountsMinor: [2700] }),
    ]);

    expect(outcome.domainErrors).toEqual([]);
    expect(outcome.otherErrors).toEqual([]);
    expect(outcome.fulfilled).toHaveLength(2);

    const rows = await readBids(db, auction.auctionId);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === 'valid')).toBe(true);
    expect(rows.every((row) => row.amountMinor === 2700n)).toBe(true);
    expect(new Set(rows.map((row) => row.userId)).size).toBe(2);
    expect(await readAuctionCounters(db, auction.auctionId)).toEqual({
      totalBids: 2,
      totalParticipants: 2,
    });
  });

  /** Ten bidders, all on the same amount, all valid. */
  it('accepts a crowd on one amount', async () => {
    const auction = await createLiveAuction(db, { bidFeeMinor: 100n });
    const bidders = await Promise.all(
      Array.from({ length: 10 }, () => createBidder(db, { fundMinor: 10_000n })),
    );

    const outcome = await race(
      bidders.map(
        (bidder) => () =>
          placeBids({ userId: bidder.userId, auctionId: auction.auctionId, amountsMinor: [3300] }),
      ),
    );

    expect(outcome.domainErrors).toEqual([]);
    expect(outcome.fulfilled).toHaveLength(10);
    expect(await readBids(db, auction.auctionId)).toHaveLength(10);
    expect(await readAuctionCounters(db, auction.auctionId)).toEqual({
      totalBids: 10,
      totalParticipants: 10,
    });
  });
});

describe('TEST 4 — wallet concurrency', () => {
  /**
   * One wallet, 10 000. Two batches costing 8 000 each.
   *
   * The wallet row lock inside `applyMovement` decides: the second debit reads
   * the balance the first committed. Without it both read 10 000, both pass,
   * and the balance goes negative — which `wallets_available_non_negative`
   * would then refuse, turning a clean refusal into a constraint violation and
   * a 500.
   */
  it('lets one batch through and refuses the other for funds', async () => {
    const auction = await createLiveAuction(db, { bidFeeMinor: 1000n, maxBidsPerUser: 50 });
    const bidder = await createBidder(db, { fundMinor: 10_000n });

    const outcome = await race([
      () =>
        placeBids({
          userId: bidder.userId,
          auctionId: auction.auctionId,
          amountsMinor: [100, 200, 300, 400, 500, 600, 700, 800],
        }),
      () =>
        placeBids({
          userId: bidder.userId,
          auctionId: auction.auctionId,
          amountsMinor: [1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800],
        }),
    ]);

    expect(outcome.otherErrors).toEqual([]);
    expect(outcome.fulfilled).toHaveLength(1);
    expect(outcome.domainErrors).toEqual(['INSUFFICIENT_FUNDS']);

    // 10 000 less one batch of eight at 1 000.
    expect(await walletBalance(bidder.userId)).toBe(2000n);
    expect(await readBids(db, auction.auctionId)).toHaveLength(8);
    const entries = await readBidFeeEntries(db, {
      userId: bidder.userId,
      auctionId: auction.auctionId,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.amountMinor).toBe(-8000n);
    expect(entries[0]!.balanceAfterMinor).toBe(2000n);
  });

  /**
   * The same money, two auctions. The wallet is the shared resource, so the
   * race is real even though nothing else is contended — and it proves the
   * refusal comes from the balance rather than from anything auction-scoped.
   */
  it('refuses the second of two auctions when the wallet covers only one', async () => {
    const first = await createLiveAuction(db, { bidFeeMinor: 8000n });
    const second = await createLiveAuction(db, { bidFeeMinor: 8000n });
    const bidder = await createBidder(db, { fundMinor: 10_000n });

    const outcome = await race([
      () => placeBids({ userId: bidder.userId, auctionId: first.auctionId, amountsMinor: [100] }),
      () => placeBids({ userId: bidder.userId, auctionId: second.auctionId, amountsMinor: [100] }),
    ]);

    expect(outcome.otherErrors).toEqual([]);
    expect(outcome.fulfilled).toHaveLength(1);
    expect(outcome.domainErrors).toEqual(['INSUFFICIENT_FUNDS']);
    expect(await walletBalance(bidder.userId)).toBe(2000n);

    // Exactly one auction holds a bid.
    const bidCounts = [
      (await readBids(db, first.auctionId)).length,
      (await readBids(db, second.auctionId)).length,
    ].sort();
    expect(bidCounts).toEqual([0, 1]);
  });
});

describe('TEST 5 — auction counters under load', () => {
  /**
   * Twelve bidders, batches of varying size, all at once.
   *
   * The auction row lock is what makes the totals right: every bid transaction
   * takes it before touching the counters, so the increments serialise even
   * though the bidders do not. The assertion is not "the counters look
   * plausible" but "the counters equal a fresh recount of the rows" — which is
   * the only statement that catches a lost update.
   */
  it('keeps total_bids and total_participants exactly equal to the rows', async () => {
    const auction = await createLiveAuction(db, { bidFeeMinor: 100n, maxBidsPerUser: 20 });
    const bidders = await Promise.all(
      Array.from({ length: 12 }, () => createBidder(db, { fundMinor: 50_000n })),
    );

    // Distinct ladders per bidder, of different lengths, so the batch sizes
    // vary and every bidder is a new participant.
    const outcome = await race(
      bidders.map((bidder, index) => () => {
        const size = (index % 4) + 1;
        const amounts = Array.from({ length: size }, (_, step) => 100 + (index * 4 + step) * 100);
        return placeBids({
          userId: bidder.userId,
          auctionId: auction.auctionId,
          amountsMinor: amounts,
        });
      }),
    );

    expect(outcome.otherErrors).toEqual([]);
    expect(outcome.domainErrors).toEqual([]);
    expect(outcome.fulfilled).toHaveLength(12);

    const stored = await readAuctionCounters(db, auction.auctionId);
    const recounted = await bidding.recountAuction(auction.auctionId);
    expect(stored).toEqual(recounted);
    expect(stored.totalParticipants).toBe(12);
    // 1+2+3+4 repeated three times.
    expect(stored.totalBids).toBe(30);
    expect(await readBids(db, auction.auctionId)).toHaveLength(30);
  });

  /**
   * The same bidder in several concurrent batches must be counted as one
   * participant, however the requests interleave. `total_participants` is
   * incremented only by the request that created the participant row, and the
   * upsert guarantees exactly one of them does.
   */
  it('counts a repeat bidder once across concurrent batches', async () => {
    const auction = await createLiveAuction(db, { bidFeeMinor: 100n, maxBidsPerUser: 20 });
    const bidder = await createBidder(db, { fundMinor: 50_000n });

    const outcome = await race([
      () => placeBids({ userId: bidder.userId, auctionId: auction.auctionId, amountsMinor: [100, 200] }),
      () => placeBids({ userId: bidder.userId, auctionId: auction.auctionId, amountsMinor: [300, 400] }),
      () => placeBids({ userId: bidder.userId, auctionId: auction.auctionId, amountsMinor: [500, 600] }),
    ]);

    expect(outcome.otherErrors).toEqual([]);
    expect(outcome.domainErrors).toEqual([]);
    expect(outcome.fulfilled).toHaveLength(3);

    const stored = await readAuctionCounters(db, auction.auctionId);
    expect(stored).toEqual({ totalBids: 6, totalParticipants: 1 });
    expect(stored).toEqual(await bidding.recountAuction(auction.auctionId));
    expect(
      (await readParticipant(db, { auctionId: auction.auctionId, userId: bidder.userId }))?.bidCount,
    ).toBe(6);
  });
});

describe('TEST 6 — last-second bids', () => {
  /**
   * The database clock decides, and nothing else can.
   *
   * The window is moved to end a moment from now, then a burst of bids is
   * issued across that boundary. Whatever mix of accepted and refused comes
   * back, the invariant is absolute: no accepted bid may exist on an auction
   * whose deadline had passed when the bid was judged.
   */
  it('accepts before the deadline and refuses after it, by database time', async () => {
    const auction = await createLiveAuction(db, { bidFeeMinor: 100n, maxBidsPerUser: 50 });
    const bidder = await createBidder(db, { fundMinor: 50_000n });

    // Ends very shortly. The engine reads `clock_timestamp()` after taking the
    // auction lock, so bids that queue past the deadline are refused even
    // though their transactions began before it.
    await forceWindow(db, { auctionId: auction.auctionId, startsAt: '-1 hour', endsAt: '400 milliseconds' });

    const outcome = await race(
      Array.from({ length: 12 }, (_, index) => async () => {
        // Spread across the boundary: the first few land inside the window,
        // the rest after it.
        await new Promise((resolve) => setTimeout(resolve, index * 80));
        return placeBids({
          userId: bidder.userId,
          auctionId: auction.auctionId,
          amountsMinor: [100 + index * 100],
        });
      }),
    );

    expect(outcome.otherErrors).toEqual([]);
    // Both outcomes must occur, or the test proves nothing about the boundary.
    expect(outcome.fulfilled.length).toBeGreaterThan(0);
    expect(outcome.domainErrors.length).toBeGreaterThan(0);
    expect(new Set(outcome.domainErrors)).toEqual(new Set(['AUCTION_ENDED']));

    // Every accepted bid was created before the auction's deadline, as the
    // database records both.
    const { rows } = await db.query<{ late: string }>(
      `SELECT count(*) AS late FROM bids b
         JOIN auctions a ON a.id = b.auction_id
        WHERE b.auction_id = $1 AND b.created_at >= a.ends_at`,
      [auction.auctionId],
    );
    expect(rows[0]!.late).toBe('0');
    expect(await readBids(db, auction.auctionId)).toHaveLength(outcome.fulfilled.length);
  });

  /**
   * A bid whose transaction begins before the deadline but reaches the front of
   * the queue after it must be refused.
   *
   * This is the case `now()` would get wrong: it is the transaction's start
   * time, so a request that waited on the auction lock across the deadline
   * would be judged against the moment it began waiting. Holding the auction
   * lock from another transaction forces exactly that wait.
   */
  it('refuses a bid that waited on the lock past the deadline', async () => {
    const auction = await createLiveAuction(db, { bidFeeMinor: 100n });
    const bidder = await createBidder(db, { fundMinor: 10_000n });
    await forceWindow(db, { auctionId: auction.auctionId, startsAt: '-1 hour', endsAt: '500 milliseconds' });

    // A second connection holds the auction row, so the bid blocks on it.
    const blocker = await adminClient();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM auctions WHERE id = $1 FOR UPDATE', [auction.auctionId]);

    const attempt = placeBids({
      userId: bidder.userId,
      auctionId: auction.auctionId,
      amountsMinor: [100],
    });

    // Let the deadline pass while the bid waits, then release the lock.
    await new Promise((resolve) => setTimeout(resolve, 900));
    await blocker.query('COMMIT');
    await blocker.end();

    const outcome = await settle([attempt]);
    expect(outcome.otherErrors).toEqual([]);
    expect(outcome.domainErrors).toEqual(['AUCTION_ENDED']);
    expect(await readBids(db, auction.auctionId)).toHaveLength(0);
    expect(await walletBalance(bidder.userId)).toBe(10_000n);
  });
});

describe('idempotency under concurrency', () => {
  /**
   * The network-retry case: the same request twice, at once.
   *
   * The second blocks on the uncommitted `(scope, key)` index entry while
   * holding no auction, wallet or participant lock, then finds the committed
   * response and replays. One batch, one charge, one audit row.
   */
  it('charges once when the same key arrives twice at the same moment', async () => {
    const auction = await createLiveAuction(db, { bidFeeMinor: 500n });
    const bidder = await createBidder(db, { fundMinor: 10_000n });
    const key = 'concurrent-retry-0001';
    const before = await walletBalance(bidder.userId);

    const outcome = await race([
      () =>
        placeBids({
          userId: bidder.userId,
          auctionId: auction.auctionId,
          amountsMinor: [100, 200],
          idempotencyKey: key,
        }),
      () =>
        placeBids({
          userId: bidder.userId,
          auctionId: auction.auctionId,
          amountsMinor: [100, 200],
          idempotencyKey: key,
        }),
    ]);

    expect(outcome.otherErrors).toEqual([]);
    expect(outcome.domainErrors).toEqual([]);
    expect(outcome.fulfilled).toHaveLength(2);
    // One did the work, one replayed it.
    expect(outcome.fulfilled.filter((result) => result.replayed)).toHaveLength(1);

    expect(await readBids(db, auction.auctionId)).toHaveLength(2);
    expect(await walletBalance(bidder.userId)).toBe(before - 1000n);
    expect(await readBidFeeEntries(db, { userId: bidder.userId, auctionId: auction.auctionId })).toHaveLength(
      1,
    );
    expect(await readAuctionCounters(db, auction.auctionId)).toEqual({
      totalBids: 2,
      totalParticipants: 1,
    });
  });

  /** Ten simultaneous retries of one intent still produce one batch. */
  it('survives a burst of retries of the same request', async () => {
    const auction = await createLiveAuction(db, { bidFeeMinor: 500n });
    const bidder = await createBidder(db, { fundMinor: 10_000n });
    const key = 'burst-retry-000000001';

    const outcome = await race(
      Array.from(
        { length: 10 },
        () => () =>
          placeBids({
            userId: bidder.userId,
            auctionId: auction.auctionId,
            amountsMinor: [700],
            idempotencyKey: key,
          }),
      ),
    );

    expect(outcome.otherErrors).toEqual([]);
    expect(outcome.domainErrors).toEqual([]);
    expect(outcome.fulfilled).toHaveLength(10);
    expect(outcome.fulfilled.filter((result) => !result.replayed)).toHaveLength(1);
    expect(await readBids(db, auction.auctionId)).toHaveLength(1);
    expect(await readBidFeeEntries(db, { userId: bidder.userId, auctionId: auction.auctionId })).toHaveLength(
      1,
    );
  });
});
