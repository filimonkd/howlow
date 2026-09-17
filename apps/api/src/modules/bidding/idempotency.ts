import { createHash } from 'node:crypto';
import type { Tx } from '../../db/index.js';
import { idempotencyConflict, idempotencyInProgress } from './errors.js';

/**
 * Request-level idempotency for bid submission.
 *
 * ## Why the claim is inside the bid transaction
 *
 * The key is claimed as the transaction's first act, before any row lock. That
 * ordering does three things at once:
 *
 *   - **A retry of a committed request replays.** The key row committed with
 *     the batch, so the retry's insert conflicts, it reads the stored
 *     response, and it charges nothing.
 *   - **A retry of a *failed* request is free to proceed.** The key row rolled
 *     back with everything else, so the retry inserts cleanly. A bid refused
 *     for insufficient funds must not burn the client's key — the client
 *     fixes the balance and retries the same intent.
 *   - **A concurrent duplicate queues in the cheapest possible place.** The
 *     second request blocks on the uncommitted unique index entry for
 *     `(scope, key)` while holding no auction, wallet or participant lock.
 *     When the first transaction ends it either finds the committed response
 *     and replays, or inserts and proceeds.
 *
 * The alternative — claiming the key in its own transaction first — would make
 * a rolled-back bid permanently consume its key, and would need a compensating
 * write on every failure path to undo it.
 */

/** How long a key is answerable for. After this a client may reuse it. */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

export const BID_SCOPE = 'bids.submit';

/**
 * What a request is, for the purpose of "is this the same request?".
 *
 * The auction, the user and the sorted amounts — and nothing else. Sorted
 * because `[10, 20]` and `[20, 10]` ask for the same thing, and a client that
 * reordered its own array on retry deserves a replay rather than a conflict.
 * Channel, address and device are excluded on purpose: the same intent
 * retried from a reconnected phone on a different address is the same intent.
 */
export function bidRequestHash(input: {
  auctionId: string;
  userId: string;
  amountsMinor: readonly bigint[];
}): string {
  const amounts = [...input.amountsMinor].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const canonical = JSON.stringify({
    auctionId: input.auctionId,
    userId: input.userId,
    amountsMinor: amounts.map((amount) => amount.toString()),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * The snapshot stored against a key, so a replay answers with the original
 * numbers rather than today's.
 *
 * Every amount is a string: `jsonb` has no integer type wide enough for a
 * BIGINT, and a balance that came back as a float would be a corrupted
 * balance. The bid rows themselves are re-read from `bids` on replay — the
 * snapshot carries their ids, not copies of them.
 */
export interface BidResponseSnapshot {
  readonly bidIds: readonly string[];
  readonly totalFeeMinor: string;
  readonly bidCount: number;
  readonly bidsRemaining: number;
  readonly walletBalanceMinor: string;
  readonly submittedAt: string;
  readonly totalBids: number;
  readonly totalParticipants: number;
}

export type Claim =
  | { readonly outcome: 'claimed'; readonly id: string }
  | { readonly outcome: 'replay'; readonly snapshot: BidResponseSnapshot };

/**
 * Claim `key` for this request, or discover that it has already been answered.
 *
 * Throws `IDEMPOTENCY_CONFLICT` when the key was used for a different request:
 * serving the first response to a client asking for something else would be
 * worse than refusing, because the client would believe bids it never placed
 * had been accepted.
 */
export async function claimKey(
  input: { key: string; userId: string; requestHash: string },
  tx: Tx,
): Promise<Claim> {
  const { rows: inserted } = await tx.query<{ id: string }>(
    `INSERT INTO idempotency_keys (key, scope, user_id, request_hash, state, expires_at)
     VALUES ($1, $2, $3, $4, 'in_progress', now() + make_interval(secs => $5))
     ON CONFLICT (scope, key) DO NOTHING
     RETURNING id`,
    [input.key, BID_SCOPE, input.userId, input.requestHash, IDEMPOTENCY_TTL_SECONDS],
  );
  const claimed = inserted[0];
  if (claimed) return { outcome: 'claimed', id: claimed.id };

  // The key exists and is committed: this is a retry, or a collision.
  const { rows } = await tx.query<{
    id: string;
    user_id: string | null;
    request_hash: string;
    state: string;
    response_body: BidResponseSnapshot | null;
  }>(
    `SELECT id, user_id, request_hash, state, response_body
       FROM idempotency_keys WHERE scope = $1 AND key = $2`,
    [BID_SCOPE, input.key],
  );
  const existing = rows[0];
  // Gone between the two statements — expired and swept. Treat as a conflict
  // rather than silently proceeding: we cannot tell what it answered.
  if (!existing) throw idempotencyConflict(input.key);

  // A key belongs to the user who created it. Another user presenting it is
  // not a retry, whatever the body says.
  if (existing.user_id !== input.userId || existing.request_hash !== input.requestHash) {
    throw idempotencyConflict(input.key);
  }

  if (existing.state === 'completed' && existing.response_body !== null) {
    return { outcome: 'replay', snapshot: existing.response_body };
  }

  // Unreachable while the claim lives inside the bid transaction: a crash
  // rolls the row back rather than leaving it in progress. Kept because
  // `idempotency_keys` is shared, and a future writer that claims in its own
  // transaction would make this state real. Refused rather than waited on —
  // waiting would hold this transaction open behind someone else's locks.
  throw idempotencyInProgress(input.key);
}

/** Record the answer, in the transaction that produced it. */
export async function completeKey(
  input: { id: string; status: number; snapshot: BidResponseSnapshot },
  tx: Tx,
): Promise<void> {
  await tx.query(
    `UPDATE idempotency_keys
        SET state = 'completed', response_status = $2, response_body = $3::jsonb,
            completed_at = now()
      WHERE id = $1`,
    [input.id, input.status, JSON.stringify(input.snapshot)],
  );
}
