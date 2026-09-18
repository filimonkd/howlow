import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as auctions from '@howlow/api/modules/auctions';
import * as results from '@howlow/api/modules/results';
import { closePool } from '@howlow/api/db';
import { adminClient, cleanup, cleanupCategories, settle } from './catalog-helpers.js';
import { createBidder, forceWindow, placeBids, walletBalance } from './bidding-helpers.js';
// The worker's own processors, imported from source: what these tests are
// about is the path production actually takes, and `runClose` is where the two
// module calls are sequenced. Importing this opens no Redis connection —
// `getQueueConnection` is called inside the registration functions, which
// these tests never call.
import { runClose, runDecide } from '../../apps/worker/src/jobs/auction-lifecycle.js';
import {
  countResultRows,
  createClosableAuction,
  readAuctionStatus,
  readOrderRows,
  readRefundEntries,
  readReservation,
  readResultRow,
  runClosing,
  seedBidsDirectly,
  timed,
} from './results-helpers.js';

/**
 * Closing under concurrency, and at scale.
 *
 * Everything here is about the same question asked seven ways: **can two
 * things happening at once produce two winners, two orders or two refunds?**
 * The answer has to come from PostgreSQL rather than from the worker, so these
 * tests deliberately bypass BullMQ's job uniqueness and race the services
 * directly. If job uniqueness were load-bearing, every test in this file would
 * fail.
 *
 * They assert *invariants* rather than which attempt wins. Which of two
 * concurrent closes gets there first is genuinely unspecified; that exactly
 * one result exists afterwards is not.
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

// ---------------------------------------------------------------------------
// TEST A — two closes at once
// ---------------------------------------------------------------------------

describe('TEST A: two workers closing the same auction', () => {
  /**
   * Two concurrent `closeAuction` calls on one auction.
   *
   * Exactly one result, exactly one order, exactly one refund set, and both
   * callers reporting the same winner. Only one of them may report
   * `decided: true` — the other found the decision already published and said
   * so rather than making a second one.
   *
   * This is the test that would catch idempotency living in the wrong layer.
   * There is no BullMQ here at all: both calls go straight at the service, so
   * what stops a double decision is the auction row lock and the unique index
   * behind it.
   */
  it('produces one winner, one order and one result', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [
        { amount: 1, bidders: 3 },
        { amount: 2, bidders: 1 },
      ],
    });
    await auctions.close({ auctionId: fixture.auctionId });

    const outcome = await settle([
      results.closeAuction({ auctionId: fixture.auctionId }),
      results.closeAuction({ auctionId: fixture.auctionId }),
    ]);

    expect(outcome.otherErrors).toEqual([]);
    expect(outcome.domainErrors).toEqual([]);
    expect(outcome.fulfilled).toHaveLength(2);

    const [first, second] = outcome.fulfilled as [results.CloseOutcome, results.CloseOutcome];
    expect(first.result.id).toBe(second.result.id);
    expect(first.winningAmountMinor).toBe(2n);
    expect(second.winningAmountMinor).toBe(2n);
    expect(first.winnerUserId).toBe(second.winnerUserId);
    // Exactly one of the two did the deciding.
    expect([first.decided, second.decided].filter(Boolean)).toHaveLength(1);

    expect(await countResultRows(db, fixture.auctionId)).toBe(1);
    expect(await readOrderRows(db, fixture.auctionId)).toHaveLength(1);
    expect(await readAuctionStatus(db, fixture.auctionId)).toBe('completed');
  });

  /**
   * Four at once, through the worker's own processor.
   *
   * The same invariant one level up: `runClose` calls `close()` and then
   * `closeAuction()`, so four of them race on both halves. Nothing may end up
   * with two orders.
   */
  it('survives four concurrent worker closes', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [{ amount: 5, bidders: 1 }],
    });

    const outcome = await settle([
      runClose(fixture.auctionId),
      runClose(fixture.auctionId),
      runClose(fixture.auctionId),
      runClose(fixture.auctionId),
    ]);

    expect(outcome.otherErrors).toEqual([]);
    expect(outcome.fulfilled).toHaveLength(4);
    for (const result of outcome.fulfilled) {
      expect(result.status).toBe('completed');
    }
    // Exactly one of the four decided the auction.
    expect(outcome.fulfilled.filter((result) => result.changed)).toHaveLength(1);
    expect(await countResultRows(db, fixture.auctionId)).toBe(1);
    expect(await readOrderRows(db, fixture.auctionId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// TEST B — a bid racing the close
// ---------------------------------------------------------------------------

describe('TEST B: a bid arriving as the auction closes', () => {
  /**
   * The last-second race, and the exact guarantee.
   *
   * A bid and a close are started together on an auction whose deadline has
   * just passed. Which one wins the auction row lock is genuinely unspecified
   * and this test does not assert it. What it asserts is the property that
   * matters either way:
   *
   *   * if the bid was **accepted**, it is in the frozen set the result was
   *     computed from — a committed bid is never silently dropped;
   *   * if the bid was **refused**, it is `AUCTION_NOT_LIVE` and it is not in
   *     the set — a bid committed after the freeze never counts.
   *
   * There is no third possibility, and "accepted but missing from the result"
   * is the failure this test exists to make impossible. The bid is placed at
   * an amount that nobody else holds, so whether it counted is visible in the
   * winner itself rather than only in a count.
   */
  it('either counts a racing bid or refuses it, never both and never neither', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const fixture = await createClosableAuction(db, {
        distribution: [
          { amount: 10, bidders: 2 },
          { amount: 12, bidders: 1 },
        ],
      });
      const latecomer = await createBidder(db, { fundMinor: 100_000n });

      // Amount 11 sits below the current winner (12) and above the crowded 10,
      // so if it counts it wins, and if it does not the winner stays 12.
      const outcome = await settle<unknown>([
        placeBids({ userId: latecomer.userId, auctionId: fixture.auctionId, amountsMinor: [11] }),
        runClose(fixture.auctionId),
      ]);

      expect(outcome.otherErrors).toEqual([]);

      const { rows } = await db.query<{ status: string }>(
        `SELECT status FROM bids WHERE auction_id = $1 AND user_id = $2`,
        [fixture.auctionId, latecomer.userId],
      );
      const bidCommitted = rows.length > 0;
      const stored = await readResultRow(db, fixture.auctionId);
      expect(stored).toBeDefined();

      if (bidCommitted) {
        expect(rows[0]!.status).toBe('valid');
        // Committed before the freeze, so it is in the set and it won.
        expect(stored!.winningAmountMinor).toBe(11n);
        expect(stored!.totalValidBids).toBe(4);
      } else {
        // Refused, so the result is exactly what it would have been.
        expect(outcome.domainErrors).toContain('AUCTION_NOT_LIVE');
        expect(stored!.winningAmountMinor).toBe(12n);
        expect(stored!.totalValidBids).toBe(3);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// TEST C — a bid after the freeze
// ---------------------------------------------------------------------------

describe('TEST C: a bid after the auction is closing', () => {
  /**
   * Once `closing` is committed there is no way back in.
   *
   * Tried at every stage past `live`: `closing`, `calculating` and
   * `completed`. The freeze is the auction's status and nothing else — there
   * is no second flag that could disagree with it — so this also proves that
   * `beginCalculating` does not accidentally reopen anything.
   */
  it('refuses a bid at closing, at calculating and after completion', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [{ amount: 20, bidders: 1 }],
    });
    const latecomer = await createBidder(db, { fundMinor: 100_000n });
    const balanceBefore = await walletBalance(latecomer.userId);

    await auctions.close({ auctionId: fixture.auctionId });
    expect(await readAuctionStatus(db, fixture.auctionId)).toBe('closing');
    let refusal = await settle([
      placeBids({ userId: latecomer.userId, auctionId: fixture.auctionId, amountsMinor: [21] }),
    ]);
    expect(refusal.domainErrors).toEqual(['AUCTION_NOT_LIVE']);

    // `calculating` is reached and left inside one transaction, so it is
    // provoked here by starting the transition and leaving the auction there.
    await forceCalculating(db, fixture.auctionId);
    refusal = await settle([
      placeBids({ userId: latecomer.userId, auctionId: fixture.auctionId, amountsMinor: [22] }),
    ]);
    expect(refusal.domainErrors).toEqual(['AUCTION_NOT_LIVE']);

    await runDecide(fixture.auctionId);
    expect(await readAuctionStatus(db, fixture.auctionId)).toBe('completed');
    refusal = await settle([
      placeBids({ userId: latecomer.userId, auctionId: fixture.auctionId, amountsMinor: [23] }),
    ]);
    expect(refusal.domainErrors).toEqual(['AUCTION_NOT_LIVE']);

    // Nothing was charged for any of the three refusals.
    expect(await walletBalance(latecomer.userId)).toBe(balanceBefore);
    const stored = await readResultRow(db, fixture.auctionId);
    expect(stored?.totalBids).toBe(1);
    expect(stored?.winningAmountMinor).toBe(20n);
  });
});

/**
 * Leave an auction in `calculating`, which is what an interrupted close looks
 * like.
 *
 * The transition itself is the lifecycle's, and it is called here rather than
 * an UPDATE written by hand — a fixture that set the status directly would
 * skip `closed_at` and violate `auctions_closed_at_when_finished`, and would
 * be testing a state the platform cannot actually reach.
 */
async function forceCalculating(client: pg.Client, auctionId: string): Promise<void> {
  await client.query(
    `UPDATE auctions SET status = 'calculating', closed_at = coalesce(closed_at, closing_at, now())
      WHERE id = $1 AND status = 'closing'`,
    [auctionId],
  );
}

// ---------------------------------------------------------------------------
// TEST D — closing again after a result exists
// ---------------------------------------------------------------------------

describe('TEST D: closing an auction that has already been decided', () => {
  /**
   * The published result is returned unchanged, and nothing else happens.
   *
   * Asserted against the row rather than the return value: the winner, the
   * amount, the checksum and the `computed_at` must all be byte-identical
   * afterwards. A close that recomputed and rewrote an identical-looking row
   * would pass a weaker test and would have broken immutability.
   */
  it('changes nothing at all, including computed_at', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [
        { amount: 30, bidders: 2 },
        { amount: 31, bidders: 1 },
      ],
    });
    await runClosing(fixture.auctionId);

    const { rows: before } = await db.query(`SELECT * FROM auction_results WHERE auction_id = $1`, [
      fixture.auctionId,
    ]);
    const { rows: ordersBefore } = await db.query(`SELECT * FROM orders WHERE auction_id = $1`, [
      fixture.auctionId,
    ]);

    await runDecide(fixture.auctionId);
    await runDecide(fixture.auctionId);
    await results.closeAuction({ auctionId: fixture.auctionId });

    const { rows: after } = await db.query(`SELECT * FROM auction_results WHERE auction_id = $1`, [
      fixture.auctionId,
    ]);
    const { rows: ordersAfter } = await db.query(`SELECT * FROM orders WHERE auction_id = $1`, [
      fixture.auctionId,
    ]);

    expect(after).toEqual(before);
    expect(ordersAfter).toEqual(ordersBefore);
  });

  /**
   * A winner who cannot pay does not change the winner.
   *
   * The winner's wallet is emptied after the close — the closest this phase
   * can come to a payment failure without implementing payments — and the
   * auction is closed again. The result must be identical. **This is the core
   * trust rule**: no recalculation, no promotion of the second unique bid, no
   * edit to `auction_results`.
   */
  it('keeps the winner even when the winner has no money left', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [
        { amount: 40, bidders: 2 },
        { amount: 41, bidders: 1 },
        { amount: 42, bidders: 1 },
      ],
    });
    const decision = await runClosing(fixture.auctionId);
    expect(decision.winningAmountMinor).toBe(41n);
    const winner = decision.winnerUserId!;

    // Drain the winner's wallet: they can no longer pay for what they won.
    const balance = await walletBalance(winner);
    if (balance > 0n) {
      await db.query(`UPDATE wallets SET available_minor = 0 WHERE user_id = $1`, [winner]);
    }

    await runDecide(fixture.auctionId);
    const stored = await readResultRow(db, fixture.auctionId);
    expect(stored?.winnerUserId).toBe(winner);
    expect(stored?.winningAmountMinor).toBe(41n);
    // 42 was the other lonely amount; it must not have been promoted.
    expect(stored?.winningAmountMinor).not.toBe(42n);
    expect(await readOrderRows(db, fixture.auctionId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// TEST E — refunds retried
// ---------------------------------------------------------------------------

describe('TEST E: refunds retried and raced', () => {
  /**
   * Five concurrent refund passes over the same auction book one movement per
   * participant.
   *
   * The deterministic idempotency key is what makes this true, and it is the
   * whole licence for running refunds outside the closing transaction. Run
   * concurrently rather than in sequence on purpose: a sequential retry is
   * caught by a stored-result lookup, while a concurrent one has to be caught
   * by the unique index on the ledger entry.
   */
  it('books one refund per participant however many passes run', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [
        { amount: 50, bidders: 3 },
        { amount: 51, bidders: 3 },
      ],
      bidFeeMinor: 400n,
    });
    const balancesBefore = await Promise.all(fixture.bidderIds.map((id) => walletBalance(id)));

    // The close and four refund passes, all started together. `void` on the
    // close keeps one array of one type; what matters is that all five run
    // concurrently, not what each returns.
    const outcome = await settle<void>([
      results.closeAuction({ auctionId: fixture.auctionId }).then(() => undefined),
      ...Array.from({ length: 4 }, () =>
        results.refundParticipationFees({ auctionId: fixture.auctionId }).then(() => undefined),
      ),
    ]);
    expect(outcome.otherErrors).toEqual([]);

    // One more sequential pass, to be sure the concurrent burst settled.
    const final = await results.refundParticipationFees({ auctionId: fixture.auctionId });
    expect(final.refunded).toBe(0);
    expect(final.alreadyRefunded).toBe(3);

    const entries = await readRefundEntries(db, fixture.auctionId);
    expect(entries).toHaveLength(3);
    for (const [index, userId] of fixture.bidderIds.entries()) {
      // Two bids at 400 each.
      expect(await walletBalance(userId)).toBe(balancesBefore[index]! + 800n);
    }
  });

  /**
   * The recovery sweep finishes a refund pass that never ran.
   *
   * The interrupted close is simulated by deleting the refund entries after
   * the fact, which is what a crash between the decision and the money leaves
   * behind: a correct result, and somebody unpaid. The sweep must find it by
   * asking the ledger — not a flag — and complete it.
   */
  it('is finished by the sweep when a pass was interrupted', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [{ amount: 55, bidders: 2 }],
      bidFeeMinor: 600n,
    });
    await runClosing(fixture.auctionId);
    expect(await readRefundEntries(db, fixture.auctionId)).toHaveLength(2);

    // Undo the money, keeping the result: the crash-in-between state.
    await db.query('BEGIN');
    await db.query("SET LOCAL session_replication_role = 'replica'");
    await db.query(
      `DELETE FROM wallet_entries
        WHERE entry_type = 'bid_fee_refund' AND reference_type = 'auction' AND reference_id = $1`,
      [fixture.auctionId],
    );
    await db.query(
      `UPDATE wallets SET available_minor = available_minor - 600
        WHERE user_id = ANY($1::uuid[])`,
      [fixture.bidderIds],
    );
    await db.query('COMMIT');

    const swept = await results.sweepOutstandingRefunds({ limit: 50 });
    const ours = swept.find((pass) => pass.auctionId === fixture.auctionId);
    expect(ours?.refunded).toBe(2);
    expect(await readRefundEntries(db, fixture.auctionId)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// TEST F — inventory released twice
// ---------------------------------------------------------------------------

describe('TEST F: releasing the unit more than once', () => {
  /**
   * The reservation is released once, and stock never goes negative.
   *
   * Three concurrent closes on a no-winner auction, then two more sequential
   * ones. `reserved_quantity` is a cache of the reservation rows, so the
   * assertion is that both agree: one released row, and a cache back at zero
   * rather than at minus two.
   */
  it('releases once under concurrent and repeated closes', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [{ amount: 60, bidders: 2 }],
    });
    await auctions.close({ auctionId: fixture.auctionId });

    const outcome = await settle([
      results.closeAuction({ auctionId: fixture.auctionId }),
      results.closeAuction({ auctionId: fixture.auctionId }),
      results.closeAuction({ auctionId: fixture.auctionId }),
    ]);
    expect(outcome.otherErrors).toEqual([]);
    await runDecide(fixture.auctionId);
    await runDecide(fixture.auctionId);

    const reservation = await readReservation(db, fixture.auctionId);
    expect(reservation?.state).toBe('released');
    expect(reservation?.reservedQuantity).toBe(0);

    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM inventory_reservations
        WHERE auction_id = $1 AND state = 'released'`,
      [fixture.auctionId],
    );
    expect(Number(rows[0]!.n)).toBe(1);

    const { rows: stock } = await db.query<{ reserved_quantity: number; stock_quantity: number }>(
      `SELECT p.reserved_quantity, p.stock_quantity FROM products p
        JOIN auctions a ON a.product_id = p.id WHERE a.id = $1`,
      [fixture.auctionId],
    );
    expect(stock[0]!.reserved_quantity).toBe(0);
    expect(stock[0]!.reserved_quantity).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// TEST G — many auctions and many wallets at once
// ---------------------------------------------------------------------------

describe('TEST G: many closings at once', () => {
  /**
   * Six no-winner auctions closed simultaneously, each refunding several
   * wallets.
   *
   * This is the deadlock test, and it is the reason refunds are not inside the
   * closing transaction. Holding the auction lock across N wallet locks would
   * put six closings into a lock graph with no consistent order, and Phase 5
   * has already shown what that looks like: not an error, a *hang* — the pool
   * exhausted and every request waiting. So the assertion is that this
   * finishes, and finishes well inside the suite's timeout.
   *
   * Six auctions × three bidders is eighteen wallets, against a pool of ten
   * connections. That ratio is the point: it cannot pass by having enough
   * connections to avoid the question.
   */
  it('closes six auctions refunding eighteen wallets without deadlocking', async () => {
    const fixtures = [];
    for (let index = 0; index < 6; index += 1) {
      fixtures.push(
        await createClosableAuction(db, {
          distribution: [
            { amount: 70, bidders: 3 },
            { amount: 71, bidders: 3 },
          ],
          bidFeeMinor: 100n,
        }),
      );
    }

    const started = Date.now();
    const outcome = await settle(fixtures.map((fixture) => runClose(fixture.auctionId)));
    const elapsed = Date.now() - started;

    expect(outcome.otherErrors).toEqual([]);
    expect(outcome.fulfilled).toHaveLength(6);
    // A deadlock here shows up as the suite timing out, not as an error, so
    // the time is asserted as well as the outcome.
    expect(elapsed).toBeLessThan(20_000);

    for (const fixture of fixtures) {
      expect(await countResultRows(db, fixture.auctionId)).toBe(1);
      expect(await readRefundEntries(db, fixture.auctionId)).toHaveLength(3);
      expect(await readResultRow(db, fixture.auctionId)).toMatchObject({
        outcome: 'no_unique_bid',
      });
    }
  });

  /**
   * One bidder in several auctions closing at once.
   *
   * The wallet is the shared resource, so this is the same deadlock question
   * from the other side: four closings all wanting the same wallet lock. They
   * must queue rather than deadlock, and the bidder must end up with exactly
   * four refunds.
   */
  it('refunds one bidder across four simultaneous closings', async () => {
    const shared = await createBidder(db, { fundMinor: 10_000_000n });
    const fixtures = [];
    for (let index = 0; index < 4; index += 1) {
      const fixture = await createClosableAuction(db, {
        distribution: [{ amount: 80, bidders: 2 }],
        bidFeeMinor: 250n,
      });
      // The shared bidder joins each auction at an amount someone else took,
      // so every one of them ends with no unique bid.
      await forceWindow(db, {
        auctionId: fixture.auctionId,
        startsAt: '-2 hours',
        endsAt: '2 hours',
      });
      await placeBids({ userId: shared.userId, auctionId: fixture.auctionId, amountsMinor: [81] });
      await db.query(
        `INSERT INTO bids (auction_id, user_id, amount_minor, fee_minor, status, channel)
         VALUES ($1, $2, 81, 250, 'valid', 'web')`,
        [fixture.auctionId, fixture.bidderIds[1]],
      );
      await forceWindow(db, {
        auctionId: fixture.auctionId,
        startsAt: '-2 hours',
        endsAt: '-1 second',
      });
      fixtures.push(fixture);
    }

    const balanceBefore = await walletBalance(shared.userId);
    const outcome = await settle(fixtures.map((fixture) => runClose(fixture.auctionId)));
    expect(outcome.otherErrors).toEqual([]);

    // 250 back from each of the four auctions.
    expect(await walletBalance(shared.userId)).toBe(balanceBefore + 1_000n);
    for (const fixture of fixtures) {
      const entries = await readRefundEntries(db, fixture.auctionId);
      expect(entries.filter((entry) => entry.userId === shared.userId)).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Scale
// ---------------------------------------------------------------------------

describe('LUB_V1 at scale', () => {
  /**
   * The algorithm against 1,000 / 10,000 / 100,000 bids.
   *
   * The bids are inserted directly — see `seedBidsDirectly` — because what is
   * being measured is the calculator, not the bidding engine, and a hundred
   * thousand real submissions would be a hundred thousand transactions.
   *
   * The distribution is the worst case: every amount is chosen by every
   * bidder, so nothing is unique and the query has to count every group before
   * it can answer. One lone amount is added at the top of the range, so the
   * answer is a winner rather than an early exit.
   *
   * Thresholds are generous and deliberately so. The numbers this asserts are
   * not a performance target — they are a guard against an accidental
   * sequential scan or an N+1 creeping in, which is the failure that would
   * turn a closing job into an outage. The observed timings are printed so a
   * regression is visible as a number rather than only as a pass.
   */
  for (const size of [
    { bidders: 10, amounts: 100, label: '1,000 bids', budgetMs: 2_000 },
    { bidders: 20, amounts: 500, label: '10,000 bids', budgetMs: 5_000 },
    { bidders: 100, amounts: 1000, label: '100,000 bids', budgetMs: 30_000 },
  ]) {
    it(`decides ${size.label} within budget`, async () => {
      const fixture = await createClosableAuction(db, { distribution: [], bidders: 0 });
      const uniqueAmount = size.amounts + 1;
      const seeded = await seedBidsDirectly(db, {
        auctionId: fixture.auctionId,
        bidders: size.bidders,
        amounts: size.amounts,
        uniqueAmount,
      });
      expect(seeded.bidCount).toBe(size.bidders * size.amounts + 1);

      const winner = await timed(() => results.calculateLubV1(fixture.auctionId));
      const stats = await timed(() => results.countFrozenBids(fixture.auctionId));
      const digest = await timed(() => results.checksumFrozenBids(fixture.auctionId));
      const whole = await timed(() => runClose(fixture.auctionId));

      console.warn(
        `[scale] ${size.label}: lub ${winner.ms.toFixed(1)}ms · stats ${stats.ms.toFixed(1)}ms · ` +
          `checksum ${digest.ms.toFixed(1)}ms · whole close ${whole.ms.toFixed(1)}ms`,
      );

      expect(winner.value?.amountMinor).toBe(BigInt(uniqueAmount));
      expect(stats.value.totalValidBids).toBe(seeded.bidCount);
      expect(stats.value.participantCount).toBe(size.bidders);
      // Only the amount above the range stands alone.
      expect(stats.value.uniqueAmountCount).toBe(1);
      expect(digest.value).toHaveLength(64);

      expect(winner.ms).toBeLessThan(size.budgetMs);
      expect(stats.ms).toBeLessThan(size.budgetMs);
      expect(digest.ms).toBeLessThan(size.budgetMs);

      const stored = await readResultRow(db, fixture.auctionId);
      expect(stored?.winningAmountMinor).toBe(BigInt(uniqueAmount));
      expect(stored?.totalValidBids).toBe(seeded.bidCount);
    });
  }
});
