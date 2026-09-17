import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import * as auctions from '@howlow/api/modules/auctions';
import * as bidding from '@howlow/api/modules/bidding';
import * as wallet from '@howlow/api/modules/wallet';
import { createProductRow, createSeller, createUser, validAuctionTerms } from './catalog-helpers.js';

/**
 * Fixtures for the bidding suites.
 *
 * A bid needs more standing around it than anything else in the platform: an
 * approved seller, a product with stock, a live auction holding a reservation,
 * and a funded wallet. Building that by hand in every test would bury what
 * each test is actually about.
 */

export interface LiveAuctionFixture {
  readonly auctionId: string;
  readonly productId: string;
  readonly sellerId: string;
}

export interface BidderFixture {
  readonly userId: string;
}

/**
 * An auction in `live`, holding its unit, ready to take bids.
 *
 * Written through the lifecycle service as far as it will go and then
 * backdated: the service correctly refuses a start time in the past, and what
 * these tests are about is what happens once an auction *is* live. The
 * reservation is created by `open`, so this path exercises the real Phase 4
 * inventory hold rather than faking one.
 */
export async function createLiveAuction(
  db: pg.Client,
  options: {
    seller?: { sellerId: string; userId: string } | undefined;
    manager?: string | undefined;
    bidFeeMinor?: bigint | undefined;
    minBidMinor?: bigint | undefined;
    maxBidMinor?: bigint | undefined;
    bidIncrementMinor?: bigint | undefined;
    maxBidsPerUser?: number | undefined;
    stockQuantity?: number | undefined;
  } = {},
): Promise<LiveAuctionFixture> {
  const seller = options.seller ?? (await createSeller(db));
  const manager = options.manager ?? (await managerUser(db));
  const productId = await createProductRow(db, {
    sellerId: seller.sellerId,
    stockQuantity: options.stockQuantity ?? 1,
  });

  const auction = await auctions.createAuction({
    ...validAuctionTerms({
      ...(options.bidFeeMinor !== undefined ? { bidFeeMinor: options.bidFeeMinor } : {}),
      ...(options.minBidMinor !== undefined ? { minBidMinor: options.minBidMinor } : {}),
      ...(options.maxBidMinor !== undefined ? { maxBidMinor: options.maxBidMinor } : {}),
      ...(options.bidIncrementMinor !== undefined ? { bidIncrementMinor: options.bidIncrementMinor } : {}),
      ...(options.maxBidsPerUser !== undefined ? { maxBidsPerUser: options.maxBidsPerUser } : {}),
    }),
    sellerId: seller.sellerId,
    actorUserId: seller.userId,
    productId,
    context: { channel: 'web', actorUserId: seller.userId },
  });

  await auctions.submitForApproval({ auctionId: auction.id, sellerId: seller.sellerId });
  await auctions.approve({ auctionId: auction.id, actorUserId: manager });
  // Backdated directly: the service refuses a past start time, and a live
  // auction is the precondition, not the subject.
  await db.query(
    `UPDATE auctions SET starts_at = now() - interval '10 minutes',
                         ends_at = now() + interval '2 hours'
      WHERE id = $1`,
    [auction.id],
  );
  await auctions.open({ auctionId: auction.id });

  return { auctionId: auction.id, productId, sellerId: seller.sellerId };
}

/** A user who may approve auctions, for the fixture path above. */
export async function managerUser(db: pg.Client): Promise<string> {
  return createUser(db, { roles: ['auction_manager'] });
}

/**
 * An active bidder with a **verified phone** and a funded wallet.
 *
 * The verified phone is not decoration: the engine refuses a bid from an
 * unverified account, so a fixture without it would make every test in these
 * suites fail on eligibility rather than on what it means to test. Written
 * directly because the OTP round trip is Phase 2's subject, not this one's —
 * and `createUser` deliberately makes email-only users, which is right for the
 * catalog suites.
 */
export async function createBidder(
  db: pg.Client,
  options: { fundMinor?: bigint } = {},
): Promise<BidderFixture> {
  const userId = await createUser(db, {});
  await db.query(`UPDATE users SET phone = $2, phone_verified_at = now() WHERE id = $1`, [
    userId,
    uniquePhone(),
  ]);
  const amount = options.fundMinor ?? 1_000_000n;
  if (amount > 0n) await fundWallet(userId, amount);
  return { userId };
}

/** Phone numbers are unique platform-wide, so each fixture needs its own. */
let phoneCounter = 0;
function uniquePhone(): string {
  phoneCounter += 1;
  const suffix = String((Date.now() % 100_000) * 100 + phoneCounter).slice(-9);
  return `+2519${suffix.padStart(9, '0')}`;
}

/**
 * Put money in a wallet through the wallet service.
 *
 * A deposit, not an UPDATE: the balance and its ledger entry must agree, and a
 * fixture that wrote the column directly would leave every reconciliation
 * assertion in these suites testing a lie.
 */
export async function fundWallet(userId: string, amountMinor: bigint): Promise<void> {
  await wallet.credit('deposit', {
    userId,
    amountMinor,
    channel: 'system',
    memo: 'test funding',
    actorUserId: userId,
  });
}

export async function walletBalance(userId: string): Promise<bigint> {
  return (await wallet.getWallet(userId)).availableMinor;
}

/** A submission with everything but the parts a test cares about filled in. */
export function submission(input: {
  userId: string;
  auctionId: string;
  amountsMinor: readonly (string | number | bigint)[];
  idempotencyKey?: string;
  channel?: 'web' | 'telegram' | 'admin' | 'system';
  ipAddress?: string;
  deviceHash?: string;
}): Parameters<typeof bidding.submitBids>[0] {
  return {
    userId: input.userId,
    auctionReference: input.auctionId,
    amountsMinor: input.amountsMinor.map((amount) => String(amount)),
    idempotencyKey: input.idempotencyKey ?? randomUUID(),
    channel: input.channel ?? 'web',
    ...(input.ipAddress !== undefined ? { ipAddress: input.ipAddress } : {}),
    ...(input.deviceHash !== undefined ? { deviceHash: input.deviceHash } : {}),
  };
}

/** Place bids, as the engine would be called by either channel. */
export async function placeBids(input: Parameters<typeof submission>[0]) {
  return bidding.submitBids(submission(input));
}

// ---------------------------------------------------------------------------
// Reads, for asserting against the database rather than the return value
// ---------------------------------------------------------------------------

export async function readAuctionCounters(
  db: pg.Client,
  auctionId: string,
): Promise<{ totalBids: number; totalParticipants: number }> {
  const { rows } = await db.query<{ total_bids: number; total_participants: number }>(
    `SELECT total_bids, total_participants FROM auctions WHERE id = $1`,
    [auctionId],
  );
  const row = rows[0]!;
  return { totalBids: row.total_bids, totalParticipants: row.total_participants };
}

export async function readParticipant(
  db: pg.Client,
  input: { auctionId: string; userId: string },
): Promise<
  | {
      bidCount: number;
      totalFeesMinor: bigint;
      firstBidAt: Date | null;
      lastBidAt: Date | null;
      joinedChannel: string;
    }
  | undefined
> {
  const { rows } = await db.query<{
    bid_count: number;
    total_fees_minor: string;
    first_bid_at: Date | null;
    last_bid_at: Date | null;
    joined_channel: string;
  }>(
    `SELECT bid_count, total_fees_minor, first_bid_at, last_bid_at, joined_channel
       FROM auction_participants WHERE auction_id = $1 AND user_id = $2`,
    [input.auctionId, input.userId],
  );
  const row = rows[0];
  if (!row) return undefined;
  return {
    bidCount: row.bid_count,
    totalFeesMinor: BigInt(row.total_fees_minor),
    firstBidAt: row.first_bid_at,
    lastBidAt: row.last_bid_at,
    joinedChannel: row.joined_channel,
  };
}

export async function readBids(
  db: pg.Client,
  auctionId: string,
): Promise<
  {
    userId: string;
    amountMinor: bigint;
    feeMinor: bigint;
    status: string;
    channel: string;
    walletEntryId: string | null;
    ipAddress: string | null;
    deviceHash: string | null;
    requestId: string | null;
  }[]
> {
  const { rows } = await db.query<{
    user_id: string;
    amount_minor: string;
    fee_minor: string;
    status: string;
    channel: string;
    wallet_entry_id: string | null;
    ip_address: string | null;
    device_hash: string | null;
    request_id: string | null;
  }>(
    `SELECT user_id, amount_minor, fee_minor, status, channel, wallet_entry_id,
            host(ip_address) AS ip_address, device_hash, request_id
       FROM bids WHERE auction_id = $1 ORDER BY amount_minor`,
    [auctionId],
  );
  return rows.map((row) => ({
    userId: row.user_id,
    amountMinor: BigInt(row.amount_minor),
    feeMinor: BigInt(row.fee_minor),
    status: row.status,
    channel: row.channel,
    walletEntryId: row.wallet_entry_id,
    ipAddress: row.ip_address,
    deviceHash: row.device_hash,
    requestId: row.request_id,
  }));
}

/** Ledger entries a bid batch produced, for the "charged once" assertions. */
export async function readBidFeeEntries(
  db: pg.Client,
  input: { userId: string; auctionId: string },
): Promise<{ amountMinor: bigint; balanceAfterMinor: bigint }[]> {
  const { rows } = await db.query<{ amount_minor: string; balance_after_minor: string }>(
    `SELECT amount_minor, balance_after_minor FROM wallet_entries
      WHERE user_id = $1 AND entry_type = 'bid_fee'
        AND reference_type = 'auction' AND reference_id = $2
      ORDER BY seq`,
    [input.userId, input.auctionId],
  );
  return rows.map((row) => ({
    amountMinor: BigInt(row.amount_minor),
    balanceAfterMinor: BigInt(row.balance_after_minor),
  }));
}

/**
 * Move a live auction's bidding window.
 *
 * `starts_at` and `ends_at` are protected terms once an auction is live, and
 * the Phase 4 trigger refuses to change them — correctly, since a seller must
 * not be able to extend or curtail an auction people are bidding in. These
 * tests need a live auction whose window has passed or not yet opened, which
 * production can reach (a close job that has not run yet) but no API can
 * create.
 *
 * So this drops to `session_replication_role = 'replica'` for one statement,
 * the same test-only escape hatch teardown uses. No application code may do
 * this, and the guarantee it suspends is itself asserted by
 * tests/db/immutability.test.ts.
 */
export async function forceWindow(
  db: pg.Client,
  input: { auctionId: string; startsAt: string; endsAt: string },
): Promise<void> {
  await db.query('BEGIN');
  try {
    await db.query("SET LOCAL session_replication_role = 'replica'");
    await db.query(
      `UPDATE auctions SET starts_at = now() + $2::interval, ends_at = now() + $3::interval
        WHERE id = $1`,
      [input.auctionId, input.startsAt, input.endsAt],
    );
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

/**
 * Put an auction into a status the engine must refuse.
 *
 * The terminal statuses carry CHECK constraints tying them to their
 * timestamps — a `completed` auction with no `closed_at` is not a state the
 * platform allows — so the fixture sets both together rather than fighting the
 * constraint. Written directly because the subject is the engine's own status
 * check, not the transition table, which has its own suite.
 */
export async function forceStatus(
  db: pg.Client,
  input: { auctionId: string; status: string; actorUserId?: string | undefined },
): Promise<void> {
  const finished = ['closing', 'calculating', 'completed'].includes(input.status);
  const cancelled = input.status === 'cancelled';
  const suspended = input.status === 'suspended';
  await db.query(
    `UPDATE auctions
        SET status = $2::auction_status,
            closed_at = CASE WHEN $3 THEN now() ELSE closed_at END,
            cancelled_at = CASE WHEN $4 THEN now() ELSE cancelled_at END,
            cancel_reason = CASE WHEN $4 THEN 'test fixture' ELSE cancel_reason END,
            -- auctions_suspended_consistent requires all four suspension
            -- columns or none, so the fixture sets them together.
            suspended_at = CASE WHEN $5 THEN now() ELSE suspended_at END,
            suspended_by = CASE WHEN $5 THEN $6::uuid ELSE suspended_by END,
            suspend_reason = CASE WHEN $5 THEN 'test fixture' ELSE suspend_reason END,
            suspended_from = CASE WHEN $5 THEN 'live'::auction_status ELSE suspended_from END
      WHERE id = $1`,
    [input.auctionId, input.status, finished, cancelled, suspended, input.actorUserId ?? null],
  );
}

export async function countAuditRows(db: pg.Client, auctionId: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM audit_logs WHERE action = 'bid.submitted' AND entity_id = $1`,
    [auctionId],
  );
  return Number(rows[0]?.n ?? 0);
}

/** Every audit row's payload for this auction, to prove the amounts are absent. */
export async function readAuditPayloads(
  db: pg.Client,
  auctionId: string,
): Promise<Record<string, unknown>[]> {
  const { rows } = await db.query<{ after_data: Record<string, unknown> | null }>(
    `SELECT after_data FROM audit_logs WHERE action = 'bid.submitted' AND entity_id = $1`,
    [auctionId],
  );
  return rows.map((row) => row.after_data ?? {});
}
