import type { AuctionOutcome } from '@howlow/shared';
import { getPool, type Tx } from '../../db/index.js';
import type { ParticipantFees, ResultRecord } from './types.js';

/**
 * Every statement that touches `auction_results`.
 *
 * Nothing outside `modules/results` reaches this table, and the ESLint
 * boundary rule refuses the import. The reason is narrower than the wallet's
 * and sharper: there is **no update and no delete here at all**. A result is
 * inserted once and read forever, `auction_results_append_only` enforces it in
 * the database, and this file gives the application no way to try.
 *
 * ## Tables this file reads but does not own
 *
 * `bids` and `auction_participants` belong to `modules/bidding`;
 * `wallet_entries` and `wallets` belong to `modules/wallet`. Every statement
 * here against those four is a **read**, and there is no INSERT, UPDATE or
 * DELETE against any of them anywhere in the results module. The monopolies
 * those modules hold are write monopolies — a bid may only be created with its
 * fee and its counters, money may only move with its ledger entry — and
 * reading does neither.
 *
 * Reading them is not optional. A result's statistics must be a count of the
 * bids the result was computed from, a refund must be the fee the participant
 * was actually charged, and "has this refund already been booked" is a
 * question only the ledger can answer truthfully. Each of those is a fact
 * about somebody else's table, and asking a service to hand it over one row at
 * a time would turn a single aggregate into a loop.
 */

const runner = (tx?: Tx) => tx ?? getPool();

/** PostgreSQL's unique-violation class. */
export const UNIQUE_VIOLATION = '23505';

interface ResultRow {
  id: string;
  auction_id: string;
  outcome: AuctionOutcome;
  algorithm_version: string;
  winning_bid_id: string | null;
  winner_user_id: string | null;
  winning_amount_minor: string | null;
  total_bids: number;
  total_valid_bids: number;
  unique_amount_count: number;
  participant_count: number;
  frozen_bid_checksum: string;
  computed_at: Date;
}

const RESULT_COLUMNS = `id, auction_id, outcome, algorithm_version, winning_bid_id,
  winner_user_id, winning_amount_minor, total_bids, total_valid_bids,
  unique_amount_count, participant_count, frozen_bid_checksum, computed_at`;

const toResult = (row: ResultRow): ResultRecord => ({
  id: row.id,
  auctionId: row.auction_id,
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
  computedAt: row.computed_at,
});

// ---------------------------------------------------------------------------
// Writing the one result
// ---------------------------------------------------------------------------

export interface InsertResultInput {
  readonly auctionId: string;
  readonly outcome: AuctionOutcome;
  readonly winningBidId: string | null;
  readonly winnerUserId: string | null;
  readonly winningAmountMinor: bigint | null;
  readonly totalBids: number;
  readonly totalValidBids: number;
  readonly uniqueAmountCount: number;
  readonly participantCount: number;
  readonly frozenBidChecksum: string;
}

/**
 * Write the result, or return the one that is already there.
 *
 * **This is where "closing twice does not produce two winners" is decided.**
 * Not in the worker, not in Redis job uniqueness, not in an application check
 * — here, on `auction_results_auction_id_key`, a unique index on
 * `auction_id`. A second closing attempt that somehow got past the auction row
 * lock still cannot insert a second result, and this returns the first one so
 * the caller carries on with the decision that was actually published.
 *
 * `ON CONFLICT DO NOTHING` with a `RETURNING` clause returns no row when the
 * conflict fires, so the existing row is read back explicitly. `xmax = 0`
 * distinguishes the two cases for the caller: true means this call inserted.
 *
 * `algorithm_version` is not in the column list. The column defaults to
 * `LUB_V1` and a CHECK constraint refuses anything else, so a result cannot be
 * stored claiming to have been decided by rules that do not exist. There is no
 * parameter here to pass a different version through, which is deliberate: a
 * future LUB_V2 would be a migration, a second calculator and a conscious
 * decision, not a string someone could thread into this insert.
 */
export async function insertResult(
  input: InsertResultInput,
  tx: Tx,
): Promise<{ result: ResultRecord; inserted: boolean }> {
  const { rows } = await tx.query<ResultRow & { inserted: boolean }>(
    `INSERT INTO auction_results (
       auction_id, outcome, winning_bid_id, winner_user_id, winning_amount_minor,
       total_bids, total_valid_bids, unique_amount_count, participant_count,
       frozen_bid_checksum
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (auction_id) DO NOTHING
     RETURNING ${RESULT_COLUMNS}, true AS inserted`,
    [
      input.auctionId,
      input.outcome,
      input.winningBidId,
      input.winnerUserId,
      input.winningAmountMinor,
      input.totalBids,
      input.totalValidBids,
      input.uniqueAmountCount,
      input.participantCount,
      input.frozenBidChecksum,
    ],
  );

  const inserted = rows[0];
  if (inserted) return { result: toResult(inserted), inserted: true };

  // The conflict fired: someone else decided this auction. Their result is the
  // one that counts, and it is returned unchanged.
  const existing = await lockResult(input.auctionId, tx);
  if (!existing) {
    // Only reachable if the conflicting row vanished, which the append-only
    // trigger makes impossible. Surfacing it beats returning a fabricated row.
    throw new Error(`auction_results conflict on ${input.auctionId} but no row could be read back`);
  }
  return { result: existing, inserted: false };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function findResult(auctionId: string, tx?: Tx): Promise<ResultRecord | undefined> {
  const { rows } = await runner(tx).query<ResultRow>(
    `SELECT ${RESULT_COLUMNS} FROM auction_results WHERE auction_id = $1`,
    [auctionId],
  );
  return rows[0] ? toResult(rows[0]) : undefined;
}

/**
 * The result, read inside a transaction.
 *
 * No `FOR UPDATE`, despite the name being about serialisation: the row cannot
 * be updated by anyone, so locking it would protect nothing. What the closing
 * transaction serialises on is the auction row, taken before any of this.
 */
async function lockResult(auctionId: string, tx: Tx): Promise<ResultRecord | undefined> {
  const { rows } = await tx.query<ResultRow>(
    `SELECT ${RESULT_COLUMNS} FROM auction_results WHERE auction_id = $1`,
    [auctionId],
  );
  return rows[0] ? toResult(rows[0]) : undefined;
}

/**
 * Results for several auctions at once, keyed by auction id.
 *
 * The listing surfaces need this: a page of ten closed auctions would
 * otherwise be ten round trips, and the website's "my auctions" view would be
 * one per row.
 */
export async function findResultsFor(
  auctionIds: readonly string[],
  tx?: Tx,
): Promise<Map<string, ResultRecord>> {
  if (auctionIds.length === 0) return new Map();
  const { rows } = await runner(tx).query<ResultRow>(
    `SELECT ${RESULT_COLUMNS} FROM auction_results WHERE auction_id = ANY($1::uuid[])`,
    [auctionIds],
  );
  return new Map(rows.map((row) => [row.auction_id, toResult(row)]));
}

// ---------------------------------------------------------------------------
// Participation fees
//
// Read-only, from `auction_participants`. The refund amount comes from what
// each participant was actually charged — `total_fees_minor`, accumulated by
// the bidding engine in the same transaction as each bid — and never from
// `bid_count × auctions.bid_fee_minor`. The two would agree today and could
// disagree tomorrow: a fee is charged at the rate in force when the bid was
// placed, so recomputing a refund from current configuration is a way to give
// somebody back the wrong amount.
// ---------------------------------------------------------------------------

/** Participants of one auction who paid a fee, in a stable order. */
export async function listFeePayers(auctionId: string, tx?: Tx): Promise<readonly ParticipantFees[]> {
  const { rows } = await runner(tx).query<{
    user_id: string;
    bid_count: number;
    total_fees_minor: string;
  }>(
    `SELECT user_id, bid_count, total_fees_minor
       FROM auction_participants
      WHERE auction_id = $1
        AND total_fees_minor > 0
      ORDER BY user_id`,
    [auctionId],
  );
  return rows.map((row) => ({
    userId: row.user_id,
    bidCount: row.bid_count,
    totalFeesMinor: BigInt(row.total_fees_minor),
  }));
}

/** One participant's standing, for their own view of a closed auction. */
export async function findParticipation(
  input: { auctionId: string; userId: string },
  tx?: Tx,
): Promise<ParticipantFees | undefined> {
  const { rows } = await runner(tx).query<{
    user_id: string;
    bid_count: number;
    total_fees_minor: string;
  }>(
    `SELECT user_id, bid_count, total_fees_minor
       FROM auction_participants
      WHERE auction_id = $1 AND user_id = $2`,
    [input.auctionId, input.userId],
  );
  const row = rows[0];
  if (!row) return undefined;
  return {
    userId: row.user_id,
    bidCount: row.bid_count,
    totalFeesMinor: BigInt(row.total_fees_minor),
  };
}

/**
 * What has already been refunded to one user for one auction.
 *
 * Read from the ledger rather than from a flag, because the ledger is the
 * record: a `bid_fee_refund` entry referencing this auction is the only
 * evidence that money moved, and a boolean somewhere else could disagree with
 * it. Summing is safe — the refund pass books at most one entry per
 * (auction, user) by idempotency key — and it is what the caller's own view
 * needs to show.
 */
export async function sumRefunded(input: { auctionId: string; userId: string }, tx?: Tx): Promise<bigint> {
  const { rows } = await runner(tx).query<{ total: string }>(
    // `user_id` is denormalised onto the entry precisely so a per-user audit of
    // the ledger needs no join, which is what this is.
    `SELECT coalesce(sum(amount_minor), 0)::text AS total
       FROM wallet_entries
      WHERE user_id = $2
        AND entry_type = 'bid_fee_refund'
        AND reference_type = 'auction'
        AND reference_id = $1`,
    [input.auctionId, input.userId],
  );
  return BigInt(rows[0]?.total ?? '0');
}

/**
 * Auctions that were decided but whose fee refunds have not all been booked.
 *
 * The recovery query for the refund pass. Refunds run in their own
 * transactions — one wallet lock each — so a crash between two of them leaves
 * an auction correctly decided with some participants paid back and some not.
 * This finds those auctions so the next sweep finishes the job, which is why
 * the split is safe to make.
 *
 * `winner` results are excluded because a decided auction refunds nothing: the
 * participation fee bought a place in an auction that ran.
 */
export async function findAuctionsWithUnpaidRefunds(limit: number, tx?: Tx): Promise<readonly string[]> {
  const { rows } = await runner(tx).query<{ auction_id: string }>(
    `SELECT r.auction_id
       FROM auction_results r
      WHERE r.outcome IN ('no_unique_bid', 'cancelled')
        AND EXISTS (
          SELECT 1
            FROM auction_participants p
           WHERE p.auction_id = r.auction_id
             AND p.total_fees_minor > 0
             AND NOT EXISTS (
               SELECT 1
                 FROM wallet_entries e
                WHERE e.user_id = p.user_id
                  AND e.entry_type = 'bid_fee_refund'
                  AND e.reference_type = 'auction'
                  AND e.reference_id = r.auction_id
             )
        )
      ORDER BY r.computed_at ASC
      LIMIT $1`,
    [limit],
  );
  return rows.map((row) => row.auction_id);
}

/**
 * Auctions that need deciding.
 *
 * The recovery query for the closing workflow, and the reason a crashed close
 * is not a stuck auction. Three cases, all of them "past bidding, no result
 * row":
 *
 *   * **`closing`** — the lifecycle stopped the bidding and nothing has
 *     decided the auction yet. Normally the scheduled job does it within
 *     seconds; this catches the case where the job never ran.
 *   * **`calculating`** — a close was interrupted after T1 committed. The
 *     auction is visibly mid-flight, which is exactly why `calculating` is a
 *     real state rather than one folded into the decision.
 *   * **`cancelled` with participants** — an auction pulled while people had
 *     bid. It is terminal and keeps no status to change, but it still owes a
 *     result row (an operator needs to know what the bid set looked like) and
 *     it still owes everybody their fees back.
 *
 * `auctions` is the driving table and is read only; the `NOT EXISTS` against
 * this module's own `auction_results` is what makes the query a to-do list
 * rather than a repeat of work already done.
 */
export async function findAuctionsAwaitingResult(limit: number, tx?: Tx): Promise<readonly string[]> {
  const { rows } = await runner(tx).query<{ id: string }>(
    `SELECT a.id
       FROM auctions a
      WHERE (
              a.status IN ('closing', 'calculating')
              OR (
                a.status = 'cancelled'
                AND EXISTS (SELECT 1 FROM auction_participants p WHERE p.auction_id = a.id)
              )
            )
        AND NOT EXISTS (SELECT 1 FROM auction_results r WHERE r.auction_id = a.id)
      ORDER BY a.ends_at ASC
      LIMIT $1`,
    [limit],
  );
  return rows.map((row) => row.id);
}
