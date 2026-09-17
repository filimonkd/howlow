import type { AuctionOutcome, AuctionStatus, ResultEvent } from '@howlow/shared';
import { ALGORITHM_LUB_V1 } from '@howlow/shared';
import { withTransaction, type Tx } from '../../db/index.js';
import { publishResultEvents } from '../../events/index.js';
import { getLogger, writeAuditLog, type OperationContext } from '../../shared/index.js';
import { beginCalculating, complete, lockForClosing, type AuctionRecord } from '../auctions/index.js';
import { releaseUnit } from '../catalog/index.js';
import { createWinnerOrder, type OrderRecord } from '../orders/index.js';
import { checksumFrozenBids } from './checksum.js';
import { auctionNotClosed, resultNotFound } from './errors.js';
import { calculateLubV1, countFrozenBids, type FrozenStatistics } from './lubCalculator.js';
import { refundParticipationFees } from './refunds.js';
import * as repo from './resultsRepository.js';
import type { CloseOutcome, ResultRecord } from './types.js';

/**
 * The auction closing service. **The only thing in HOWLOW that decides an
 * auction.**
 *
 * ## The sequence
 *
 * `closeAuction` runs two transactions and then a refund pass:
 *
 *   T1  lock the auction · `closing → calculating` · commit
 *   T2  lock the auction · count the frozen set · checksum it · run LUB_V1
 *       · insert the result · create the winner's order **or** release the
 *       unit · audit · `calculating → completed` · commit
 *   T3+ refund participation fees, one wallet per transaction
 *
 * Then, after everything is durable, publish the result events.
 *
 * ### Why two transactions and not one
 *
 * T2 is the atomic decision: the result row, the winner's order or the
 * released unit, and the auction reaching `completed` all commit together or
 * none of them do. Splitting any of that would allow an auction with a winner
 * and no order, which is a promise nobody is holding.
 *
 * T1 is separate so that `calculating` is a state that actually exists in the
 * database. An auction sitting in `calculating` is an auction whose closing
 * was interrupted — a visible alarm, and one a retry resumes from. Folded into
 * T2, `calculating` would never be observed and an interrupted close would be
 * indistinguishable from one that had not started.
 *
 * ### Why the refunds are not in T2
 *
 * See `refunds.ts`. Briefly: each refund takes a wallet lock, and holding the
 * auction lock across N of them is how a pool deadlocks. The split is made
 * safe by a deterministic idempotency key per participant and a ledger-driven
 * recovery query, not by hoping.
 *
 * ## Idempotency, and where it actually lives
 *
 * Running this twice must not produce two winners, two orders or two refunds.
 * Three mechanisms, and **none of them is in the worker or in Redis**:
 *
 *   * the auction row lock, which serialises two concurrent attempts so the
 *     second reads what the first committed;
 *   * `auction_results_auction_id_key`, a unique index, which is the thing
 *     that makes a second result impossible even if the lock were somehow
 *     bypassed — and which returns the first result so the caller reports the
 *     decision that was actually published;
 *   * `orders_auction_id_key` and the wallet's entry-level idempotency, which
 *     do the same for the order and for each refund.
 *
 * BullMQ job uniqueness is a convenience that keeps duplicate work off the
 * queue. It is not a correctness mechanism, it is not relied on here, and
 * PostgreSQL protects the final state on its own.
 *
 * A replay **recomputes** the winner and then discards its own answer in
 * favour of the stored one. That is deliberate: the recomputation costs one
 * query and proves nothing, while using it would be a recalculation, and the
 * winner of a decided auction never changes.
 *
 * ## The trust rule
 *
 * Once a result is committed, the winner is the winner. There is no path in
 * this module — or anywhere else — that recalculates a decided auction,
 * reassigns the win to the second-lowest unique bid, or edits
 * `auction_results`. A winner who never pays loses their order, not their win;
 * what happens to the item then is a later phase's decision and it is not made
 * by changing history.
 */

/** Above this many losing participants, the addressed fan-out is skipped. */
const NOT_WON_FANOUT_LIMIT = 1000;

/**
 * Close one auction and decide it.
 *
 * Expects an auction that has stopped taking bids: `closing` (the normal
 * case), `calculating` (a resumed close), `completed` (already decided — a
 * no-op that reports the existing result) or `cancelled`. A `live` auction is
 * **refused**, because a winner computed from a set that can still grow is not
 * a winner. Moving `live → closing` belongs to the lifecycle's `close()`, and
 * the worker calls that first.
 */
export async function closeAuction(input: {
  auctionId: string;
  context?: OperationContext | undefined;
}): Promise<CloseOutcome> {
  // T1: freeze is already in force (bidding requires `live`); this records that
  // the frozen set is being counted, and makes the interruption visible.
  const prepared = await withTransaction(async (tx) => {
    const auction = await loadClosable(input.auctionId, tx);

    if (auction.status === 'closing') {
      await beginCalculating(
        { auctionId: auction.id, ...(input.context === undefined ? {} : { context: input.context }) },
        tx,
      );
      return { auction, proceed: true as const };
    }
    return { auction, proceed: auction.status !== 'completed' };
  });

  // Already decided: report the published result and touch nothing. The refund
  // pass is still run, because a previous attempt may have been interrupted
  // between the decision and the money.
  if (!prepared.proceed) {
    const existing = await repo.findResult(input.auctionId);
    if (!existing) {
      // `completed` without a result would mean something completed an auction
      // outside this service. Loud, not patched over.
      throw resultNotFound(input.auctionId);
    }
    await settleMoney({ result: existing, context: input.context });
    return describe({ result: existing, auction: prepared.auction, decided: false });
  }

  // T2: the atomic decision.
  const decision = await withTransaction(async (tx) => decide({ ...input, tx }));

  // T3+: money, outside the auction lock and idempotent per participant.
  await settleMoney({ result: decision.result, context: input.context });

  // Fan-out last, after everything is durable and committed.
  await publishResultEvents(await resultEvents(decision));

  return describe({
    result: decision.result,
    auction: decision.auction,
    order: decision.order,
    decided: decision.inserted,
  });
}

/**
 * Load the auction and refuse the states a result may not be computed from.
 *
 * **This is the "no calculation before the auction has ended" invariant**, and
 * it is checked against the auction's status rather than against a clock: the
 * lifecycle's `close()` already compared the database clock to `ends_at`
 * before it wrote `closing`, so by the time an auction is past `live` the
 * comparison has been made by the one function that owns it. Re-reading the
 * clock here would be a second opinion about a decision already recorded.
 */
async function loadClosable(auctionId: string, tx: Tx): Promise<AuctionRecord> {
  const auction = await lockForClosing(auctionId, tx);
  if (!auction) throw resultNotFound(auctionId);

  if (CLOSABLE_STATUSES.includes(auction.status)) return auction;
  throw auctionNotClosed(auctionId, auction.status);
}

/**
 * The statuses a result may be computed from.
 *
 * `closing` is the normal entry, `calculating` is a resumed close, `completed`
 * is an auction already decided, and `cancelled` records what the bid set
 * looked like when the auction was pulled. Everything else — `live` most of
 * all — is refused: a set that can still grow has no winner in it yet.
 */
const CLOSABLE_STATUSES: readonly AuctionStatus[] = ['closing', 'calculating', 'completed', 'cancelled'];

interface Decision {
  readonly auction: AuctionRecord;
  readonly result: ResultRecord;
  readonly order: OrderRecord | null;
  /** True when this call is the one that decided the auction. */
  readonly inserted: boolean;
}

/**
 * Count, checksum, decide, persist, and apply the consequences — all in one
 * transaction, under the auction lock.
 */
async function decide(input: {
  auctionId: string;
  context?: OperationContext | undefined;
  tx: Tx;
}): Promise<Decision> {
  const { tx } = input;
  const auction = await loadClosable(input.auctionId, tx);

  // Every figure below comes from the same snapshot of the same frozen set,
  // inside the same transaction: the statistics, the checksum and the winner
  // describe one bid set rather than three readings of a moving one.
  const statistics = await countFrozenBids(auction.id, tx);
  const frozenBidChecksum = await checksumFrozenBids(auction.id, tx);
  const winner = auction.status === 'cancelled' ? null : await calculateLubV1(auction.id, tx);

  const outcome = decideOutcome({ auction, statistics, winner: winner !== null });

  const { result, inserted } = await repo.insertResult(
    {
      auctionId: auction.id,
      outcome,
      winningBidId: winner?.bidId ?? null,
      winnerUserId: winner?.userId ?? null,
      winningAmountMinor: winner?.amountMinor ?? null,
      totalBids: statistics.totalBids,
      totalValidBids: statistics.totalValidBids,
      uniqueAmountCount: statistics.uniqueAmountCount,
      participantCount: statistics.participantCount,
      frozenBidChecksum,
    },
    tx,
  );

  // From here on, `result` is the authority — not `winner`. On a replay the
  // insert returned the stored row, and the consequences must follow the
  // decision that was published, never this attempt's recomputation.
  const order = await applyConsequences({ auction, result, context: input.context, tx });

  await auditDecision({ auction, result, statistics, inserted, context: input.context, tx });

  // A cancelled auction is already terminal. Its result is recorded — an
  // operator still needs to know what the bid set looked like when the
  // auction was pulled — but there is no status left to change.
  if (auction.status !== 'cancelled') {
    await complete(
      {
        auctionId: auction.id,
        ...(input.context === undefined ? {} : { context: input.context }),
        details: {
          outcome: result.outcome,
          resultId: result.id,
          algorithmVersion: result.algorithmVersion,
        },
      },
      tx,
    );
  }

  return { auction, result, order, inserted };
}

/**
 * Which of the four outcomes this auction had.
 *
 * The order of the tests matters and is the product rule restated:
 *
 *   * a cancelled auction is `cancelled` whatever its bids looked like;
 *   * a winner means `winner`;
 *   * **no winner but bids exist** means `no_unique_bid` — every amount was
 *     chosen by two or more bidders, so the lowest bid did *not* win by
 *     default and nobody won at all;
 *   * no valid bids at all means `no_bids`.
 *
 * `no_unique_bid` and `no_bids` are kept apart because their consequences
 * differ: one has fees to return and the other has none, and inferring which
 * from `total_valid_bids = 0` at read time would be reading a fact back out of
 * a statistic.
 */
function decideOutcome(input: {
  auction: AuctionRecord;
  statistics: FrozenStatistics;
  winner: boolean;
}): AuctionOutcome {
  if (input.auction.status === 'cancelled') return 'cancelled';
  if (input.winner) return 'winner';
  return input.statistics.totalValidBids === 0 ? 'no_bids' : 'no_unique_bid';
}

/**
 * The business effects of the decision, inside the closing transaction.
 *
 * **Inventory.** A `winner` auction *keeps* its reservation: the unit is owed
 * to the winner, and releasing it would let another auction sell the thing
 * this one just promised. Every other outcome releases it, because an item
 * nobody won must go back on the shelf. `releaseUnit` is idempotent — it looks
 * for a *held* reservation and returns `released: false` when there is none —
 * so a replay cannot double-release, and stock cannot go negative.
 *
 * **The order.** Created only for a `winner`, from the stored result's winner
 * and winning amount, with `status = pending_payment` and a deadline of
 * `winner_payment_hours` from now. The winner's wallet is **not** charged and
 * no payment is initiated: that is Phase 7, and it must not be able to change
 * who won.
 */
async function applyConsequences(input: {
  auction: AuctionRecord;
  result: ResultRecord;
  context?: OperationContext | undefined;
  tx: Tx;
}): Promise<OrderRecord | null> {
  const { auction, result, tx } = input;

  if (result.outcome !== 'winner') {
    await releaseUnit(
      {
        auctionId: auction.id,
        reason: releaseReason(result.outcome),
        ...(input.context === undefined ? {} : { context: input.context }),
      },
      tx,
    );
    return null;
  }

  // `auction_results_winner_matches_outcome` guarantees these are set for a
  // `winner` row; the guards keep this total rather than asserting.
  if (result.winnerUserId === null || result.winningAmountMinor === null) {
    throw resultNotFound(auction.id);
  }

  const { order } = await createWinnerOrder(
    {
      auctionId: auction.id,
      winnerUserId: result.winnerUserId,
      sellerId: auction.sellerId,
      productId: auction.productId,
      currency: auction.currency,
      winningAmountMinor: result.winningAmountMinor,
      paymentWindowHours: auction.winnerPaymentHours,
      ...(input.context === undefined ? {} : { context: input.context }),
    },
    tx,
  );
  return order;
}

function releaseReason(outcome: AuctionOutcome): string {
  switch (outcome) {
    case 'no_unique_bid':
      return 'Auction closed with no unique bid: no winner, unit returned to stock';
    case 'no_bids':
      return 'Auction closed with no bids: unit returned to stock';
    case 'cancelled':
      return 'Auction cancelled: unit returned to stock';
    case 'winner':
      // Unreachable: a winning auction keeps its reservation and never calls
      // this. Present so the switch stays exhaustive if an outcome is added.
      return 'Auction won: unit retained for the winner';
  }
}

/**
 * The result audit trail.
 *
 * Written only by the call that decided the auction. A replay records nothing,
 * because it did nothing, and an audit log with two `result_calculated` rows
 * for one auction would suggest an auction had been decided twice — which is
 * precisely the thing the reader of an audit log is checking for.
 *
 * The statistics and the checksum are in the row, so the audit trail alone
 * answers "what was this decided from" without joining to a result that a
 * reader may be trying to verify.
 */
async function auditDecision(input: {
  auction: AuctionRecord;
  result: ResultRecord;
  statistics: FrozenStatistics;
  inserted: boolean;
  context?: OperationContext | undefined;
  tx: Tx;
}): Promise<void> {
  if (!input.inserted) return;

  const { auction, result, statistics } = input;
  const base = {
    entityType: 'auction',
    entityId: auction.id,
    actorUserId: input.context?.actorUserId,
    channel: input.context?.channel ?? ('system' as const),
    requestId: input.context?.requestId,
  };

  await writeAuditLog(
    {
      ...base,
      action: 'auction.result_calculated',
      details: {
        outcome: result.outcome,
        resultId: result.id,
        algorithmVersion: result.algorithmVersion,
        winningAmountMinor: result.winningAmountMinor?.toString() ?? null,
        frozenBidChecksum: result.frozenBidChecksum,
        totalBids: statistics.totalBids,
        totalValidBids: statistics.totalValidBids,
        participantCount: statistics.participantCount,
        uniqueAmountCount: statistics.uniqueAmountCount,
      },
    },
    input.tx,
  );

  // A second, outcome-specific row. Worth the duplication: "show me every
  // auction that ended with no unique bid" is an operational question, and it
  // should not require filtering the details of a generic row.
  const outcomeAction = {
    winner: 'auction.winner_created',
    no_unique_bid: 'auction.no_unique_bid',
    no_bids: 'auction.no_bids',
    cancelled: 'auction.cancelled_result_recorded',
  }[result.outcome];

  await writeAuditLog(
    {
      ...base,
      action: outcomeAction,
      details: {
        resultId: result.id,
        // The winner's identity belongs in the audit trail: it is the record
        // of who was awarded what, which is exactly what an audit trail is
        // for. It is not on any public surface.
        winnerUserId: result.winnerUserId,
        winningBidId: result.winningBidId,
        winningAmountMinor: result.winningAmountMinor?.toString() ?? null,
        currency: auction.currency,
      },
    },
    input.tx,
  );
}

/**
 * Return whatever fees the outcome owes back.
 *
 * Called for a fresh decision and for a replay alike, because the interesting
 * failure is a crash between the decision and the money: the auction is
 * correctly decided and somebody has not been paid back. Re-running is free
 * when there is nothing to do.
 *
 * A refund failure does **not** fail the close. The auction is decided and
 * committed; reporting the close as failed would invite a retry of work that
 * is already done, and the refund sweep exists precisely to finish this.
 */
async function settleMoney(input: {
  result: ResultRecord;
  context?: OperationContext | undefined;
}): Promise<void> {
  if (input.result.outcome === 'winner' || input.result.outcome === 'no_bids') return;

  try {
    await refundParticipationFees({
      auctionId: input.result.auctionId,
      ...(input.context === undefined ? {} : { context: input.context }),
    });
  } catch (error) {
    getLogger().error(
      { err: error, auctionId: input.result.auctionId, outcome: input.result.outcome },
      'Participation fees could not be refunded; the result is committed and the sweep will retry',
    );
  }
}

/**
 * The events one decision produces.
 *
 * `AUCTION_RESULT_READY` is auction-wide and carries no user. The addressed
 * events name exactly one user each: `AUCTION_WON` for the winner, and
 * `AUCTION_NOT_WON` for each other participant of a winning auction.
 *
 * The loser fan-out is bounded. Above `NOT_WON_FANOUT_LIMIT` participants the
 * addressed events are skipped and logged: a per-user publish loop is the
 * wrong shape at that size, the auction-wide event is enough for a client to
 * ask for its own outcome, and building a proper outbox belongs to the
 * notification phase rather than here.
 */
async function resultEvents(decision: Decision): Promise<readonly ResultEvent[]> {
  const { auction, result } = decision;
  const occurredAt = new Date().toISOString();
  const common = {
    auctionId: auction.id,
    outcome: result.outcome,
    winningAmountMinor: result.winningAmountMinor?.toString() ?? null,
    currency: auction.currency,
    occurredAt,
  };

  const events: ResultEvent[] = [{ event: 'AUCTION_RESULT_READY', ...common }];

  if (result.outcome === 'no_unique_bid') events.push({ event: 'AUCTION_NO_UNIQUE_BID', ...common });
  if (result.outcome === 'no_bids') events.push({ event: 'AUCTION_NO_BIDS', ...common });

  if (result.outcome !== 'winner' || result.winnerUserId === null) return events;

  events.push({ event: 'AUCTION_WON', ...common, userId: result.winnerUserId });

  const payers = await repo.listFeePayers(auction.id);
  const losers = payers.filter((payer) => payer.userId !== result.winnerUserId);
  if (losers.length > NOT_WON_FANOUT_LIMIT) {
    getLogger().warn(
      { auctionId: auction.id, losers: losers.length, limit: NOT_WON_FANOUT_LIMIT },
      'Addressed AUCTION_NOT_WON events skipped: too many participants for a publish loop',
    );
    return events;
  }
  for (const loser of losers) {
    events.push({ event: 'AUCTION_NOT_WON', ...common, userId: loser.userId });
  }
  return events;
}

function describe(input: {
  result: ResultRecord;
  auction: AuctionRecord;
  order?: OrderRecord | null | undefined;
  decided: boolean;
}): CloseOutcome {
  return {
    auctionId: input.result.auctionId,
    outcome: input.result.outcome,
    currency: input.auction.currency,
    winningAmountMinor: input.result.winningAmountMinor,
    winnerUserId: input.result.winnerUserId,
    orderId: input.order?.id ?? null,
    decided: input.decided,
    result: input.result,
  };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface VerificationReport {
  readonly auctionId: string;
  /** True when every stored fact still matches a recomputation. */
  readonly ok: boolean;
  readonly algorithmVersion: string;
  readonly storedChecksum: string;
  readonly recomputedChecksum: string;
  readonly storedWinningBidId: string | null;
  readonly recomputedWinningBidId: string | null;
  readonly storedWinningAmountMinor: bigint | null;
  readonly recomputedWinningAmountMinor: bigint | null;
  readonly storedStatistics: FrozenStatistics;
  readonly recomputedStatistics: FrozenStatistics;
  /** Human-readable descriptions of each disagreement found. */
  readonly mismatches: readonly string[];
}

/**
 * Recompute a published result and report whether it still holds.
 *
 * This is what makes a result *evidence* rather than an assertion. Same bids →
 * same checksum → same winner. A bid voided, inserted or altered after the
 * close changes the digest, and this reports the mismatch instead of quietly
 * producing a different answer.
 *
 * It **never writes**. A failed verification is a finding to investigate, not
 * a result to correct: correcting it would mean changing who won an auction
 * after the fact, which is the one thing this whole phase exists to make
 * impossible. `auction_results` is append-only in the database as well, so
 * there is nothing here that could try.
 *
 * Reads outside a transaction by default, which is right for an
 * investigation — it asks what is true *now*, and "now differs from the close"
 * is exactly the answer wanted.
 */
export async function verifyResult(auctionId: string, tx?: Tx): Promise<VerificationReport> {
  const stored = await repo.findResult(auctionId, tx);
  if (!stored) throw resultNotFound(auctionId);

  const recomputedChecksum = await checksumFrozenBids(auctionId, tx);
  const recomputedStatistics = await countFrozenBids(auctionId, tx);
  const recomputedWinner = stored.outcome === 'cancelled' ? null : await calculateLubV1(auctionId, tx);

  const storedStatistics: FrozenStatistics = {
    totalBids: stored.totalBids,
    totalValidBids: stored.totalValidBids,
    participantCount: stored.participantCount,
    uniqueAmountCount: stored.uniqueAmountCount,
  };

  const mismatches: string[] = [];
  if (stored.frozenBidChecksum !== recomputedChecksum) {
    mismatches.push(
      `checksum: stored ${stored.frozenBidChecksum}, recomputed ${recomputedChecksum} — the valid bid set has changed since the close`,
    );
  }
  if ((recomputedWinner?.bidId ?? null) !== stored.winningBidId) {
    mismatches.push(
      `winning bid: stored ${stored.winningBidId ?? 'none'}, recomputed ${recomputedWinner?.bidId ?? 'none'}`,
    );
  }
  if ((recomputedWinner?.amountMinor ?? null) !== stored.winningAmountMinor) {
    mismatches.push(
      `winning amount: stored ${stored.winningAmountMinor?.toString() ?? 'none'}, recomputed ${recomputedWinner?.amountMinor.toString() ?? 'none'}`,
    );
  }
  for (const [key, storedValue] of Object.entries(storedStatistics)) {
    const recomputedValue = recomputedStatistics[key as keyof FrozenStatistics];
    if (storedValue !== recomputedValue) {
      mismatches.push(`${key}: stored ${String(storedValue)}, recomputed ${String(recomputedValue)}`);
    }
  }
  if (stored.algorithmVersion !== ALGORITHM_LUB_V1) {
    mismatches.push(`algorithm: stored ${stored.algorithmVersion}, expected ${ALGORITHM_LUB_V1}`);
  }

  return {
    auctionId,
    ok: mismatches.length === 0,
    algorithmVersion: stored.algorithmVersion,
    storedChecksum: stored.frozenBidChecksum,
    recomputedChecksum,
    storedWinningBidId: stored.winningBidId,
    recomputedWinningBidId: recomputedWinner?.bidId ?? null,
    storedWinningAmountMinor: stored.winningAmountMinor,
    recomputedWinningAmountMinor: recomputedWinner?.amountMinor ?? null,
    storedStatistics,
    recomputedStatistics,
    mismatches,
  };
}
