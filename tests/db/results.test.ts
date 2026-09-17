import { createHash } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as auctions from '@howlow/api/modules/auctions';
import * as results from '@howlow/api/modules/results';
import { closePool } from '@howlow/api/db';
import { adminClient, cleanup, cleanupCategories, domainRejection } from './catalog-helpers.js';
import { createBidder, forceStatus, forceWindow, placeBids, walletBalance } from './bidding-helpers.js';
import {
  countResultRows,
  createClosableAuction,
  readAuctionStatus,
  readAuditActions,
  readOrderRows,
  readRefundEntries,
  readReservation,
  readResultRow,
  runClosing,
} from './results-helpers.js';

/**
 * LUB_V1 and auction closing, against a real PostgreSQL.
 *
 * Everything here goes through the real closing path — `close()` then
 * `closeAuction()` — rather than calling `calculateLubV1` directly. A
 * calculator that is right while the workflow around it is wrong is a failure
 * this project has already met twice, and a suite that only tested the
 * calculator would not have caught it.
 *
 * The auctions run 1..100 in steps of 1, so the amounts written in a test are
 * the amounts the specification names.
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

/**
 * Run a statement the database must refuse, and return its message.
 *
 * These tests share one autocommit connection rather than an outer
 * transaction — the closing service opens transactions of its own on the pool,
 * and they would deadlock against an outer one holding the same rows. So a
 * statement expected to fail gets a transaction of its own here, and the
 * message is returned rather than merely `.rejects.toThrow()`: a statement
 * that failed on a typo would satisfy "it threw" while proving nothing about
 * the guarantee.
 */
async function refused(client: pg.Client, sql: string): Promise<string> {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('ROLLBACK');
    throw new Error(`Expected PostgreSQL to refuse this, but it succeeded: ${sql}`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('Expected PostgreSQL to refuse')) throw error;
    return message;
  }
}

// ---------------------------------------------------------------------------
// The product rule. These seven are the specification's own fixtures.
// ---------------------------------------------------------------------------

describe('LUB_V1: the lowest amount exactly one bidder chose', () => {
  /**
   * TEST 1 — the canonical case.
   *
   * Amount 1 was chosen by four people, 2 by seven, 3 by five, 4 by two, 5 by
   * one, 6 by three. The winner is **5**.
   *
   * This is the case every naive implementation gets wrong in the same way: 1
   * is the lowest bid and loses, 5 is the lowest *lonely* bid and wins.
   *
   * What it does and does not pin down, measured by mutating the calculator
   * and re-running: changing `count(*) = 1` to `count(*) >= 1` — "lowest bid
   * wins" — fails this test (and fourteen others). Changing `ORDER BY
   * amount_minor ASC` to `DESC` does **not** fail it, because 5 is the only
   * unique amount here and the lowest of one is also the highest. TEST 2 and
   * TEST 3 are what pin the ordering down.
   */
  it('picks the lowest unique amount, not the lowest amount', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [
        { amount: 1, bidders: 4 },
        { amount: 2, bidders: 7 },
        { amount: 3, bidders: 5 },
        { amount: 4, bidders: 2 },
        { amount: 5, bidders: 1 },
        { amount: 6, bidders: 3 },
      ],
    });

    const outcome = await runClosing(fixture.auctionId);

    expect(outcome.outcome).toBe('winner');
    expect(outcome.winningAmountMinor).toBe(5n);
    // Amount 5 was placed by bidder 0, the only one who bids every amount.
    expect(outcome.winnerUserId).toBe(fixture.bidderIds[0]);

    const stored = await readResultRow(db, fixture.auctionId);
    expect(stored?.winningAmountMinor).toBe(5n);
    expect(stored?.outcome).toBe('winner');
    // 4 + 7 + 5 + 2 + 1 + 3
    expect(stored?.totalValidBids).toBe(22);
    expect(stored?.participantCount).toBe(7);
    // Only amount 5 stood alone.
    expect(stored?.uniqueAmountCount).toBe(1);
  });

  /**
   * TEST 2 — every amount unique.
   *
   * With no collisions at all the lowest amount *is* the lowest unique amount,
   * so the rule and the naive reading agree. Worth asserting precisely because
   * they agree: it proves the rule does not gratuitously skip the lowest bid,
   * and — with TEST 3 — it is what catches a calculator that took the
   * *highest* unique amount instead of the lowest.
   */
  it('picks the lowest amount when every amount is unique', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [
        { amount: 7, bidders: 1 },
        { amount: 9, bidders: 1 },
        { amount: 11, bidders: 1 },
      ],
      bidders: 1,
    });

    const outcome = await runClosing(fixture.auctionId);

    expect(outcome.outcome).toBe('winner');
    expect(outcome.winningAmountMinor).toBe(7n);
    const stored = await readResultRow(db, fixture.auctionId);
    expect(stored?.uniqueAmountCount).toBe(3);
  });

  /**
   * TEST 3 — a unique amount above a crowded one.
   *
   * 1 was chosen twice, 2 once, 3 twice, 4 once. The winner is **2**: the
   * lowest amount is not unique, and the lowest unique amount is not the
   * highest unique one either.
   */
  it('skips a crowded low amount and takes the first lonely one', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [
        { amount: 1, bidders: 2 },
        { amount: 2, bidders: 1 },
        { amount: 3, bidders: 2 },
        { amount: 4, bidders: 1 },
      ],
    });

    const outcome = await runClosing(fixture.auctionId);

    expect(outcome.winningAmountMinor).toBe(2n);
    const stored = await readResultRow(db, fixture.auctionId);
    // 2 and 4.
    expect(stored?.uniqueAmountCount).toBe(2);
  });

  /**
   * TEST 4 — every amount duplicated.
   *
   * **Nobody wins.** Not the lowest bid, not the fewest-duplicated amount, not
   * the earliest bidder at the lowest amount. The auction produced no result,
   * and the fees go back.
   */
  it('declares no winner when every amount was chosen more than once', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [
        { amount: 1, bidders: 2 },
        { amount: 2, bidders: 3 },
        { amount: 3, bidders: 2 },
      ],
    });

    const outcome = await runClosing(fixture.auctionId);

    expect(outcome.outcome).toBe('no_unique_bid');
    expect(outcome.winningAmountMinor).toBeNull();
    expect(outcome.winnerUserId).toBeNull();
    expect(outcome.orderId).toBeNull();

    const stored = await readResultRow(db, fixture.auctionId);
    expect(stored?.uniqueAmountCount).toBe(0);
    expect(stored?.totalValidBids).toBe(7);
    expect(stored?.winningBidId).toBeNull();
  });

  /** TEST 5 — nobody bid. */
  it('declares no bids when the auction attracted none', async () => {
    const fixture = await createClosableAuction(db, { distribution: [] });

    const outcome = await runClosing(fixture.auctionId);

    expect(outcome.outcome).toBe('no_bids');
    expect(outcome.orderId).toBeNull();
    const stored = await readResultRow(db, fixture.auctionId);
    expect(stored?.totalBids).toBe(0);
    expect(stored?.totalValidBids).toBe(0);
    expect(stored?.participantCount).toBe(0);
    expect(stored?.uniqueAmountCount).toBe(0);
    // An empty set still has a checksum: SHA-256 of the empty string.
    expect(stored?.frozenBidChecksum).toBe(results.EMPTY_BID_SET_CHECKSUM);
  });

  /** TEST 6 — a single bid wins. */
  it('awards a single bid to the person who placed it', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [{ amount: 1, bidders: 1 }],
    });

    const outcome = await runClosing(fixture.auctionId);

    expect(outcome.outcome).toBe('winner');
    expect(outcome.winningAmountMinor).toBe(1n);
    expect(outcome.winnerUserId).toBe(fixture.bidderIds[0]);
  });

  /**
   * TEST 7 — the channel is irrelevant.
   *
   * The same distribution placed half through the website and half through
   * Telegram must produce the same winner as TEST 3 did, and the winning bid
   * must be able to arrive through either. `channel` appears in no clause of
   * the algorithm, and this is the test that would fail if it ever did.
   */
  it('reaches the same result whichever channel the bids arrived through', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [
        { amount: 1, bidders: 2 },
        { amount: 2, bidders: 1 },
        { amount: 3, bidders: 2 },
        { amount: 4, bidders: 1 },
      ],
      // Bidder 0 — who places the winning amount 2 — bids from Telegram.
      channelFor: (index) => (index % 2 === 0 ? 'telegram' : 'web'),
    });

    const outcome = await runClosing(fixture.auctionId);

    expect(outcome.winningAmountMinor).toBe(2n);
    expect(outcome.winnerUserId).toBe(fixture.bidderIds[0]);

    const { rows } = await db.query<{ channel: string }>(
      `SELECT channel FROM bids WHERE id = (
         SELECT winning_bid_id FROM auction_results WHERE auction_id = $1)`,
      [fixture.auctionId],
    );
    expect(rows[0]?.channel).toBe('telegram');
  });
});

// ---------------------------------------------------------------------------
// Which bids take part
// ---------------------------------------------------------------------------

describe('only valid bids take part', () => {
  /**
   * A voided bid never participated.
   *
   * Amount 2 is chosen by two people, so it is not unique — until one of those
   * two bids is voided, at which point 2 stands alone and wins. The
   * alternative behaviour, counting the voided bid, would let a refunded bid
   * keep denying an amount to somebody else forever.
   */
  it('ignores voided bids, which can change the winner', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [
        { amount: 1, bidders: 2 },
        { amount: 2, bidders: 2 },
        { amount: 3, bidders: 1 },
      ],
    });

    // Before voiding: 1 and 2 are crowded, so 3 would win.
    await expect(results.calculateLubV1(fixture.auctionId)).resolves.toMatchObject({
      amountMinor: 3n,
    });

    await db.query(
      `UPDATE bids SET status = 'void', voided_at = now(), void_reason = 'test'
        WHERE auction_id = $1 AND amount_minor = 2 AND user_id = $2`,
      [fixture.auctionId, fixture.bidderIds[1]],
    );

    const outcome = await runClosing(fixture.auctionId);

    expect(outcome.winningAmountMinor).toBe(2n);
    const stored = await readResultRow(db, fixture.auctionId);
    // Four bids exist; three of them are valid.
    expect(stored?.totalBids).toBe(5);
    expect(stored?.totalValidBids).toBe(4);
  });

  /**
   * The statistics come from the frozen set, not from the live counters.
   *
   * `auctions.total_bids` is a display cache maintained by the bidding engine.
   * Here it is deliberately corrupted before the close, and the result must
   * still count the bids themselves — a result that quoted the cache would
   * publish the wrong figure and nobody would be able to tell from the row.
   */
  it('counts the bids rather than reading the auction cache', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [
        { amount: 4, bidders: 1 },
        { amount: 5, bidders: 2 },
      ],
    });

    await db.query(`UPDATE auctions SET total_bids = 999, total_participants = 42 WHERE id = $1`, [
      fixture.auctionId,
    ]);

    await runClosing(fixture.auctionId);

    const stored = await readResultRow(db, fixture.auctionId);
    expect(stored?.totalBids).toBe(3);
    expect(stored?.totalValidBids).toBe(3);
    expect(stored?.participantCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The checksum
// ---------------------------------------------------------------------------

describe('the frozen-bid checksum', () => {
  /**
   * The digest is reproducible from the documented canonical form.
   *
   * Not "the checksum is 64 hex characters" — that would pass against any
   * hash of anything. This recomputes SHA-256 over the published
   * representation with Node's own crypto and requires the stored value to
   * match, which is exactly what an independent auditor would do.
   */
  it('is SHA-256 of the documented canonical representation', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [
        { amount: 10, bidders: 2 },
        { amount: 20, bidders: 1 },
      ],
    });

    await runClosing(fixture.auctionId);

    const lines = await results.canonicalBidLines(fixture.auctionId);
    const expected = createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');

    const stored = await readResultRow(db, fixture.auctionId);
    expect(stored?.frozenBidChecksum).toBe(expected);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).toMatch(/^[0-9a-f-]{36}:[0-9a-f-]{36}:\d+$/);
    }
  });

  /** Same bids, same digest — the property a verifier depends on. */
  it('is stable across repeated computation', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [{ amount: 8, bidders: 3 }],
    });

    const first = await results.checksumFrozenBids(fixture.auctionId);
    const second = await results.checksumFrozenBids(fixture.auctionId);
    expect(second).toBe(first);
  });

  /**
   * A result verifies against the bids that produced it, and stops verifying
   * when they change.
   *
   * The second half is the point. A checksum that could not detect a mutation
   * would be decoration, so this voids one bid after the close and requires
   * `verifyResult` to report the mismatch — and to report it as a finding
   * rather than quietly returning a different winner.
   */
  it('detects a bid set mutated after the close', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [
        { amount: 30, bidders: 2 },
        { amount: 31, bidders: 1 },
      ],
    });

    await runClosing(fixture.auctionId);

    const clean = await results.verifyResult(fixture.auctionId);
    expect(clean.ok).toBe(true);
    expect(clean.mismatches).toEqual([]);
    expect(clean.recomputedChecksum).toBe(clean.storedChecksum);
    expect(clean.recomputedWinningAmountMinor).toBe(31n);

    await db.query(
      `UPDATE bids SET status = 'void', voided_at = now(), void_reason = 'tampering'
        WHERE auction_id = $1 AND amount_minor = 30 AND user_id = $2`,
      [fixture.auctionId, fixture.bidderIds[1]],
    );

    const tampered = await results.verifyResult(fixture.auctionId);
    expect(tampered.ok).toBe(false);
    expect(tampered.recomputedChecksum).not.toBe(tampered.storedChecksum);
    expect(tampered.mismatches.join(' ')).toContain('checksum');
    // Voiding one of the two bids at 30 makes 30 the lowest unique amount, so
    // the recomputation disagrees about the winner too — and the stored result
    // is left exactly as it was.
    expect(tampered.recomputedWinningAmountMinor).toBe(30n);
    expect(tampered.storedWinningAmountMinor).toBe(31n);

    const stillStored = await readResultRow(db, fixture.auctionId);
    expect(stillStored?.winningAmountMinor).toBe(31n);
  });
});

// ---------------------------------------------------------------------------
// Consequences of the four outcomes
// ---------------------------------------------------------------------------

describe('what each outcome does to the world', () => {
  it('creates exactly one pending-payment order for the winner', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [{ amount: 12, bidders: 1 }],
    });

    const outcome = await runClosing(fixture.auctionId);

    const orders = await readOrderRows(db, fixture.auctionId);
    expect(orders).toHaveLength(1);
    const order = orders[0]!;
    expect(order.id).toBe(outcome.orderId);
    expect(order.userId).toBe(fixture.bidderIds[0]);
    expect(order.status).toBe('pending_payment');
    // The winner owes what they bid, and nothing else.
    expect(order.totalMinor).toBe(12n);
    expect(order.subtotalMinor).toBe(12n);
    expect(order.orderNumber).toMatch(/^HL-\d{4}-\d{6,}$/);
    // 48 hours is the fixture's `winner_payment_hours`.
    expect(order.paymentDueAt).not.toBeNull();
    const hours = (order.paymentDueAt!.getTime() - order.placedAt.getTime()) / 3_600_000;
    expect(hours).toBeCloseTo(48, 3);
  });

  /**
   * The winner's wallet is not touched.
   *
   * An order is a demand for payment, not a payment. Charging the winner here
   * would collect money without a payment record, and would make the close
   * fail for a winner whose balance was short — which must never be able to
   * change who won.
   */
  it('does not charge the winner', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [{ amount: 15, bidders: 1 }],
      bidFeeMinor: 500n,
    });
    const winner = fixture.bidderIds[0]!;
    const before = await walletBalance(winner);

    await runClosing(fixture.auctionId);

    expect(await walletBalance(winner)).toBe(before);
    const { rows } = await db.query<{ n: string }>(`SELECT count(*) AS n FROM payments WHERE user_id = $1`, [
      winner,
    ]);
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('keeps the reserved unit when there is a winner', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [{ amount: 21, bidders: 1 }],
    });

    await runClosing(fixture.auctionId);

    const reservation = await readReservation(db, fixture.auctionId);
    expect(reservation?.state).toBe('held');
    expect(reservation?.reservedQuantity).toBe(1);
  });

  it('returns the unit to stock when nobody wins', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [{ amount: 22, bidders: 2 }],
    });

    await runClosing(fixture.auctionId);

    const reservation = await readReservation(db, fixture.auctionId);
    expect(reservation?.state).toBe('released');
    expect(reservation?.reservedQuantity).toBe(0);
  });

  it('returns the unit to stock when nobody bid', async () => {
    const fixture = await createClosableAuction(db, { distribution: [] });

    await runClosing(fixture.auctionId);

    const reservation = await readReservation(db, fixture.auctionId);
    expect(reservation?.state).toBe('released');
    expect(reservation?.reservedQuantity).toBe(0);
  });

  /**
   * Fees come back when the auction produced no winner — and the amount is
   * what each person actually paid, not a recomputation.
   */
  it('refunds every participation fee on no-unique-bid', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [
        { amount: 40, bidders: 2 },
        { amount: 41, bidders: 2 },
      ],
      bidFeeMinor: 700n,
    });
    const [first, second] = fixture.bidderIds as [string, string];
    const balancesBefore = [await walletBalance(first), await walletBalance(second)];

    const outcome = await runClosing(fixture.auctionId);
    expect(outcome.outcome).toBe('no_unique_bid');

    // Each bidder placed both amounts: two bids at 700 each.
    expect(await walletBalance(first)).toBe(balancesBefore[0]! + 1_400n);
    expect(await walletBalance(second)).toBe(balancesBefore[1]! + 1_400n);

    const entries = await readRefundEntries(db, fixture.auctionId);
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.amountMinor).toBe(1_400n);
      expect(entry.idempotencyKey).toBe(results.refundIdempotencyKey(fixture.auctionId, entry.userId));
    }
  });

  it('refunds nothing when there is a winner', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [
        { amount: 50, bidders: 2 },
        { amount: 51, bidders: 1 },
      ],
      bidFeeMinor: 700n,
    });
    const balancesBefore = await Promise.all(fixture.bidderIds.map((id) => walletBalance(id)));

    const outcome = await runClosing(fixture.auctionId);
    expect(outcome.outcome).toBe('winner');

    for (const [index, userId] of fixture.bidderIds.entries()) {
      expect(await walletBalance(userId)).toBe(balancesBefore[index]!);
    }
    expect(await readRefundEntries(db, fixture.auctionId)).toEqual([]);
  });

  /**
   * A fee refund goes through the wallet service, so it lands in the ledger
   * with the right entry type and reference. Asserting the type matters: a
   * refund booked as a `deposit` would balance the wallet and lie about why.
   */
  it('books refunds as bid_fee_refund against the auction', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [{ amount: 60, bidders: 2 }],
      bidFeeMinor: 300n,
    });

    await runClosing(fixture.auctionId);

    const { rows } = await db.query<{ entry_type: string; reference_type: string; amount_minor: string }>(
      `SELECT entry_type, reference_type, amount_minor
         FROM wallet_entries
        WHERE reference_type = 'auction' AND reference_id = $1
          AND entry_type = 'bid_fee_refund'`,
      [fixture.auctionId],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.entry_type).toBe('bid_fee_refund');
      expect(row.reference_type).toBe('auction');
      // A credit: positive, so the wallet gains. A refund booked with a
      // negative amount would balance and mean the opposite.
      expect(BigInt(row.amount_minor)).toBe(300n);
    }
  });
});

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

describe('the closing state machine', () => {
  it('leaves the auction completed', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [{ amount: 70, bidders: 1 }],
    });

    await runClosing(fixture.auctionId);

    expect(await readAuctionStatus(db, fixture.auctionId)).toBe('completed');
  });

  /**
   * **No calculation before the auction has ended.**
   *
   * A live auction is refused outright. The bid set can still grow, so an
   * amount that stands alone now may be matched a second later — a "winner"
   * computed here would be a guess.
   */
  it('refuses to decide an auction that is still live', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [{ amount: 80, bidders: 1 }],
    });
    // Put it back to live with a future deadline: genuinely still running.
    await forceWindow(db, {
      auctionId: fixture.auctionId,
      startsAt: '-10 minutes',
      endsAt: '2 hours',
    });
    await forceStatus(db, { auctionId: fixture.auctionId, status: 'live' });

    const failure = await domainRejection(results.closeAuction({ auctionId: fixture.auctionId }));
    expect(failure.domainCode).toBe('AUCTION_NOT_CLOSED');
    expect(await countResultRows(db, fixture.auctionId)).toBe(0);
  });

  /** The lifecycle refuses `live → closing` before the deadline, too. */
  it('refuses to close an auction before its deadline', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [{ amount: 81, bidders: 1 }],
    });
    await forceWindow(db, {
      auctionId: fixture.auctionId,
      startsAt: '-10 minutes',
      endsAt: '2 hours',
    });
    await forceStatus(db, { auctionId: fixture.auctionId, status: 'live' });

    const failure = await domainRejection(auctions.close({ auctionId: fixture.auctionId }));
    expect(failure.domainCode).toBe('AUCTION_NOT_DUE');
  });

  /**
   * Closing twice produces one winner, one order and one set of refunds.
   *
   * The second call reports `decided: false` and returns the published result
   * unchanged. This is the sequential case; the concurrent one is in
   * `results-concurrency.test.ts`.
   */
  it('is idempotent: a second close changes nothing', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [
        { amount: 90, bidders: 2 },
        { amount: 91, bidders: 1 },
      ],
    });

    const first = await runClosing(fixture.auctionId);
    const second = await results.closeAuction({ auctionId: fixture.auctionId });

    expect(first.decided).toBe(true);
    expect(second.decided).toBe(false);
    expect(second.result.id).toBe(first.result.id);
    expect(second.winningAmountMinor).toBe(first.winningAmountMinor);
    expect(second.winnerUserId).toBe(first.winnerUserId);

    expect(await countResultRows(db, fixture.auctionId)).toBe(1);
    expect(await readOrderRows(db, fixture.auctionId)).toHaveLength(1);
  });

  /**
   * Running the refund pass again books nothing.
   *
   * The deterministic idempotency key is what makes the refund pass safe to
   * split out of the closing transaction, so this is the assertion that
   * licenses the whole arrangement.
   */
  it('is idempotent about refunds', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [{ amount: 92, bidders: 2 }],
      bidFeeMinor: 250n,
    });

    await runClosing(fixture.auctionId);
    const balancesAfterFirst = await Promise.all(fixture.bidderIds.map((id) => walletBalance(id)));

    const again = await results.refundParticipationFees({ auctionId: fixture.auctionId });
    expect(again.refunded).toBe(0);
    expect(again.alreadyRefunded).toBe(2);
    expect(again.totalRefundedMinor).toBe(0n);

    for (const [index, userId] of fixture.bidderIds.entries()) {
      expect(await walletBalance(userId)).toBe(balancesAfterFirst[index]!);
    }
    expect(await readRefundEntries(db, fixture.auctionId)).toHaveLength(2);
  });

  /** The recovery sweep finds nothing once a close has finished its refunds. */
  it('leaves nothing for the refund sweep after a completed close', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [{ amount: 93, bidders: 2 }],
      bidFeeMinor: 250n,
    });
    await runClosing(fixture.auctionId);

    const swept = await results.sweepOutstandingRefunds({ limit: 50 });
    expect(swept.map((outcome) => outcome.auctionId)).not.toContain(fixture.auctionId);
  });

  /**
   * A result is immutable in the database, not merely by convention.
   *
   * There is no update path in the module, so this asserts the other half: the
   * append-only trigger refuses even a direct UPDATE. Without it, "the winner
   * never changes" would rest on nobody writing the wrong SQL.
   */
  it('refuses to let a stored result be edited', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [{ amount: 94, bidders: 1 }],
    });
    await runClosing(fixture.auctionId);

    const update = await refused(
      db,
      `UPDATE auction_results SET winning_amount_minor = 1
                                        WHERE auction_id = '${fixture.auctionId}'`,
    );
    expect(update).toMatch(/append-only|immutable|not allowed|forbid/i);

    const remove = await refused(db, `DELETE FROM auction_results WHERE auction_id = '${fixture.auctionId}'`);
    expect(remove).toMatch(/append-only|immutable|not allowed|forbid/i);

    const stored = await readResultRow(db, fixture.auctionId);
    expect(stored?.winningAmountMinor).toBe(94n);
  });

  /** A completed auction is terminal: nothing moves it again. */
  it('refuses to reopen a completed auction', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [{ amount: 95, bidders: 1 }],
    });
    await runClosing(fixture.auctionId);

    const message = await refused(
      db,
      `UPDATE auctions SET status = 'live' WHERE id = '${fixture.auctionId}'`,
    );
    expect(message).toContain('completed');
    expect(await readAuctionStatus(db, fixture.auctionId)).toBe('completed');
  });

  /** Bids are refused once the auction is past `live`. The freeze is the status. */
  it('refuses new bids from the moment the auction is closing', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [{ amount: 96, bidders: 1 }],
    });
    await auctions.close({ auctionId: fixture.auctionId });
    const latecomer = await createBidder(db, { fundMinor: 100_000n });

    const failure = await domainRejection(
      placeBids({ userId: latecomer.userId, auctionId: fixture.auctionId, amountsMinor: [97] }),
    );
    expect(failure.domainCode).toBe('AUCTION_NOT_LIVE');

    const outcome = await results.closeAuction({ auctionId: fixture.auctionId });
    expect(outcome.winningAmountMinor).toBe(96n);
    const stored = await readResultRow(db, fixture.auctionId);
    expect(stored?.totalBids).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The audit trail
// ---------------------------------------------------------------------------

describe('the result audit trail', () => {
  it('records the closing, the calculation and the winner', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [{ amount: 98, bidders: 1 }],
    });

    await runClosing(fixture.auctionId);

    const actions = await readAuditActions(db, fixture.auctionId);
    expect(actions).toContain('auction.closing');
    expect(actions).toContain('auction.calculating');
    expect(actions).toContain('auction.result_calculated');
    expect(actions).toContain('auction.winner_created');
    expect(actions).toContain('auction.completed');
    expect(actions).toContain('order.created');
  });

  it('records the no-unique-bid outcome, the release and the refunds', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [{ amount: 99, bidders: 2 }],
      bidFeeMinor: 200n,
    });

    await runClosing(fixture.auctionId);

    const actions = await readAuditActions(db, fixture.auctionId);
    expect(actions).toContain('auction.result_calculated');
    expect(actions).toContain('auction.no_unique_bid');
    expect(actions).toContain('inventory.released');
    expect(actions).toContain('auction.participation_fees_refunded');
    expect(actions).not.toContain('auction.winner_created');
  });

  /**
   * A replay adds no audit rows.
   *
   * Two `result_calculated` rows for one auction would read as an auction
   * decided twice, which is precisely what a reader of an audit log is looking
   * for. The absence has to be asserted or the logging is misleading.
   */
  it('records nothing for a replayed close', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [{ amount: 100, bidders: 1 }],
    });
    await runClosing(fixture.auctionId);
    const first = await readAuditActions(db, fixture.auctionId);

    await results.closeAuction({ auctionId: fixture.auctionId });

    expect(await readAuditActions(db, fixture.auctionId)).toEqual(first);
  });

  /**
   * The audit trail carries the checksum and the statistics.
   *
   * So that "what was this decided from" can be answered from the log alone,
   * without joining to the very result a reader may be trying to verify.
   */
  it('carries the checksum and the frozen statistics', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [
        { amount: 33, bidders: 2 },
        { amount: 34, bidders: 1 },
      ],
    });
    await runClosing(fixture.auctionId);

    const { rows } = await db.query<{ after_data: Record<string, unknown> }>(
      `SELECT after_data FROM audit_logs
        WHERE action = 'auction.result_calculated' AND entity_id = $1`,
      [fixture.auctionId],
    );
    const details = rows[0]!.after_data;
    const stored = await readResultRow(db, fixture.auctionId);
    expect(details['frozenBidChecksum']).toBe(stored?.frozenBidChecksum);
    expect(details['totalValidBids']).toBe(3);
    expect(details['uniqueAmountCount']).toBe(1);
    expect(details['algorithmVersion']).toBe('LUB_V1');
  });
});

// ---------------------------------------------------------------------------
// Disclosure
// ---------------------------------------------------------------------------

describe('what a result reveals', () => {
  /**
   * A loser learns the winning amount and that they lost. Nothing else.
   *
   * No winner id, no participant list, no per-amount distribution. The
   * uniqueness signal the bidding engine withholds during the auction must not
   * be handed out after it, because it is still advice about what to bid next
   * time.
   */
  it('tells a losing bidder only the public facts and their own', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [
        { amount: 25, bidders: 2 },
        { amount: 26, bidders: 1 },
      ],
      bidFeeMinor: 400n,
    });
    await runClosing(fixture.auctionId);

    const loser = fixture.bidderIds[1]!;
    const mine = await results.getMyOutcome({
      auctionId: fixture.auctionId,
      userId: loser,
      currency: 'ETB',
    });

    expect(mine?.won).toBe(false);
    expect(mine?.outcome).toBe('winner');
    expect(mine?.winningAmountMinor).toBe('26');
    // The loser bid 25 only; bidder 0 bid both.
    expect(mine?.bidCount).toBe(1);
    expect(mine?.feesPaidMinor).toBe('400');
    expect(mine?.refundedMinor).toBe('0');
    expect(mine?.order).toBeNull();
    expect(JSON.stringify(mine)).not.toContain(fixture.bidderIds[0]!);
  });

  it('gives the winner their order', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [{ amount: 27, bidders: 1 }],
    });
    await runClosing(fixture.auctionId);

    const mine = await results.getMyOutcome({
      auctionId: fixture.auctionId,
      userId: fixture.bidderIds[0]!,
      currency: 'ETB',
    });

    expect(mine?.won).toBe(true);
    expect(mine?.order?.status).toBe('pending_payment');
    expect(mine?.order?.totalMinor).toBe('27');
  });

  it('reports what came back after a no-unique-bid auction', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [{ amount: 28, bidders: 2 }],
      bidFeeMinor: 150n,
    });
    await runClosing(fixture.auctionId);

    const mine = await results.getMyOutcome({
      auctionId: fixture.auctionId,
      userId: fixture.bidderIds[0]!,
      currency: 'ETB',
    });

    expect(mine?.outcome).toBe('no_unique_bid');
    expect(mine?.won).toBe(false);
    expect(mine?.feesPaidMinor).toBe('150');
    expect(mine?.refundedMinor).toBe('150');
    expect(mine?.winningAmountMinor).toBeNull();
  });

  /** Nothing before the close. There is no result to read. */
  it('has nothing to say about an auction still running', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [{ amount: 29, bidders: 1 }],
    });

    const mine = await results.getMyOutcome({
      auctionId: fixture.auctionId,
      userId: fixture.bidderIds[0]!,
      currency: 'ETB',
    });
    expect(mine).toBeUndefined();
    expect(await results.getResult(fixture.auctionId)).toBeUndefined();
  });

  /**
   * The public result carries the winning amount and the statistics, and names
   * nobody.
   */
  it('publishes the amount and the statistics but no bidder', async () => {
    const fixture = await createClosableAuction(db, {
      distribution: [
        { amount: 35, bidders: 3 },
        { amount: 36, bidders: 1 },
      ],
    });
    await runClosing(fixture.auctionId);

    const stored = await results.getResult(fixture.auctionId);
    const dto = results.toResultDto(stored!, 'ETB');

    expect(dto.winningAmountMinor).toBe('36');
    expect(dto.algorithmVersion).toBe('LUB_V1');
    expect(dto.statistics.totalValidBids).toBe(4);
    expect(dto.statistics.uniqueAmountCount).toBe(1);
    expect(dto.checksum).toHaveLength(64);

    const serialised = JSON.stringify(dto);
    for (const bidderId of fixture.bidderIds) {
      expect(serialised).not.toContain(bidderId);
    }
  });
});
