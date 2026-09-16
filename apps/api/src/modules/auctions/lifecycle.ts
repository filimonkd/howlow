import type { AuctionEvent, AuctionStatus, Role } from '@howlow/shared';
import { withTransaction, type Tx } from '../../db/index.js';
import { publishAuctionEvent } from '../../events/index.js';
import { writeAuditLog, type OperationContext } from '../../shared/index.js';
import { hasAnyRole, loadRoles } from '../auth/rbac.js';
import { releaseUnit, reserveUnit } from '../catalog/index.js';
import { CATALOG_ERRORS } from '../catalog/index.js';
import {
  auctionNotDue,
  auctionNotFound,
  auctionNotOwned,
  invalidTransition,
  unauthorizedAuctionOperation,
} from './errors.js';
import * as repo from './auctionRepository.js';
import {
  allowedFrom,
  canTransition,
  holdsInventory,
  targetOf,
  type AuctionAction,
} from './transitions.js';
import type { AuctionRecord } from './types.js';

/**
 * The auction lifecycle service.
 *
 * **Every status change in HOWLOW goes through a function in this file**, and
 * each one consults the transition table in `transitions.ts`. No controller,
 * Telegram handler or worker sets a status directly, so "DRAFT → LIVE must be
 * rejected" is a property of one table rather than a check each caller has to
 * remember.
 *
 * ## Locking
 *
 * Every transition takes exactly one lock to begin with: `SELECT ... FOR
 * UPDATE` on the auction row. That is what makes a transition idempotent under
 * concurrency — two workers that both try to open the same auction queue on the
 * row, and the second reads the status the first committed.
 *
 * The platform's lock order is
 *
 *     auction → product → wallet
 *
 * `open` and the inventory-releasing paths take the product lock *while
 * holding* the auction lock, which is why the order is written that way.
 * Phase 4 never takes a wallet lock. Phase 5's bidding transaction will lock
 * the auction and then the bidder's wallet, which sits inside the same order,
 * so the two cannot deadlock against each other.
 *
 * ## Events
 *
 * Lifecycle events are published *after* the transaction commits, never inside
 * it: `withTransaction` may retry its callback, and a retried publish would
 * announce a transition twice. The durable record is the audit row written
 * inside the transaction.
 */

/** Roles that may review, approve, suspend or cancel someone else's auction. */
const AUCTION_STAFF: readonly Role[] = ['auction_manager', 'admin'];

async function assertStaff(actorUserId: string, operation: string): Promise<void> {
  const roles = await loadRoles(actorUserId);
  if (!hasAnyRole(roles, AUCTION_STAFF)) {
    throw unauthorizedAuctionOperation(`${actorUserId} may not ${operation}`);
  }
}

export interface TransitionResult {
  readonly auction: AuctionRecord;
  /** False when the auction was already in the target state and nothing was done. */
  readonly changed: boolean;
}

/** What a committed transition should announce, resolved after commit. */
interface PendingEvent {
  readonly event: AuctionEvent['event'];
  readonly auction: AuctionRecord;
}

function eventFor(pending: PendingEvent): AuctionEvent {
  return {
    event: pending.event,
    auctionId: pending.auction.id,
    slug: pending.auction.slug,
    status: pending.auction.status,
    occurredAt: new Date().toISOString(),
  };
}

/**
 * Load an auction under lock and check the move is legal.
 *
 * Returns `undefined` when the auction is already in the target state, which
 * every caller treats as "someone else did this already" rather than an error.
 * That is what makes the whole lifecycle replay-safe: a retried job, or the
 * sweeper racing a scheduled job, is a no-op instead of a second effect.
 */
async function beginTransition(
  input: { auctionId: string; action: AuctionAction },
  tx: Tx,
): Promise<{ auction: AuctionRecord } | { alreadyDone: AuctionRecord }> {
  const auction = await repo.lockById(input.auctionId, tx);
  if (!auction) throw auctionNotFound(input.auctionId);

  const target = targetOf(input.action);
  if (auction.status === target) return { alreadyDone: auction };

  if (!canTransition(input.action, auction.status)) {
    throw invalidTransition({
      auctionId: auction.id,
      from: auction.status,
      to: target,
      allowedFrom: allowedFrom(input.action),
    });
  }
  return { auction };
}

async function audit(
  input: {
    action: string;
    auction: AuctionRecord;
    previousStatus: AuctionStatus;
    context?: OperationContext | undefined;
    details?: Record<string, unknown> | undefined;
  },
  tx: Tx,
): Promise<void> {
  await writeAuditLog(
    {
      action: input.action,
      entityType: 'auction',
      entityId: input.auction.id,
      actorUserId: input.context?.actorUserId,
      channel: input.context?.channel ?? 'system',
      requestId: input.context?.requestId,
      before: { status: input.previousStatus },
      details: {
        status: input.auction.status,
        sellerId: input.auction.sellerId,
        productId: input.auction.productId,
        ...input.details,
      },
    },
    tx,
  );
}

// ---------------------------------------------------------------------------
// Seller transitions
// ---------------------------------------------------------------------------

/** The seller sends a draft for review. */
export async function submitForApproval(input: {
  auctionId: string;
  sellerId: string;
  context?: OperationContext | undefined;
}): Promise<TransitionResult> {
  const result = await withTransaction(async (tx) => {
    const begun = await beginTransition({ auctionId: input.auctionId, action: 'submit' }, tx);
    if ('alreadyDone' in begun) return { auction: begun.alreadyDone, changed: false };

    if (begun.auction.sellerId !== input.sellerId) {
      throw auctionNotOwned(begun.auction.id, input.sellerId);
    }

    const updated = await repo.applyTransition(
      {
        id: begun.auction.id,
        expectedStatus: begun.auction.status,
        nextStatus: 'pending_approval',
        submittedAt: new Date(),
        // Resubmitting after a rejection clears the previous verdict.
        rejectedAt: null,
        rejectionReason: null,
      },
      tx,
    );
    if (!updated) return { auction: begun.auction, changed: false };

    await audit(
      {
        action: 'auction.submitted',
        auction: updated,
        previousStatus: begun.auction.status,
        context: input.context,
      },
      tx,
    );
    return { auction: updated, changed: true };
  });
  return result;
}

// ---------------------------------------------------------------------------
// Staff transitions
// ---------------------------------------------------------------------------

/**
 * Approve an auction, which schedules it.
 *
 * A seller can never approve their own auction: the role check refuses anyone
 * without staff authority, and it runs in the module so no channel can skip it.
 */
export async function approve(input: {
  auctionId: string;
  actorUserId: string;
  context?: OperationContext | undefined;
}): Promise<TransitionResult> {
  await assertStaff(input.actorUserId, 'approve an auction');

  const { result, pending } = await withTransaction(async (tx) => {
    const begun = await beginTransition({ auctionId: input.auctionId, action: 'approve' }, tx);
    if ('alreadyDone' in begun) {
      return { result: { auction: begun.alreadyDone, changed: false }, pending: undefined };
    }

    // A seller approving their own auction would defeat the review; the role
    // check above already prevents it, and this makes the intent explicit.
    if (begun.auction.createdBy === input.actorUserId) {
      const roles = await loadRoles(input.actorUserId);
      if (!hasAnyRole(roles, ['admin'])) {
        throw unauthorizedAuctionOperation('an auction cannot be approved by the person who created it');
      }
    }

    const now = new Date();
    const updated = await repo.applyTransition(
      {
        id: begun.auction.id,
        expectedStatus: begun.auction.status,
        nextStatus: 'scheduled',
        approvedBy: input.actorUserId,
        approvedAt: now,
        rejectedAt: null,
        rejectionReason: null,
      },
      tx,
    );
    if (!updated) return { result: { auction: begun.auction, changed: false }, pending: undefined };

    await audit(
      {
        action: 'auction.approved',
        auction: updated,
        previousStatus: begun.auction.status,
        context: input.context,
        details: { startsAt: updated.startsAt.toISOString(), endsAt: updated.endsAt.toISOString() },
      },
      tx,
    );
    return {
      result: { auction: updated, changed: true },
      pending: { event: 'AUCTION_SCHEDULED' as const, auction: updated },
    };
  });

  if (pending) await publishAuctionEvent(eventFor(pending));
  return result;
}

/** Reject an auction back to its seller, with a reason they will read. */
export async function reject(input: {
  auctionId: string;
  reason: string;
  actorUserId: string;
  context?: OperationContext | undefined;
}): Promise<TransitionResult> {
  await assertStaff(input.actorUserId, 'reject an auction');

  return withTransaction(async (tx) => {
    const begun = await beginTransition({ auctionId: input.auctionId, action: 'reject' }, tx);
    if ('alreadyDone' in begun) return { auction: begun.alreadyDone, changed: false };

    const updated = await repo.applyTransition(
      {
        id: begun.auction.id,
        expectedStatus: begun.auction.status,
        nextStatus: 'draft',
        rejectedAt: new Date(),
        rejectionReason: input.reason,
        submittedAt: null,
      },
      tx,
    );
    if (!updated) return { auction: begun.auction, changed: false };

    await audit(
      {
        action: 'auction.rejected',
        auction: updated,
        previousStatus: begun.auction.status,
        context: input.context,
        details: { reason: input.reason },
      },
      tx,
    );
    return { auction: updated, changed: true };
  });
}

// ---------------------------------------------------------------------------
// Worker transitions
// ---------------------------------------------------------------------------

export interface OpenOutcome extends TransitionResult {
  /** Set when the auction had to be cancelled because no unit was free. */
  readonly cancelledForInventory: boolean;
}

/**
 * Open a scheduled auction.
 *
 * The full sequence, all under the auction's row lock:
 *
 *  1. lock the auction
 *  2. verify it is `scheduled`
 *  3. verify the **database** clock has reached `starts_at`
 *  4. reserve exactly one product unit (which locks the product row)
 *  5. transition to `live`
 *  6. audit, then publish after commit
 *
 * If no unit can be reserved the auction does **not** go live. It is cancelled
 * with an auditable reason instead, because an auction running against stock
 * that does not exist would take bid fees for something nobody can be sent.
 *
 * `force` exists for the sweeper's own use and still respects the clock; it
 * only says "I am not the scheduled job".
 */
export async function open(input: {
  auctionId: string;
  context?: OperationContext | undefined;
}): Promise<OpenOutcome> {
  const { result, pending } = await withTransaction(async (tx) => {
    const begun = await beginTransition({ auctionId: input.auctionId, action: 'open' }, tx);
    if ('alreadyDone' in begun) {
      return {
        result: { auction: begun.alreadyDone, changed: false, cancelledForInventory: false },
        pending: undefined,
      };
    }

    // The database is the clock of record. A worker whose own clock runs fast
    // must not open an auction before its published start time.
    const now = await repo.databaseNow(tx);
    if (now < begun.auction.startsAt) {
      throw auctionNotDue({
        auctionId: begun.auction.id,
        what: 'open',
        dueAt: begun.auction.startsAt,
      });
    }

    let reserved;
    try {
      reserved = await reserveUnit(
        {
          productId: begun.auction.productId,
          auctionId: begun.auction.id,
          quantity: begun.auction.quantity,
          context: input.context,
        },
        tx,
      );
    } catch (error) {
      if (!isInsufficientInventory(error)) throw error;

      // No unit is free. Cancelling is the safe end state: the alternative is a
      // live auction collecting fees for an item that cannot be delivered.
      const cancelled = await repo.applyTransition(
        {
          id: begun.auction.id,
          expectedStatus: begun.auction.status,
          nextStatus: 'cancelled',
          cancelledAt: now,
          cancelReason: 'No product unit was available when the auction was due to open',
        },
        tx,
      );
      if (!cancelled) {
        return {
          result: { auction: begun.auction, changed: false, cancelledForInventory: false },
          pending: undefined,
        };
      }
      await audit(
        {
          action: 'auction.cancelled',
          auction: cancelled,
          previousStatus: begun.auction.status,
          context: input.context,
          details: { reason: cancelled.cancelReason, cause: 'insufficient_inventory' },
        },
        tx,
      );
      return {
        result: { auction: cancelled, changed: true, cancelledForInventory: true },
        pending: { event: 'AUCTION_CANCELLED' as const, auction: cancelled },
      };
    }

    const updated = await repo.applyTransition(
      {
        id: begun.auction.id,
        expectedStatus: begun.auction.status,
        nextStatus: 'live',
        openedAt: now,
      },
      tx,
    );
    if (!updated) {
      return {
        result: { auction: begun.auction, changed: false, cancelledForInventory: false },
        pending: undefined,
      };
    }

    await audit(
      {
        action: 'auction.opened',
        auction: updated,
        previousStatus: begun.auction.status,
        context: input.context,
        details: {
          openedAt: now.toISOString(),
          reservationId: reserved.reservation.id,
          reservationCreated: reserved.created,
        },
      },
      tx,
    );
    return {
      result: { auction: updated, changed: true, cancelledForInventory: false },
      pending: { event: 'AUCTION_STARTED' as const, auction: updated },
    };
  });

  if (pending) await publishAuctionEvent(eventFor(pending));
  return result;
}

function isInsufficientInventory(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('details' in error)) return false;
  const details = (error as { details?: { catalogError?: unknown } }).details;
  return (
    details?.catalogError === 'INSUFFICIENT_INVENTORY' &&
    (CATALOG_ERRORS as readonly string[]).includes('INSUFFICIENT_INVENTORY')
  );
}

/**
 * Close a live auction: stop accepting bids.
 *
 * Phase 4 ends here. `closing` is the state in which bid submission is refused
 * by status, and the auction waits for whatever computes the result.
 *
 * **The Phase 4 → Phase 6 boundary.** No winner is determined, no order is
 * created, no participation fee is refunded, and nothing moves the auction on
 * to `calculating`. Phase 6 owns `closing → calculating → completed`, and the
 * transition table already declares those moves so the service it adds will
 * enforce the same previous-state rules these do.
 */
export async function close(input: {
  auctionId: string;
  context?: OperationContext | undefined;
}): Promise<TransitionResult> {
  const { result, pending } = await withTransaction(async (tx) => {
    const begun = await beginTransition({ auctionId: input.auctionId, action: 'close' }, tx);
    if ('alreadyDone' in begun) {
      return { result: { auction: begun.alreadyDone, changed: false }, pending: undefined };
    }

    const now = await repo.databaseNow(tx);
    if (now < begun.auction.endsAt) {
      throw auctionNotDue({ auctionId: begun.auction.id, what: 'close', dueAt: begun.auction.endsAt });
    }

    const updated = await repo.applyTransition(
      {
        id: begun.auction.id,
        expectedStatus: begun.auction.status,
        nextStatus: 'closing',
        closingAt: now,
      },
      tx,
    );
    if (!updated) return { result: { auction: begun.auction, changed: false }, pending: undefined };

    await audit(
      {
        action: 'auction.closing',
        auction: updated,
        previousStatus: begun.auction.status,
        context: input.context,
        details: { closingAt: now.toISOString(), nextPhase: 'result calculation (Phase 6)' },
      },
      tx,
    );
    return {
      result: { auction: updated, changed: true },
      pending: { event: 'AUCTION_CLOSING' as const, auction: updated },
    };
  });

  if (pending) await publishAuctionEvent(eventFor(pending));
  return result;
}

// ---------------------------------------------------------------------------
// Operational transitions
// ---------------------------------------------------------------------------

/**
 * Suspend an auction.
 *
 * The interrupted state is recorded so resume restores it rather than
 * guessing. A suspended auction **keeps** any unit it had reserved: releasing
 * it would let another auction take the stock, and resuming would then fail.
 */
export async function suspend(input: {
  auctionId: string;
  reason: string;
  actorUserId: string;
  context?: OperationContext | undefined;
}): Promise<TransitionResult> {
  await assertStaff(input.actorUserId, 'suspend an auction');

  const { result, pending } = await withTransaction(async (tx) => {
    const begun = await beginTransition({ auctionId: input.auctionId, action: 'suspend' }, tx);
    if ('alreadyDone' in begun) {
      return { result: { auction: begun.alreadyDone, changed: false }, pending: undefined };
    }

    const updated = await repo.applyTransition(
      {
        id: begun.auction.id,
        expectedStatus: begun.auction.status,
        nextStatus: 'suspended',
        suspendedAt: new Date(),
        suspendedBy: input.actorUserId,
        suspendReason: input.reason,
        suspendedFrom: begun.auction.status,
      },
      tx,
    );
    if (!updated) return { result: { auction: begun.auction, changed: false }, pending: undefined };

    await audit(
      {
        action: 'auction.suspended',
        auction: updated,
        previousStatus: begun.auction.status,
        context: input.context,
        details: { reason: input.reason, suspendedFrom: begun.auction.status },
      },
      tx,
    );
    return {
      result: { auction: updated, changed: true },
      pending: { event: 'AUCTION_SUSPENDED' as const, auction: updated },
    };
  });

  if (pending) await publishAuctionEvent(eventFor(pending));
  return result;
}

/**
 * Lift a suspension, restoring the state it interrupted.
 *
 * An auction suspended while live whose deadline has since passed is resumed
 * to `live` and left for the sweeper to close on its next pass, rather than
 * being pushed straight to `closing` here — one transition per operation keeps
 * the audit trail readable, and the sweeper exists precisely for this.
 */
export async function resume(input: {
  auctionId: string;
  actorUserId: string;
  context?: OperationContext | undefined;
}): Promise<TransitionResult> {
  await assertStaff(input.actorUserId, 'resume an auction');

  const { result, pending } = await withTransaction(async (tx) => {
    const auction = await repo.lockById(input.auctionId, tx);
    if (!auction) throw auctionNotFound(input.auctionId);
    if (auction.status !== 'suspended') {
      throw invalidTransition({
        auctionId: auction.id,
        from: auction.status,
        to: 'suspended',
        allowedFrom: ['suspended'],
      });
    }

    // `suspended_from` is NOT NULL whenever suspended_at is, by CHECK; the
    // fallback keeps this total rather than asserting.
    const restored: AuctionStatus = auction.suspendedFrom ?? 'scheduled';

    const updated = await repo.applyTransition(
      {
        id: auction.id,
        expectedStatus: 'suspended',
        nextStatus: restored,
        clearSuspension: true,
      },
      tx,
    );
    if (!updated) return { result: { auction, changed: false }, pending: undefined };

    await audit(
      {
        action: 'auction.resumed',
        auction: updated,
        previousStatus: 'suspended',
        context: input.context,
        details: { restoredTo: restored },
      },
      tx,
    );
    return {
      result: { auction: updated, changed: true },
      pending: { event: 'AUCTION_RESUMED' as const, auction: updated },
    };
  });

  if (pending) await publishAuctionEvent(eventFor(pending));
  return result;
}

/**
 * Cancel an auction and give back any unit it held.
 *
 * The release happens in the same transaction as the status change, so there is
 * no window in which a cancelled auction still holds stock — which is what
 * stops a cancel and a concurrent open from both claiming the same unit.
 */
export async function cancel(input: {
  auctionId: string;
  reason: string;
  actorUserId: string;
  /** A seller may cancel their own auction before it goes live. */
  sellerId?: string | undefined;
  context?: OperationContext | undefined;
}): Promise<TransitionResult> {
  const { result, pending } = await withTransaction(async (tx) => {
    const begun = await beginTransition({ auctionId: input.auctionId, action: 'cancel' }, tx);
    if ('alreadyDone' in begun) {
      return { result: { auction: begun.alreadyDone, changed: false }, pending: undefined };
    }

    // A seller may withdraw their own auction only while it has not started;
    // once bidders have committed, cancelling is a staff decision.
    const ownsIt = input.sellerId !== undefined && begun.auction.sellerId === input.sellerId;
    const sellerMayCancel = ownsIt && !holdsInventory(begun.auction.status);
    if (!sellerMayCancel) {
      await assertStaff(input.actorUserId, 'cancel this auction');
    }

    const now = new Date();
    const released = holdsInventory(begun.auction.status)
      ? await releaseUnit(
          {
            auctionId: begun.auction.id,
            reason: `Auction cancelled: ${input.reason}`,
            context: input.context,
          },
          tx,
        )
      : { released: false, availableAfter: 0 };

    const updated = await repo.applyTransition(
      {
        id: begun.auction.id,
        expectedStatus: begun.auction.status,
        nextStatus: 'cancelled',
        cancelledAt: now,
        cancelReason: input.reason,
      },
      tx,
    );
    if (!updated) return { result: { auction: begun.auction, changed: false }, pending: undefined };

    await audit(
      {
        action: 'auction.cancelled',
        auction: updated,
        previousStatus: begun.auction.status,
        context: input.context,
        details: {
          reason: input.reason,
          inventoryReleased: released.released,
          cancelledBySeller: sellerMayCancel,
        },
      },
      tx,
    );
    return {
      result: { auction: updated, changed: true },
      pending: { event: 'AUCTION_CANCELLED' as const, auction: updated },
    };
  });

  if (pending) await publishAuctionEvent(eventFor(pending));
  return result;
}
