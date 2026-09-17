import { getPool, type Tx } from '../../db/index.js';

/**
 * The frozen-bid checksum.
 *
 * ## What it is for
 *
 * A result says "the winning amount was 47". The checksum says "and here is
 * the fingerprint of the exact set of bids that produced it". Together they
 * make a result *checkable*: anyone with access to the bids can recompute the
 * digest, and if it matches the one stored with the result then the bid set is
 * the one the winner was chosen from. If it does not match, something changed
 * after the auction was decided, and that is a finding rather than a mystery.
 *
 * This is what lets HOWLOW answer a bidder who does not believe the result,
 * without publishing everybody's bids: the digest proves the set is intact,
 * and the set itself stays private.
 *
 * ## The canonical representation
 *
 * Exactly this, and it is a published contract rather than an implementation
 * detail — an independent verifier has to be able to reproduce it:
 *
 *   * one line per **valid** bid in the auction
 *   * each line is `<bid id>:<user id>:<amount in minor units>`
 *   * ids are lowercase canonical UUID text; the amount is the integer with no
 *     separators, no sign and no decimal point
 *   * lines are ordered by **bid id ascending**
 *   * lines are joined by a single `\n` with no trailing newline
 *   * the digest is SHA-256 of the UTF-8 bytes of that string, lowercase hex
 *
 * An auction with no valid bids hashes the empty string, which gives the
 * well-known `e3b0c442…b855`. That is deliberate: `frozen_bid_checksum` is NOT
 * NULL, and "no bids" is a fact worth fingerprinting like any other.
 *
 * ### Why order by bid id
 *
 * The ordering has to be total and stable, and it must not be derivable from
 * anything the result depends on. `amount_minor` is not unique. `created_at`
 * is a `timestamptz` and two bids inserted by the same statement can share it
 * to the microsecond. `id` is a primary key: unique by definition, fixed at
 * insert, and untouchable afterwards — `enforce_bid_immutability` refuses to
 * let a bid's identity, owner, amount or creation time change at all.
 *
 * ### Why the three fields
 *
 * They are the bid *as evidence*: which bid, whose it was, and what it was
 * for. `status` is not in the line because only valid bids are in the set at
 * all — voiding a bid changes the set, and so changes the digest, which is
 * exactly the behaviour wanted. `fee_minor` and `channel` are not in it
 * because they have no bearing on who won: a result must not appear to change
 * because a fee schedule was re-read or a bidder switched from the bot to the
 * website.
 *
 * ## Why it is computed in PostgreSQL
 *
 * The digest has to cover every bid, so unlike the uniqueness question it
 * cannot avoid touching the whole set. The choice is *where* the set is
 * assembled, and assembling it in the database keeps it out of the Node heap:
 * `string_agg` builds the canonical text next to the rows and `pgcrypto`'s
 * `digest` hashes it, so one hex string crosses the wire instead of a hundred
 * thousand rows.
 *
 * The cost is honest and worth stating: the aggregated text is roughly 80
 * bytes per valid bid, so a 100,000-bid auction assembles about 8 MB inside
 * the database for the length of one query. That is the largest single
 * allocation in the closing path, and it is the thing to revisit first if
 * auctions ever get an order of magnitude bigger — a chunked, incremental hash
 * would trade this allocation for a more complicated contract, and it is not
 * worth doing before the numbers ask for it.
 */

const runner = (tx?: Tx) => tx ?? getPool();

/** SHA-256 of the empty string: the checksum of an auction with no valid bids. */
export const EMPTY_BID_SET_CHECKSUM = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/**
 * Fingerprint an auction's valid bids.
 *
 * Runs in the caller's transaction so the digest covers the same snapshot the
 * winner was computed from. Called outside one it would still be correct about
 * *some* moment, which is not the same thing and not what a result may rest
 * on.
 */
export async function checksumFrozenBids(auctionId: string, tx?: Tx): Promise<string> {
  const { rows } = await runner(tx).query<{ checksum: string }>(
    // `coalesce` catches the empty set: `string_agg` over no rows is NULL, and
    // a NULL digest would violate `auction_results.frozen_bid_checksum`.
    `SELECT encode(
              digest(
                coalesce(
                  string_agg(
                    b.id::text || ':' || b.user_id::text || ':' || b.amount_minor::text,
                    E'\\n' ORDER BY b.id
                  ),
                  ''
                ),
                'sha256'
              ),
              'hex'
            ) AS checksum
       FROM bids b
      WHERE b.auction_id = $1
        AND b.status = 'valid'`,
    [auctionId],
  );
  // The aggregate always returns exactly one row, empty set or not.
  return rows[0]?.checksum ?? EMPTY_BID_SET_CHECKSUM;
}

/**
 * The canonical lines themselves, for verification and for tests.
 *
 * Returns what `checksumFrozenBids` hashes, so a test can prove the digest is
 * a digest *of that* rather than of something the query happened to build —
 * and so an auditor can reproduce the hash with any SHA-256 implementation.
 *
 * This loads the set into memory and is therefore **not** on the closing path.
 * It is a verification tool, bounded by the caller's own judgement about the
 * size of the auction it is asked about.
 */
export async function canonicalBidLines(auctionId: string, tx?: Tx): Promise<readonly string[]> {
  const { rows } = await runner(tx).query<{ line: string }>(
    `SELECT b.id::text || ':' || b.user_id::text || ':' || b.amount_minor::text AS line
       FROM bids b
      WHERE b.auction_id = $1
        AND b.status = 'valid'
      ORDER BY b.id`,
    [auctionId],
  );
  return rows.map((row) => row.line);
}
