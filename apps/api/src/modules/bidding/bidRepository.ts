import type { Channel } from '@howlow/shared';
import { getPool, type Tx } from '../../db/index.js';
import type { BidRecord, ParticipantRecord } from './types.js';

/**
 * Every statement that touches `bids` and `auction_participants`.
 *
 * Nothing outside `modules/bidding` reaches these tables; the ESLint boundary
 * rule enforces it. The reason is the same one that protects wallets: a bid
 * inserted without its fee, its participant counter and its auction counter is
 * not a cheaper bid, it is a corrupt auction.
 *
 * Auction rows are **not** written here. The bidding engine takes the auction
 * lock and moves the auction's counters through `modules/auctions`, which owns
 * that table.
 */

const runner = (tx?: Tx) => tx ?? getPool();

/** PostgreSQL's unique-violation class. */
export const UNIQUE_VIOLATION = '23505';

interface BidRow {
  id: string;
  auction_id: string;
  user_id: string;
  amount_minor: string;
  fee_minor: string;
  status: 'valid' | 'void' | 'refunded';
  channel: Channel;
  idempotency_key: string | null;
  wallet_entry_id: string | null;
  request_id: string | null;
  created_at: Date;
  voided_at: Date | null;
}

const toBid = (row: BidRow): BidRecord => ({
  id: row.id,
  auctionId: row.auction_id,
  userId: row.user_id,
  amountMinor: BigInt(row.amount_minor),
  feeMinor: BigInt(row.fee_minor),
  status: row.status,
  channel: row.channel,
  idempotencyKey: row.idempotency_key,
  walletEntryId: row.wallet_entry_id,
  requestId: row.request_id,
  createdAt: row.created_at,
  voidedAt: row.voided_at,
});

const BID_COLUMNS = `id, auction_id, user_id, amount_minor, fee_minor, status, channel,
  idempotency_key, wallet_entry_id, request_id, created_at, voided_at`;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The caller's own bids in one auction, oldest first. */
export async function listUserBids(
  input: { auctionId: string; userId: string },
  tx?: Tx,
): Promise<BidRecord[]> {
  const { rows } = await runner(tx).query<BidRow>(
    `SELECT ${BID_COLUMNS} FROM bids
      WHERE auction_id = $1 AND user_id = $2
      ORDER BY created_at, amount_minor`,
    [input.auctionId, input.userId],
  );
  return rows.map(toBid);
}

/**
 * Which of these amounts the user already holds as valid bids.
 *
 * A courtesy, not the rule: it turns the common case into a message naming the
 * amounts instead of a constraint violation. The rule itself is
 * `bids_valid_amount_unique_key`, which is the only check that holds when two
 * requests arrive at once — this read can be stale the instant it returns.
 */
export async function findExistingAmounts(
  input: { auctionId: string; userId: string; amountsMinor: readonly bigint[] },
  tx?: Tx,
): Promise<bigint[]> {
  if (input.amountsMinor.length === 0) return [];
  const { rows } = await runner(tx).query<{ amount_minor: string }>(
    `SELECT amount_minor FROM bids
      WHERE auction_id = $1 AND user_id = $2 AND status = 'valid'
        AND amount_minor = ANY($3::bigint[])
      ORDER BY amount_minor`,
    [input.auctionId, input.userId, input.amountsMinor.map((amount) => amount.toString())],
  );
  return rows.map((row) => BigInt(row.amount_minor));
}

/** Bids carrying one idempotency key, for replaying a retried request. */
export async function findBidsByIdempotencyKey(
  input: { auctionId: string; userId: string; idempotencyKey: string },
  tx?: Tx,
): Promise<BidRecord[]> {
  const { rows } = await runner(tx).query<BidRow>(
    `SELECT ${BID_COLUMNS} FROM bids
      WHERE auction_id = $1 AND user_id = $2 AND idempotency_key = $3
      ORDER BY amount_minor`,
    [input.auctionId, input.userId, input.idempotencyKey],
  );
  return rows.map(toBid);
}

// ---------------------------------------------------------------------------
// The batch insert
// ---------------------------------------------------------------------------

/**
 * Insert a whole batch in one statement.
 *
 * `unnest` rather than a row per statement: one round trip, one plan, and —
 * the part that matters — one statement for the unique index to reject. On
 * `ON CONFLICT DO NOTHING` the returned row count is how many actually landed,
 * which is what lets the caller compare against what it asked for and abort
 * the whole transaction if they differ. That comparison, not a prior SELECT,
 * is the duplicate rule under concurrency.
 *
 * `DO NOTHING` names no conflict target on purpose: a duplicate can violate
 * either `bids_valid_amount_unique_key` (the same amount already bid) or
 * `bids_idempotency_amount_unique` (the same key already produced this
 * amount), and both mean the same thing to the caller — fewer rows came back
 * than were asked for, so nothing is written at all.
 */
export async function insertBids(
  input: {
    auctionId: string;
    userId: string;
    amountsMinor: readonly bigint[];
    feeMinor: bigint;
    channel: Channel;
    idempotencyKey: string;
    requestId?: string | undefined;
    ipAddress?: string | undefined;
    deviceHash?: string | undefined;
  },
  tx: Tx,
): Promise<BidRecord[]> {
  const { rows } = await tx.query<BidRow>(
    `INSERT INTO bids
       (auction_id, user_id, amount_minor, fee_minor, status, channel,
        idempotency_key, request_id, ip_address, device_hash)
     SELECT $1, $2, amount, $3, 'valid', $4::channel, $5, $6::uuid, $7::inet, $8
       FROM unnest($9::bigint[]) AS amount
     ON CONFLICT DO NOTHING
     RETURNING ${BID_COLUMNS}`,
    [
      input.auctionId,
      input.userId,
      input.feeMinor.toString(),
      input.channel,
      input.idempotencyKey,
      input.requestId ?? null,
      input.ipAddress ?? null,
      input.deviceHash ?? null,
      input.amountsMinor.map((amount) => amount.toString()),
    ],
  );
  return rows.map(toBid);
}

/**
 * Attach the wallet entry that paid for these bids.
 *
 * Separate from the insert because the fee is debited after the rows exist:
 * the wallet lock is taken last, and the entry id does not exist until it is.
 * Same transaction either way, so a bid can never be visible without its fee
 * having been booked.
 */
export async function attachWalletEntry(
  input: { bidIds: readonly string[]; walletEntryId: string },
  tx: Tx,
): Promise<void> {
  if (input.bidIds.length === 0) return;
  await tx.query(`UPDATE bids SET wallet_entry_id = $2 WHERE id = ANY($1::uuid[])`, [
    [...input.bidIds],
    input.walletEntryId,
  ]);
}

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------

interface ParticipantRow {
  id: string;
  auction_id: string;
  user_id: string;
  bid_count: number;
  total_fees_minor: string;
  first_bid_at: Date | null;
  last_bid_at: Date | null;
  joined_channel: Channel;
}

const toParticipant = (row: ParticipantRow): ParticipantRecord => ({
  id: row.id,
  auctionId: row.auction_id,
  userId: row.user_id,
  bidCount: row.bid_count,
  totalFeesMinor: BigInt(row.total_fees_minor),
  firstBidAt: row.first_bid_at,
  lastBidAt: row.last_bid_at,
  joinedChannel: row.joined_channel,
});

const PARTICIPANT_COLUMNS = `id, auction_id, user_id, bid_count, total_fees_minor,
  first_bid_at, last_bid_at, joined_channel`;

export async function findParticipant(
  input: { auctionId: string; userId: string },
  tx?: Tx,
): Promise<ParticipantRecord | undefined> {
  const { rows } = await runner(tx).query<ParticipantRow>(
    `SELECT ${PARTICIPANT_COLUMNS} FROM auction_participants
      WHERE auction_id = $1 AND user_id = $2`,
    [input.auctionId, input.userId],
  );
  return rows[0] ? toParticipant(rows[0]) : undefined;
}

/**
 * Take the participant row under a lock, creating it if this is the user's
 * first bid. **This is where the bid limit becomes safe.**
 *
 * `INSERT ... ON CONFLICT DO UPDATE` rather than SELECT-then-INSERT: two
 * concurrent first bids from the same user would both find no row and both
 * insert, and one would fail on the unique index. The upsert always yields
 * exactly one row, and because `DO UPDATE` writes, that row is locked for the
 * rest of the transaction — so the second request blocks here and then reads
 * the `bid_count` the first committed. A `DO NOTHING` would return no row and
 * take no lock, which is the version of this that looks correct and races.
 *
 * `inserted` distinguishes the two cases the counters care about: a new
 * participant increments `auctions.total_participants`, an existing one does
 * not.
 *
 * Called after the auction lock and before the wallet lock, per the platform
 * order (auction → product → wallet → participant).
 */
export async function lockOrCreateParticipant(
  input: { auctionId: string; userId: string; channel: Channel },
  tx: Tx,
): Promise<{ participant: ParticipantRecord; inserted: boolean }> {
  const { rows } = await tx.query<ParticipantRow & { inserted: boolean }>(
    `INSERT INTO auction_participants (auction_id, user_id, joined_channel)
     VALUES ($1, $2, $3::channel)
     ON CONFLICT (auction_id, user_id) DO UPDATE
       -- A no-op write, so the existing row is locked for this transaction.
       SET updated_at = auction_participants.updated_at
     RETURNING ${PARTICIPANT_COLUMNS}, (xmax = 0) AS inserted`,
    [input.auctionId, input.userId, input.channel],
  );
  const row = rows[0];
  if (!row) throw new Error('participant upsert returned no row');
  return { participant: toParticipant(row), inserted: row.inserted };
}

/**
 * Add a committed batch to the participant's counters.
 *
 * `first_bid_at` is set once, by COALESCE, so a second batch cannot move it.
 * Both timestamps come from the database, never from the caller: the platform
 * clock decides when a bid happened.
 */
export async function addParticipantBids(
  input: { participantId: string; addedBids: number; addedFeesMinor: bigint },
  tx: Tx,
): Promise<ParticipantRecord> {
  const { rows } = await tx.query<ParticipantRow>(
    `UPDATE auction_participants
        SET bid_count = bid_count + $2,
            total_fees_minor = total_fees_minor + $3,
            first_bid_at = COALESCE(first_bid_at, now()),
            last_bid_at = now()
      WHERE id = $1
      RETURNING ${PARTICIPANT_COLUMNS}`,
    [input.participantId, input.addedBids, input.addedFeesMinor.toString()],
  );
  const row = rows[0];
  if (!row) throw new Error(`participant ${input.participantId} vanished mid-transaction`);
  return toParticipant(row);
}

// ---------------------------------------------------------------------------
// Counter reconciliation
// ---------------------------------------------------------------------------

/**
 * Recount an auction from its bids.
 *
 * Not used by the bid path — the counters are maintained transactionally and
 * are authoritative. This exists so a test, or an operator, can prove the
 * stored counters match the rows, the same way the wallet has a
 * reconciliation read. If these ever disagree, the counter update and the
 * insert have come apart, which is a bug and not something to paper over by
 * recomputing on read.
 */
export async function recountAuction(
  auctionId: string,
  tx?: Tx,
): Promise<{ totalBids: number; totalParticipants: number }> {
  const { rows } = await runner(tx).query<{ bids: string; participants: string }>(
    `SELECT count(*) AS bids, count(DISTINCT user_id) AS participants
       FROM bids WHERE auction_id = $1 AND status = 'valid'`,
    [auctionId],
  );
  const row = rows[0];
  return {
    totalBids: Number(row?.bids ?? 0),
    totalParticipants: Number(row?.participants ?? 0),
  };
}
