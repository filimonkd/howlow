import type pg from 'pg';
import * as auctions from '@howlow/api/modules/auctions';
import * as results from '@howlow/api/modules/results';
import { createBidder, createLiveAuction, forceWindow, placeBids } from './bidding-helpers.js';

/**
 * Fixtures for the closing suites.
 *
 * ## The distribution notation
 *
 * Every LUB test is really a statement about a *shape*: "amount 5 was chosen by
 * one person and amount 2 by seven, so 5 wins". So the fixtures take that
 * shape literally — `[{ amount: 5, bidders: 1 }, …]` — and the helper works
 * out which bidder places what. A test then reads as the rule it is checking
 * rather than as a pile of `placeBids` calls.
 *
 * The auctions here run **1..100 in steps of 1** so that the amounts in a test
 * are the amounts in the specification, with no mental arithmetic between the
 * two. The default fixture elsewhere steps by 100, which is more realistic and
 * less readable; readability wins in the suite whose whole purpose is to state
 * the product rule.
 */

/** One amount and how many distinct bidders chose it. */
export interface AmountSpec {
  readonly amount: number;
  readonly bidders: number;
}

export interface ClosableAuctionFixture {
  readonly auctionId: string;
  readonly productId: string;
  readonly sellerId: string;
  /** In the order they were created; `bidderIds[0]` places every amount. */
  readonly bidderIds: readonly string[];
}

/**
 * An auction whose deadline has passed, with a given distribution of bids.
 *
 * The sequence matters and mirrors reality: bids are placed while the auction
 * is genuinely live and accepting them, and *only then* is the window moved
 * into the past. A fixture that backdated first would have to bypass the
 * engine to insert bids at all, and would prove nothing about bids the engine
 * accepted.
 *
 * `bidders` defaults to the largest count in the distribution, which is the
 * fewest distinct users that can produce the shape. Bidder *i* places every
 * amount whose count is greater than *i*, so amounts with one bidder are
 * always bidder 0 — no user ever holds two bids at one amount, which the
 * database would refuse anyway.
 */
export async function createClosableAuction(
  db: pg.Client,
  options: {
    distribution?: readonly AmountSpec[] | undefined;
    bidders?: number | undefined;
    bidFeeMinor?: bigint | undefined;
    channelFor?: ((bidderIndex: number) => 'web' | 'telegram') | undefined;
    stockQuantity?: number | undefined;
  } = {},
): Promise<ClosableAuctionFixture> {
  const distribution = options.distribution ?? [];
  const needed = options.bidders ?? distribution.reduce((most, spec) => Math.max(most, spec.bidders), 0);

  const auction = await createLiveAuction(db, {
    minBidMinor: 1n,
    maxBidMinor: 100n,
    bidIncrementMinor: 1n,
    maxBidsPerUser: 100,
    ...(options.bidFeeMinor === undefined ? {} : { bidFeeMinor: options.bidFeeMinor }),
    ...(options.stockQuantity === undefined ? {} : { stockQuantity: options.stockQuantity }),
  });

  const bidderIds: string[] = [];
  for (let index = 0; index < needed; index += 1) {
    const bidder = await createBidder(db, { fundMinor: 10_000_000n });
    bidderIds.push(bidder.userId);
  }

  // One submission per bidder carrying every amount they take part in, which
  // is also how a real batch arrives.
  for (const [index, userId] of bidderIds.entries()) {
    const amounts = distribution.filter((spec) => spec.bidders > index).map((spec) => spec.amount);
    if (amounts.length === 0) continue;
    await placeBids({
      userId,
      auctionId: auction.auctionId,
      amountsMinor: amounts,
      channel: options.channelFor?.(index) ?? 'web',
    });
  }

  await forceWindow(db, {
    auctionId: auction.auctionId,
    startsAt: '-2 hours',
    endsAt: '-1 second',
  });

  return { ...auction, bidderIds };
}

/**
 * Close an auction the way the worker does.
 *
 * `close()` first, because moving `live → closing` is the lifecycle's job and
 * comparing the clock to `ends_at` is its check; then `closeAuction()`, which
 * owns everything from `closing` onwards. Tests go through both rather than
 * calling `calculateLubV1` directly — a calculator that is right while the
 * workflow around it is wrong is the failure mode this project has already
 * met.
 */
export async function runClosing(auctionId: string) {
  await auctions.close({ auctionId, context: { channel: 'system' } });
  return results.closeAuction({ auctionId, context: { channel: 'system' } });
}

/** The stored result row, read straight from the table. */
export async function readResultRow(
  db: pg.Client,
  auctionId: string,
): Promise<
  | {
      outcome: string;
      algorithmVersion: string;
      winningBidId: string | null;
      winnerUserId: string | null;
      winningAmountMinor: bigint | null;
      totalBids: number;
      totalValidBids: number;
      uniqueAmountCount: number;
      participantCount: number;
      frozenBidChecksum: string;
    }
  | undefined
> {
  const { rows } = await db.query<{
    outcome: string;
    algorithm_version: string;
    winning_bid_id: string | null;
    winner_user_id: string | null;
    winning_amount_minor: string | null;
    total_bids: number;
    total_valid_bids: number;
    unique_amount_count: number;
    participant_count: number;
    frozen_bid_checksum: string;
  }>(
    `SELECT outcome, algorithm_version, winning_bid_id, winner_user_id, winning_amount_minor,
            total_bids, total_valid_bids, unique_amount_count, participant_count,
            frozen_bid_checksum
       FROM auction_results WHERE auction_id = $1`,
    [auctionId],
  );
  const row = rows[0];
  if (!row) return undefined;
  return {
    outcome: row.outcome,
    algorithmVersion: row.algorithm_version,
    winningBidId: row.winning_bid_id,
    winnerUserId: row.winner_user_id,
    winningAmountMinor: row.winning_amount_minor === null ? null : BigInt(row.winning_amount_minor),
    totalBids: row.total_bids,
    totalValidBids: row.total_valid_bids,
    uniqueAmountCount: row.unique_amount_count,
    participantCount: row.participant_count,
    frozenBidChecksum: row.frozen_bid_checksum,
  };
}

export async function countResultRows(db: pg.Client, auctionId: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM auction_results WHERE auction_id = $1`,
    [auctionId],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function readOrderRows(
  db: pg.Client,
  auctionId: string,
): Promise<
  {
    id: string;
    orderNumber: string;
    userId: string;
    status: string;
    totalMinor: bigint;
    subtotalMinor: bigint;
    paymentDueAt: Date | null;
    placedAt: Date;
  }[]
> {
  const { rows } = await db.query<{
    id: string;
    order_number: string;
    user_id: string;
    status: string;
    total_minor: string;
    subtotal_minor: string;
    payment_due_at: Date | null;
    placed_at: Date;
  }>(
    `SELECT id, order_number, user_id, status, total_minor, subtotal_minor,
            payment_due_at, placed_at
       FROM orders WHERE auction_id = $1 ORDER BY placed_at`,
    [auctionId],
  );
  return rows.map((row) => ({
    id: row.id,
    orderNumber: row.order_number,
    userId: row.user_id,
    status: row.status,
    totalMinor: BigInt(row.total_minor),
    subtotalMinor: BigInt(row.subtotal_minor),
    paymentDueAt: row.payment_due_at,
    placedAt: row.placed_at,
  }));
}

/** The reservation's state, to prove a unit was kept or returned. */
export async function readReservation(
  db: pg.Client,
  auctionId: string,
): Promise<{ state: string; reservedQuantity: number } | undefined> {
  const { rows } = await db.query<{ state: string; reserved_quantity: number }>(
    `SELECT r.state, p.reserved_quantity
       FROM inventory_reservations r
       JOIN products p ON p.id = r.product_id
      WHERE r.auction_id = $1`,
    [auctionId],
  );
  const row = rows[0];
  return row ? { state: row.state, reservedQuantity: row.reserved_quantity } : undefined;
}

/** Every `bid_fee_refund` entry booked against one auction. */
export async function readRefundEntries(
  db: pg.Client,
  auctionId: string,
): Promise<{ userId: string; amountMinor: bigint; idempotencyKey: string | null }[]> {
  const { rows } = await db.query<{
    user_id: string;
    amount_minor: string;
    idempotency_key: string | null;
  }>(
    `SELECT user_id, amount_minor, idempotency_key
       FROM wallet_entries
      WHERE entry_type = 'bid_fee_refund'
        AND reference_type = 'auction'
        AND reference_id = $1
      ORDER BY user_id`,
    [auctionId],
  );
  return rows.map((row) => ({
    userId: row.user_id,
    amountMinor: BigInt(row.amount_minor),
    idempotencyKey: row.idempotency_key,
  }));
}

/** Audit actions recorded against one auction, in order. */
export async function readAuditActions(db: pg.Client, auctionId: string): Promise<string[]> {
  const { rows } = await db.query<{ action: string }>(
    `SELECT action FROM audit_logs
      WHERE entity_id = $1 OR after_data->>'auctionId' = $1
      ORDER BY created_at, id`,
    [auctionId],
  );
  return rows.map((row) => row.action);
}

export async function readAuctionStatus(db: pg.Client, auctionId: string): Promise<string> {
  const { rows } = await db.query<{ status: string }>(`SELECT status FROM auctions WHERE id = $1`, [
    auctionId,
  ]);
  return rows[0]?.status ?? 'missing';
}

// ---------------------------------------------------------------------------
// Bulk fixtures, for the scale measurements only
// ---------------------------------------------------------------------------

/**
 * Insert bids straight into the table, bypassing the bidding engine.
 *
 * **Only for measuring the calculator.** Every correctness test in this phase
 * places bids through `submitBids` so that what is being decided is a set the
 * real engine accepted; this exists because a hundred thousand of those would
 * be a hundred thousand transactions with a wallet debit each, and what is
 * being measured is how LUB_V1 behaves against a large bid set, not how fast
 * bids can be taken.
 *
 * The shape is `bidders × amounts`: bidder *b* bids every amount in the range,
 * so `(auction, user, amount)` is unique — which the database would insist on
 * anyway — and the distribution is entirely duplicates except where a lone
 * `uniqueAmount` is added on top. That makes the *worst* case for the
 * algorithm: every group has to be counted before the answer is known.
 *
 * Users are inserted in one statement under the suite's email domain, so the
 * shared teardown removes them with everything else.
 *
 * ## It deliberately does not `ANALYZE`
 *
 * A bulk-loaded table has `reltuples = 0` until something analyses it, and a
 * planner that believes `bids` is empty is free to pick a plan that re-runs
 * the uniqueness aggregate once per bid — which is how the quadratic LUB
 * query documented in `lubCalculator.ts` was found. Analysing here would hide
 * that class of defect behind good statistics, so the fixture leaves the
 * table exactly as a bulk load leaves it and the scale test keeps measuring
 * the worst case.
 */
export async function seedBidsDirectly(
  db: pg.Client,
  input: {
    auctionId: string;
    bidders: number;
    amounts: number;
    /** An amount only one bidder places, so the set has a winner. */
    uniqueAmount?: number | undefined;
    feeMinor?: bigint | undefined;
  },
): Promise<{ userIds: string[]; bidCount: number }> {
  const tag = `bulk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const { rows: users } = await db.query<{ id: string }>(
    `INSERT INTO users (email, display_name, status)
     SELECT format('%s-%s@catalog-suite.test.local', $1::text, g),
            format('Bulk bidder %s', g),
            'active'
       FROM generate_series(1, $2::int) AS g
     RETURNING id`,
    [tag, input.bidders],
  );
  const userIds = users.map((row) => row.id);

  await db.query(
    `INSERT INTO bids (auction_id, user_id, amount_minor, fee_minor, status, channel)
     SELECT $1::uuid,
            u.id,
            a.amount,
            $3::bigint,
            'valid',
            CASE WHEN (a.amount % 2) = 0 THEN 'web'::channel ELSE 'telegram'::channel END
       FROM unnest($2::uuid[]) AS u(id)
       CROSS JOIN generate_series(1, $4::int) AS a(amount)`,
    [input.auctionId, userIds, (input.feeMinor ?? 0n).toString(), input.amounts],
  );

  let bidCount = userIds.length * input.amounts;
  if (input.uniqueAmount !== undefined) {
    await db.query(
      `INSERT INTO bids (auction_id, user_id, amount_minor, fee_minor, status, channel)
       VALUES ($1, $2, $3, $4, 'valid', 'web')`,
      [input.auctionId, userIds[0], input.uniqueAmount, (input.feeMinor ?? 0n).toString()],
    );
    bidCount += 1;
  }

  return { userIds, bidCount };
}

/** Time one operation, in milliseconds. */
export async function timed<T>(operation: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = process.hrtime.bigint();
  const value = await operation();
  return { value, ms: Number(process.hrtime.bigint() - started) / 1_000_000 };
}
