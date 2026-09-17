import {
  AppError,
  type BidDto,
  type Channel,
  type Currency,
  type MyBidsDto,
  type SubmitBidsResult,
} from '@howlow/shared';
import { withTransaction, type Tx } from '../../db/index.js';
import { publishAuctionStats } from '../../events/index.js';
import { writeAuditLog, type OperationContext } from '../../shared/index.js';
import { enforceRateLimit, getPublicUser } from '../auth/index.js';
import * as auctions from '../auctions/index.js';
import type { AuctionRecord } from '../auctions/index.js';
import { findHeldReservation } from '../catalog/index.js';
import * as wallet from '../wallet/index.js';
import * as repo from './bidRepository.js';
import { UNIQUE_VIOLATION } from './bidRepository.js';
import {
  auctionEnded,
  auctionNotLive,
  auctionNotStarted,
  bidLimitExceeded,
  bidderNotEligible,
  asBidWalletError,
  duplicateAmount,
  duplicateAmountUnknown,
} from './errors.js';
import * as idempotency from './idempotency.js';
import type { BidAllowance, BidRecord, SubmitBidsInput, SubmitBidsOutcome } from './types.js';
import { assertAmountsAllowed, assertNoRepeats, parseAmounts, totalFee } from './validation.js';

/**
 * # The bidding engine
 *
 * There is exactly one way to place a bid on HOWLOW, and this is it. The HTTP
 * controller and the Telegram handler both call `submitBids`; neither writes
 * SQL, charges a wallet, counts a bid or decides whether an auction is open.
 * Two implementations would eventually disagree, and the thing they would
 * disagree about is people's money.
 *
 * ## Lock ordering — auction → product → wallet → participant
 *
 * The platform's lock order was set in Phase 3 and Phase 4, and this module
 * honours it exactly:
 *
 *   1. **auction** — `auctions.lockForBidding`. The serialisation point. Every
 *      lifecycle transition takes this lock first too, which is what makes the
 *      rest of this list safe.
 *   2. **product / inventory** — read, not locked. See `assertDeliverable`.
 *   3. **wallet** — taken inside `walletService.debit`, which locks the wallet
 *      row by primary key.
 *   4. **participant** — `lockOrCreateParticipant`.
 *
 * The order is the whole deadlock argument. A bid holds the auction row and
 * then asks for a wallet; a lifecycle transition holds the auction row and
 * then asks for a product. Nothing in the platform asks for them the other way
 * round, so no two transactions can each hold what the other wants. Acquiring
 * a wallet lock before the auction lock anywhere — in this module or a future
 * one — reintroduces the cycle.
 *
 * Participant is taken after wallet in the *list* but before the debit in the
 * *code*: both are leaves in the order, they are never contended against each
 * other by a third party, and the limit has to be known before money moves.
 * What matters is that neither is ever taken before the auction.
 *
 * ## What the engine never does
 *
 * It does not branch on `channel` — not once. It does not tell anyone whether
 * an amount is unique, or how many bidders hold one. It does not calculate a
 * winner: the engine ends at "these bids are accepted", and Phase 6 decides
 * what they mean.
 */

const BID_SCOPE_PREFIX = 'bid_fee';

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

/**
 * Place one or more bids, atomically.
 *
 * Either every amount in the request is accepted and charged for, or nothing
 * happens at all. There is no partial batch: a client that asked for four
 * amounts and got three could not tell which three without re-reading, and
 * would have been charged for a submission it did not make.
 */
export async function submitBids(
  input: SubmitBidsInput,
  context?: OperationContext,
): Promise<SubmitBidsOutcome> {
  // --- Cheap checks first, outside the transaction ------------------------
  //
  // Everything here is re-checked under the lock where it matters. The point
  // of doing it twice is to refuse a malformed or ineligible request without
  // taking the auction lock at all — in the last seconds of a popular auction
  // that lock is the most contended row in the platform.
  const amountsMinor = parseAmounts(input.amountsMinor);
  assertNoRepeats(amountsMinor);

  await assertBidderEligible(input.userId);

  // Resolved through the public path, so an auction the caller may not see is
  // NOT_FOUND rather than an error that confirms it exists.
  const auction = await auctions.getPublicAuction(input.auctionReference);
  assertAcceptingBids(auction, undefined);
  assertAmountsAllowed(amountsMinor, auction);

  await enforceBidRateLimits({
    userId: input.userId,
    auctionId: auction.id,
    ipAddress: input.ipAddress,
  });

  // --- The transaction ----------------------------------------------------
  const outcome = await withTransaction(async (tx) => {
    // 1. The key, before any row lock. A concurrent duplicate queues here
    //    holding nothing; see idempotency.ts.
    const requestHash = idempotency.bidRequestHash({
      auctionId: auction.id,
      userId: input.userId,
      amountsMinor,
    });
    const claim = await idempotency.claimKey(
      { key: input.idempotencyKey, userId: input.userId, requestHash },
      tx,
    );
    if (claim.outcome === 'replay') {
      return replayOutcome(claim.snapshot, auction, input, tx);
    }

    // 2. The auction, locked. From here nothing else can transition it.
    const locked = await auctions.lockForBidding(auction.id, tx);
    if (!locked) throw new AppError({ code: 'NOT_FOUND', message: `Auction ${auction.id} disappeared` });

    // 3. Authoritative state and time, under the lock.
    const now = await lockedNow(tx);
    assertAcceptingBids(locked, now);

    // 4. The terms as the locked row states them, not as they were read a
    //    moment ago. A live auction's terms are immutable, so this cannot
    //    differ today — it is checked anyway, because relying on that
    //    invariant silently is how it stops being true.
    assertAmountsAllowed(amountsMinor, locked);

    // 5. The auction must still be able to deliver what it is selling.
    await assertDeliverable(locked);

    // 6. The participant row, locked. The bid limit is decided here.
    const { participant, inserted } = await repo.lockOrCreateParticipant(
      { auctionId: locked.id, userId: input.userId, channel: input.channel },
      tx,
    );
    if (participant.bidCount + amountsMinor.length > locked.maxBidsPerUser) {
      throw bidLimitExceeded(participant.bidCount, amountsMinor.length, locked.maxBidsPerUser);
    }

    // 7. A courtesy read, so the common duplicate gets a message naming the
    //    amounts. The rule is the unique index, checked at step 8.
    const alreadyHeld = await repo.findExistingAmounts(
      { auctionId: locked.id, userId: input.userId, amountsMinor },
      tx,
    );
    if (alreadyHeld.length > 0) throw duplicateAmount(alreadyHeld);

    // 8. Insert the batch in one statement. **This is the duplicate rule.**
    //    Fewer rows back than amounts asked for means the unique index
    //    rejected something, and the whole transaction is abandoned.
    const bids = await insertBatch({ auction: locked, input, amountsMinor, tx });

    // 9. The fee, in this transaction, under the wallet's own lock.
    const feeMinor = totalFee(locked.bidFeeMinor, bids.length);
    const { balanceMinor } = await chargeFee({ auction: locked, input, bids, feeMinor, context, tx });

    // 10. Counters. Participant first, then the auction — both under locks we
    //     already hold.
    const updatedParticipant = await repo.addParticipantBids(
      { participantId: participant.id, addedBids: bids.length, addedFeesMinor: feeMinor },
      tx,
    );
    const auctionTotals = await auctions.addBidCounters(
      { id: locked.id, addedBids: bids.length, addedParticipants: inserted ? 1 : 0 },
      tx,
    );

    // 11. Evidence. Deliberately without the amounts: `writeAuditLog` also
    //     emits a log line, and a user's ladder in the application log would
    //     be their whole strategy sitting in a log aggregator. The amounts are
    //     in `bids`, which is where they belong.
    await writeAuditLog(
      {
        action: 'bid.submitted',
        entityType: 'auction',
        entityId: locked.id,
        actorUserId: input.userId,
        channel: input.channel,
        details: {
          bidCount: bids.length,
          feeMinor: feeMinor.toString(),
          currency: locked.currency,
          bidCountAfter: updatedParticipant.bidCount,
          firstBid: inserted,
        },
        ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
        ...(input.ipAddress !== undefined ? { ipAddress: input.ipAddress } : {}),
      },
      tx,
    );

    const result: SubmitBidsOutcome = {
      auctionId: locked.id,
      bids,
      totalFeeMinor: feeMinor,
      currency: locked.currency,
      bidCount: updatedParticipant.bidCount,
      bidsRemaining: Math.max(0, locked.maxBidsPerUser - updatedParticipant.bidCount),
      walletBalanceMinor: balanceMinor,
      replayed: false,
      submittedAt: now,
      auctionTotals,
    };

    // 12. The stored answer, so a retry returns these numbers and not today's.
    await idempotency.completeKey({ id: claim.id, status: 201, snapshot: snapshotOf(result) }, tx);

    return result;
  });

  // --- After the commit ---------------------------------------------------
  //
  // Counts only, and only once the bids are durable. Publishing before the
  // commit would announce bids that might roll back; publishing amounts would
  // hand every listener the uniqueness signal the auction withholds.
  if (!outcome.replayed) {
    await publishAuctionStats({
      event: 'AUCTION_STATS',
      auctionId: outcome.auctionId,
      totalBids: outcome.auctionTotals.totalBids,
      totalParticipants: outcome.auctionTotals.totalParticipants,
      serverTime: outcome.submittedAt.toISOString(),
    });
  }

  return outcome;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Who may bid.
 *
 * A suspended account and an unverified phone are both refusals, and both are
 * cheap to check before any lock. Note what is *not* here: no channel check,
 * and no seller exclusion — whether a seller may bid on their own auction is a
 * policy question the specification does not settle, and inventing an answer
 * here would be inventing product.
 */
async function assertBidderEligible(userId: string): Promise<void> {
  const user = await getPublicUser(userId);
  if (user.status !== 'active') {
    throw bidderNotEligible(userId, 'Your account cannot place bids at the moment.');
  }
  if (!user.phoneVerified) {
    throw bidderNotEligible(userId, 'Verify your phone number before bidding.');
  }
}

/**
 * The auction accepts bids right now.
 *
 * Two independent conditions, because they fail for different reasons and a
 * bidder needs to know which: the status says whether bidding is open at all,
 * and the clock says whether this instant is inside the window. An auction
 * whose close job has not yet run is `live` with a past `ends_at`, and must
 * refuse — which is exactly why the time check does not trust the status.
 *
 * `now` is the database's clock, passed in rather than read here so the
 * pre-transaction pass can skip it. Never the client's: a browser or a
 * Telegram client with a fast clock decides nothing.
 */
function assertAcceptingBids(auction: AuctionRecord, now: Date | undefined): void {
  if (auction.status !== 'live') throw auctionNotLive(auction.id, auction.status);
  if (now === undefined) return;
  if (now < auction.startsAt) throw auctionNotStarted(auction.id, auction.startsAt);
  if (now >= auction.endsAt) throw auctionEnded(auction.id, auction.endsAt);
}

/**
 * The time the bid is being decided at.
 *
 * `clock_timestamp()`, not `now()`. `now()` is the transaction's start time,
 * so a request that queued behind a hundred others on the auction lock would
 * be judged against the moment it began waiting — and a bidder could hold a
 * transaction open across the deadline and still be accepted. This reads the
 * clock *after* the lock is held, so it is the moment the bid actually reached
 * the front of the queue. Strictly: a bid that arrives before `ends_at` but
 * waits past it is refused, and that is the honest answer.
 */
async function lockedNow(tx: Tx): Promise<Date> {
  const { rows } = await tx.query<{ at: Date }>('SELECT clock_timestamp() AS at');
  const row = rows[0];
  if (!row) throw new Error('database returned no clock reading');
  return row.at;
}

/**
 * The auction still holds its unit.
 *
 * Read, not locked, and that is a deliberate choice rather than an omission.
 * Phase 4 reserves one unit when the auction goes live, and the only things
 * that release it — cancel, and the close path — are lifecycle transitions,
 * every one of which takes the auction row lock as its first act. This code
 * runs holding that same lock, so no release can be in flight: the read is as
 * authoritative as a locked read would be.
 *
 * Locking the product row instead would serialise every bidder in the auction
 * behind one row for no correctness gain, and Phase 4's reservation is
 * idempotent and already made — re-reserving per bid would double-count
 * inventory, which the brief for this phase explicitly forbids.
 */
async function assertDeliverable(auction: AuctionRecord): Promise<void> {
  const reservation = await findHeldReservation(auction.id);
  if (!reservation) {
    // The auction is live with nothing reserved. That is an inconsistency, not
    // a user error: refusing the bid is the safe side, because the alternative
    // is taking money for something the platform cannot deliver.
    throw auctionNotLive(auction.id, 'unreserved');
  }
}

/** Insert the batch, and treat a short result as the duplicate rule firing. */
async function insertBatch(args: {
  auction: AuctionRecord;
  input: SubmitBidsInput;
  amountsMinor: readonly bigint[];
  tx: Tx;
}): Promise<BidRecord[]> {
  const { auction, input, amountsMinor, tx } = args;
  let bids: BidRecord[];
  try {
    bids = await repo.insertBids(
      {
        auctionId: auction.id,
        userId: input.userId,
        amountsMinor,
        feeMinor: auction.bidFeeMinor,
        channel: input.channel,
        idempotencyKey: input.idempotencyKey,
        requestId: input.requestId,
        ipAddress: input.ipAddress,
        deviceHash: input.deviceHash,
      },
      tx,
    );
  } catch (error) {
    // `ON CONFLICT DO NOTHING` swallows the conflicts it is told about, so a
    // unique violation here is one it was not: translated rather than allowed
    // to surface as a 500 with a constraint name in it.
    if (isUniqueViolation(error)) throw duplicateAmountUnknown();
    throw error;
  }

  if (bids.length !== amountsMinor.length) {
    // Between the courtesy read and this insert, a concurrent request of the
    // caller's own committed one of these amounts. The transaction is
    // abandoned whole: no bid, no fee, no counter.
    throw duplicateAmountUnknown();
  }
  return bids;
}

/**
 * Charge for the batch.
 *
 * Through `walletService.debit` with this transaction, never by touching
 * `wallets` — the balance and its ledger entry are written together or not at
 * all, and the module boundary is what guarantees it.
 *
 * A zero fee moves no money and writes no entry. `wallet_entries` records
 * movements, and a zero-value row would be a record of nothing; the schema
 * refuses it outright (`wallet_entries_amount_non_zero`). The balance still
 * comes back for the response, read without a lock.
 */
async function chargeFee(args: {
  auction: AuctionRecord;
  input: SubmitBidsInput;
  bids: readonly BidRecord[];
  feeMinor: bigint;
  context: OperationContext | undefined;
  tx: Tx;
}): Promise<{ balanceMinor: bigint }> {
  const { auction, input, bids, feeMinor, context, tx } = args;

  if (feeMinor === 0n) {
    const free = await wallet.getWallet(input.userId, auction.currency, tx);
    return { balanceMinor: free.availableMinor };
  }

  const movement = await debitOrTranslate(() =>
    wallet.debit(
      'bid_fee',
      {
        userId: input.userId,
        amountMinor: feeMinor,
        currency: auction.currency,
        referenceType: 'auction',
        referenceId: auction.id,
        memo: `${String(bids.length)} bid(s)`,
        // Namespaced: the wallet's key space spans every operation on a
        // wallet, so a client reusing one key for a bid and a deposit must
        // not collide.
        idempotencyKey: `${BID_SCOPE_PREFIX}:${input.idempotencyKey}`,
        actorUserId: input.userId,
        channel: input.channel,
        ...(context !== undefined ? { context } : {}),
      },
      tx,
    ),
  );

  // The bids exist before the entry does, because the wallet lock is taken
  // last; this is the back-reference, in the same transaction.
  await repo.attachWalletEntry({ bidIds: bids.map((bid) => bid.id), walletEntryId: movement.entryId }, tx);

  return { balanceMinor: movement.balanceAfterMinor };
}

/**
 * Run a wallet movement, restating its refusals in the bid vocabulary.
 *
 * Only the refusals a bidder can act on are translated; see
 * `asBidWalletError`. A non-wallet failure is not touched.
 */
async function debitOrTranslate<T>(movement: () => Promise<T>): Promise<T> {
  try {
    return await movement();
  } catch (error) {
    if (AppError.is(error)) throw asBidWalletError(error);
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === UNIQUE_VIOLATION;
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/**
 * Answer a retry with what the original request returned.
 *
 * The bid rows are re-read — they are the durable record — while the counts
 * and the balance come from the stored snapshot, so the retry sees the numbers
 * as they were rather than as they are now. A client that retried twice and
 * saw its balance drift would have no way to tell a replay from a second
 * charge.
 */
async function replayOutcome(
  snapshot: idempotency.BidResponseSnapshot,
  auction: AuctionRecord,
  input: SubmitBidsInput,
  tx: Tx,
): Promise<SubmitBidsOutcome> {
  const bids = await repo.findBidsByIdempotencyKey(
    { auctionId: auction.id, userId: input.userId, idempotencyKey: input.idempotencyKey },
    tx,
  );
  return {
    auctionId: auction.id,
    bids,
    totalFeeMinor: BigInt(snapshot.totalFeeMinor),
    currency: auction.currency,
    bidCount: snapshot.bidCount,
    bidsRemaining: snapshot.bidsRemaining,
    walletBalanceMinor: BigInt(snapshot.walletBalanceMinor),
    replayed: true,
    submittedAt: new Date(snapshot.submittedAt),
    auctionTotals: {
      totalBids: snapshot.totalBids,
      totalParticipants: snapshot.totalParticipants,
    },
  };
}

function snapshotOf(result: SubmitBidsOutcome): idempotency.BidResponseSnapshot {
  return {
    bidIds: result.bids.map((bid) => bid.id),
    totalFeeMinor: result.totalFeeMinor.toString(),
    bidCount: result.bidCount,
    bidsRemaining: result.bidsRemaining,
    walletBalanceMinor: result.walletBalanceMinor.toString(),
    submittedAt: result.submittedAt.toISOString(),
    totalBids: result.auctionTotals.totalBids,
    totalParticipants: result.auctionTotals.totalParticipants,
  };
}

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

/**
 * Four dimensions, all before the transaction.
 *
 * None of them stands in for the auction's `max_bids_per_user`: that is a
 * durable rule enforced against the participant row inside the transaction,
 * and a Redis counter — which may be lost on a restart and fails open — could
 * never be trusted with it. These bound abuse and protect the auction row from
 * a stampede.
 */
async function enforceBidRateLimits(input: {
  userId: string;
  auctionId: string;
  ipAddress: string | undefined;
}): Promise<void> {
  await enforceRateLimit('bidSubmit', input.userId);
  await enforceRateLimit('bidSubmitPerAuction', `${input.auctionId}:${input.userId}`);
  await enforceRateLimit('bidSubmitPerAuctionGlobal', input.auctionId);
  if (input.ipAddress !== undefined) {
    await enforceRateLimit('bidSubmitPerIp', input.ipAddress);
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The caller's own bids in one auction.
 *
 * Only ever the caller's own: there is no read anywhere in this module that
 * returns another user's bids, or a count of who holds an amount. The bid
 * entry UI needs to know what you have bid and how many you have left, and
 * nothing else exists to ask for.
 */
export async function getMyBids(input: {
  userId: string;
  auctionReference: string;
}): Promise<BidAllowance & { bids: BidRecord[] }> {
  const auction = await auctions.getPublicAuction(input.auctionReference);
  const [bids, participant] = await Promise.all([
    repo.listUserBids({ auctionId: auction.id, userId: input.userId }),
    repo.findParticipant({ auctionId: auction.id, userId: input.userId }),
  ]);
  const bidCount = participant?.bidCount ?? 0;
  return {
    auctionId: auction.id,
    bids,
    bidCount,
    maxBidsPerUser: auction.maxBidsPerUser,
    bidsRemaining: Math.max(0, auction.maxBidsPerUser - bidCount),
    totalFeesMinor: participant?.totalFeesMinor ?? 0n,
    currency: auction.currency,
  };
}

/** What the caller may still do, without listing the bids themselves. */
export async function getAllowance(input: { userId: string; auctionId: string }): Promise<BidAllowance> {
  const auction = await auctions.getAuction(input.auctionId);
  const participant = await repo.findParticipant({
    auctionId: input.auctionId,
    userId: input.userId,
  });
  const bidCount = participant?.bidCount ?? 0;
  return {
    auctionId: input.auctionId,
    bidCount,
    maxBidsPerUser: auction.maxBidsPerUser,
    bidsRemaining: Math.max(0, auction.maxBidsPerUser - bidCount),
    totalFeesMinor: participant?.totalFeesMinor ?? 0n,
    currency: auction.currency,
  };
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/**
 * A bid, as its owner sees it.
 *
 * `status` is mapped, not passed through: the database's `valid` becomes
 * `submitted`, which is the only thing a bidder is told before the auction
 * closes. Nothing here says whether the amount is unique, and nothing may be
 * added that does — Phase 6 turns these into `won` and `not_winning`.
 */
export function toBidDto(bid: BidRecord, currency: Currency): BidDto {
  return {
    id: bid.id,
    amountMinor: bid.amountMinor.toString(),
    feeMinor: bid.feeMinor.toString(),
    currency,
    channel: bid.channel,
    status: bid.status === 'valid' ? 'submitted' : bid.status,
    submittedAt: bid.createdAt.toISOString(),
  };
}

export function toSubmitResultDto(outcome: SubmitBidsOutcome): SubmitBidsResult {
  return {
    auctionId: outcome.auctionId,
    bids: outcome.bids.map((bid) => toBidDto(bid, outcome.currency)),
    totalFeeMinor: outcome.totalFeeMinor.toString(),
    currency: outcome.currency,
    bidCount: outcome.bidCount,
    bidsRemaining: outcome.bidsRemaining,
    walletBalanceMinor: outcome.walletBalanceMinor.toString(),
    replayed: outcome.replayed,
    submittedAt: outcome.submittedAt.toISOString(),
  };
}

export function toMyBidsDto(result: BidAllowance & { bids: BidRecord[] }): MyBidsDto {
  return {
    auctionId: result.auctionId,
    bids: result.bids.map((bid) => toBidDto(bid, result.currency)),
    bidCount: result.bidCount,
    maxBidsPerUser: result.maxBidsPerUser,
    bidsRemaining: result.bidsRemaining,
    totalFeesMinor: result.totalFeesMinor.toString(),
    currency: result.currency,
  };
}

export type { Channel };
