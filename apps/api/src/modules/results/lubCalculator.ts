import { getPool, type Tx } from '../../db/index.js';

/**
 * LUB_V1. **The only implementation of the winner rule in HOWLOW.**
 *
 * ## The rule
 *
 * > The winner is the **lowest bid amount that exactly one valid bid was
 * > placed at.**
 *
 * Not the lowest bid. The lowest bid usually *loses*, because low amounts are
 * the obvious guesses and obvious guesses collide. An amount five people chose
 * is worth nothing to any of them; an amount one person chose beats every
 * higher lonely amount and every crowded lower one.
 *
 * If every amount was chosen by two or more bidders there is no winner at all
 * — not a fallback to the lowest, not the second-lowest unique, not a
 * tie-break. `null` means nobody won.
 *
 * ## Why this file is alone
 *
 * A second implementation of this rule would eventually disagree with this
 * one, and what the two would disagree about is who won an auction people paid
 * to enter. So there is exactly one, it lives in the results module, and
 * nothing else — no channel, no client, no admin tool, no Telegram handler —
 * computes a winner. The website and the bot *display* the result this file
 * produced; they never derive one.
 *
 * ## Why it is SQL
 *
 * The uniqueness question is an aggregate over the whole bid set, and the bid
 * set can be a hundred thousand rows. Pulling it into Node to count would cost
 * memory proportional to the auction's popularity and would make the answer
 * depend on the worker's heap rather than on the bids. PostgreSQL answers it
 * from `bids_auction_amount_idx` — a partial index on `(auction_id,
 * amount_minor) WHERE status = 'valid'` — so the plan is an index-only scan
 * and one grouping, and the row that comes back to Node is the winner.
 *
 * ## What takes part
 *
 * Only `status = 'valid'` bids. A voided bid never participated: its fee was
 * returned, and counting it would let a refunded bid keep denying an amount to
 * somebody else. `channel` is not in any clause here — a Telegram bid and a
 * web bid are the same row and neither is favoured, which is the whole point
 * of one backend behind two channels.
 *
 * ## `count(*) = 1`, not `count(DISTINCT user_id) = 1`
 *
 * These are the same number: `bids_valid_amount_unique_key` makes it
 * impossible for one user to hold two valid bids at one amount in one auction,
 * so bids at an amount and bidders at an amount are always equal. `count(*)`
 * is written because the rule is about bids, and because it is the cheaper of
 * the two to compute — but if that index were ever dropped, this would become
 * the stricter reading (a user bidding twice at the same amount would make the
 * amount non-unique), which is the safer way to be wrong.
 *
 * ## Reading `bids`
 *
 * `modules/bidding` owns every **write** to `bids`, and that monopoly is what
 * keeps a bid from existing without its fee and its counters. This module only
 * ever reads, and only ever in aggregate: no statement in the results module
 * inserts, updates or deletes a bid.
 */

const runner = (tx?: Tx) => tx ?? getPool();

/** The winning bid, or the fact that no amount stood alone. */
export interface LubWinner {
  readonly bidId: string;
  readonly userId: string;
  readonly amountMinor: bigint;
}

/**
 * The single authoritative LUB_V1 query.
 *
 * Written out rather than composed from fragments so that what runs against
 * the database is readable in one place:
 *
 *   1. group the auction's valid bids by amount
 *   2. keep the amounts with exactly one bid
 *   3. take the lowest of those
 *   4. return the one bid sitting at it
 *
 * The join in the outer query cannot match more than one row: step 2 kept only
 * amounts with a single valid bid.
 *
 * ## `AS MATERIALIZED` is load-bearing, and was not optional
 *
 * Without it this query is **quadratic in the number of bids**, and it was
 * found by running the scale measurement rather than by reading the SQL.
 *
 * PostgreSQL inlines a singly-referenced CTE by default. Inlined here, the
 * planner is free to put the join's *outer* side on `bids` and the grouping
 * aggregate on the *inner* side — which means re-running an aggregate over
 * every bid of the auction, once per bid of the auction. At a hundred thousand
 * bids that is ten billion row operations: the query does not slow down, it
 * stops finishing. Measured, with `bids` freshly bulk-loaded and not yet
 * analysed:
 *
 *     plain CTE          > 30,000 ms (cancelled by the statement timeout)
 *     AS MATERIALIZED            38 ms
 *
 * The trigger is the planner believing `bids` is small — `reltuples = 0`,
 * which is the state of any table that has not been analysed or vacuumed
 * since it was loaded. With accurate statistics the planner picks the good
 * shape on its own and both forms run in about 8 ms, which is precisely why
 * this is dangerous: it works in development and on a warm database, and it
 * hangs on the first auction after a restore or a fresh deployment. A closing
 * job is not a place to depend on autovacuum having caught up.
 *
 * `MATERIALIZED` removes the choice. The CTE becomes a real node, evaluated
 * exactly once, and the plan cannot degrade whatever the statistics say. The
 * 100,000-bid scale test deliberately does **not** analyse the table after
 * seeding, so it keeps exercising the bad-estimate case and would fail again
 * if this word were removed.
 */
const LUB_V1_QUERY = `
  WITH lowest_unique AS MATERIALIZED (
    SELECT amount_minor
      FROM bids
     WHERE auction_id = $1
       AND status = 'valid'
     GROUP BY amount_minor
    HAVING count(*) = 1
     ORDER BY amount_minor ASC
     LIMIT 1
  )
  SELECT b.id, b.user_id, b.amount_minor
    FROM bids b
    JOIN lowest_unique u ON u.amount_minor = b.amount_minor
   WHERE b.auction_id = $1
     AND b.status = 'valid'`;

/**
 * Decide an auction.
 *
 * Returns the winning bid, or `null` when no amount was chosen by exactly one
 * bidder — including the case where nobody bid at all.
 *
 * **Call this only once bidding has stopped.** The function itself cannot tell:
 * it reads whatever valid bids exist at the moment it runs, so run against a
 * live auction it would return a "winner" that the next bid could invalidate.
 * The closing service is what guarantees the bid set is frozen — the auction
 * is past `live`, so `bidService` refuses new bids — and it holds the auction
 * row while it works so nothing can change underneath. Passing that
 * transaction in is how the guarantee reaches this query.
 */
export async function calculateLubV1(auctionId: string, tx?: Tx): Promise<LubWinner | null> {
  const { rows } = await runner(tx).query<{ id: string; user_id: string; amount_minor: string }>(
    LUB_V1_QUERY,
    [auctionId],
  );
  const row = rows[0];
  if (!row) return null;
  return { bidId: row.id, userId: row.user_id, amountMinor: BigInt(row.amount_minor) };
}

/** The bid statistics frozen with a result, all from the same frozen set. */
export interface FrozenStatistics {
  /** Every bid row of the auction, whatever its status. */
  readonly totalBids: number;
  /** The bids that took part: `status = 'valid'`. */
  readonly totalValidBids: number;
  /** Distinct bidders among those valid bids. */
  readonly participantCount: number;
  /** How many amounts exactly one bidder chose. Zero means nobody won. */
  readonly uniqueAmountCount: number;
}

/**
 * Count the frozen bid set.
 *
 * Deliberately **not** read from `auctions.total_bids` and
 * `auctions.total_participants`. Those are live counters maintained by the
 * bidding engine for display; they are corrected by `recountAuction` when they
 * drift, and a result that quoted them would be quoting a cache. What is
 * persisted with a result has to be a count of the bids the result was
 * computed from, so it is counted here, in the same transaction, from the same
 * rows.
 *
 * One round trip. The three `bids`-wide counts share a scan; the
 * unique-amount count is a second, index-driven aggregate in the same
 * statement.
 */
export async function countFrozenBids(auctionId: string, tx?: Tx): Promise<FrozenStatistics> {
  const { rows } = await runner(tx).query<{
    total_bids: number;
    total_valid_bids: number;
    participant_count: number;
    unique_amount_count: number;
  }>(
    `SELECT
       count(*)::int                                            AS total_bids,
       count(*) FILTER (WHERE status = 'valid')::int             AS total_valid_bids,
       count(DISTINCT user_id) FILTER (WHERE status = 'valid')::int AS participant_count,
       -- An uncorrelated scalar subquery: it references nothing from the
       -- outer query, so PostgreSQL evaluates it once for the whole
       -- statement. That is what keeps this from repeating the aggregate per
       -- row the way an inlined CTE can — see the note on LUB_V1_QUERY.
       (SELECT count(*)::int
          FROM (SELECT 1
                  FROM bids v
                 WHERE v.auction_id = $1
                   AND v.status = 'valid'
                 GROUP BY v.amount_minor
                HAVING count(*) = 1) unique_amounts)            AS unique_amount_count
     FROM bids
     WHERE auction_id = $1`,
    [auctionId],
  );
  const row = rows[0];
  // An auction nobody bid on still aggregates to a row of zeros; a missing row
  // would mean the query itself changed shape.
  if (!row) {
    return { totalBids: 0, totalValidBids: 0, participantCount: 0, uniqueAmountCount: 0 };
  }
  return {
    totalBids: row.total_bids,
    totalValidBids: row.total_valid_bids,
    participantCount: row.participant_count,
    uniqueAmountCount: row.unique_amount_count,
  };
}

/**
 * The per-amount bid counts, lowest amount first.
 *
 * **Not used to decide anything** — `calculateLubV1` is the decision, and this
 * would be a second implementation of the rule if it were. It exists for
 * verification and for operational inspection: a test can check that the
 * winner the SQL chose is the winner the distribution implies, and an operator
 * investigating a dispute can see the shape of an auction without reading
 * every bid.
 *
 * It is never exposed to a bidder, before or after the close. A frequency
 * table of amounts is exactly the signal the auction withholds, and publishing
 * it after the fact would still tell every bidder what to avoid next time.
 */
export async function amountDistribution(
  auctionId: string,
  tx?: Tx,
): Promise<readonly { amountMinor: bigint; bidders: number }[]> {
  const { rows } = await runner(tx).query<{ amount_minor: string; bidders: number }>(
    `SELECT amount_minor, count(*)::int AS bidders
       FROM bids
      WHERE auction_id = $1
        AND status = 'valid'
      GROUP BY amount_minor
      ORDER BY amount_minor ASC`,
    [auctionId],
  );
  return rows.map((row) => ({ amountMinor: BigInt(row.amount_minor), bidders: row.bidders }));
}
