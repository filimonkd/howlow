import type { Tx } from '../../db/index.js';
import { withTransaction } from '../../db/index.js';
import { writeAuditLog, type OperationContext } from '../../shared/index.js';
import { insufficientInventory, productNotFound } from './errors.js';
import * as repo from './catalogRepository.js';
import { availableQuantity, type ReservationRecord } from './types.js';

/**
 * Inventory reservation.
 *
 * A product holds stock; an auction represents one unit of it. The unit is
 * reserved when the auction **goes live**, not when it is created — an auction
 * that is drafted and never approved must not hold stock hostage for days.
 *
 * ## Locking
 *
 * Every reservation takes exactly one lock: `SELECT ... FOR UPDATE` on the
 * product row. That is what makes the availability check sound — two auctions
 * for the same product queue there rather than both seeing the last unit free.
 *
 * The lock order for the whole platform is
 *
 *     auction → product → wallet
 *
 * and nothing here takes a wallet lock, or any lock at all after the product
 * row. Phase 5's bidding transaction locks the auction and then the bidder's
 * wallet, which sits inside that same order, so the two cannot deadlock
 * against each other. See `docs/auctions.md`.
 *
 * ## States
 *
 *   held      a live auction holds the unit
 *   released  returned to stock (cancelled, or closed with no winner)
 *   consumed  taken by a fulfilled order — Phase 10 writes this; Phase 4 never does
 *
 * `products.reserved_quantity` is a cache of the held rows, maintained in the
 * same transaction as the row it accounts for. Reconciliation is
 * `reconcileProductInventory` below.
 */

export interface ReservationOutcome {
  readonly reservation: ReservationRecord;
  /** False when an identical hold already existed, so the caller did no work. */
  readonly created: boolean;
  readonly availableAfter: number;
}

/**
 * Reserve one unit for an auction, inside the caller's transaction.
 *
 * Idempotent: a replayed call returns the existing hold with `created: false`
 * rather than taking a second unit. That matters because the worker may run
 * `auction.open` more than once — a retry, or the sweeper racing the scheduled
 * job — and a double-decrement would silently lose a unit of stock.
 */
export async function reserveUnit(
  input: {
    productId: string;
    auctionId: string;
    quantity?: number;
    context?: OperationContext | undefined;
  },
  tx: Tx,
): Promise<ReservationOutcome> {
  const quantity = input.quantity ?? 1;

  // 1. Lock. Everything after this sees availability nobody else can move.
  const product = await repo.lockProductById(input.productId, tx);
  if (!product) throw productNotFound(input.productId);

  // 2. Replay before changing anything. Under the lock a concurrent duplicate
  //    cannot slip past: it waits, then finds the committed hold.
  const existing = await repo.findHeldReservation(input.auctionId, tx);
  if (existing) {
    return { reservation: existing, created: false, availableAfter: availableQuantity(product) };
  }

  // 3. Check availability against the locked row.
  const available = availableQuantity(product);
  if (available < quantity) {
    throw insufficientInventory({ productId: product.id, requested: quantity, available });
  }

  // 4. Record the hold, then move the cache to match. The partial unique index
  //    is the database's own last word: if two transactions somehow both got
  //    here, only one insert can return a row.
  const reservation = await repo.insertReservation(
    { productId: product.id, auctionId: input.auctionId, quantity },
    tx,
  );
  if (!reservation) {
    // Another transaction committed the hold between our check and our insert.
    // Its effect is the one we wanted, so report it rather than failing.
    const winner = await repo.findHeldReservation(input.auctionId, tx);
    if (!winner) throw insufficientInventory({ productId: product.id, requested: quantity, available });
    return { reservation: winner, created: false, availableAfter: availableQuantity(product) };
  }

  await repo.adjustReservedQuantity({ productId: product.id, delta: quantity }, tx);

  await writeAuditLog(
    {
      action: 'inventory.reserved',
      entityType: 'product',
      entityId: product.id,
      actorUserId: input.context?.actorUserId,
      channel: input.context?.channel ?? 'system',
      requestId: input.context?.requestId,
      details: {
        auctionId: input.auctionId,
        reservationId: reservation.id,
        quantity,
        stockQuantity: product.stockQuantity,
        availableAfter: available - quantity,
      },
    },
    tx,
  );

  return { reservation, created: true, availableAfter: available - quantity };
}

export interface ReleaseOutcome {
  readonly released: boolean;
  readonly availableAfter: number;
}

/**
 * Return an auction's unit to stock, inside the caller's transaction.
 *
 * Idempotent in the other direction: an auction with no held reservation is
 * already in the state the caller wants, so this reports `released: false`
 * rather than throwing. Cancelling an auction that never opened is a normal
 * thing to do, and it must not fail because there was nothing to give back.
 */
export async function releaseUnit(
  input: {
    auctionId: string;
    reason: string;
    context?: OperationContext | undefined;
  },
  tx: Tx,
): Promise<ReleaseOutcome> {
  const held = await repo.findHeldReservation(input.auctionId, tx);
  if (!held) return { released: false, availableAfter: 0 };

  // Lock the product before touching its cached count, so a release and a
  // concurrent reservation cannot interleave.
  const product = await repo.lockProductById(held.productId, tx);
  if (!product) throw productNotFound(held.productId);

  const releasedRow = await repo.markReservationReleased(
    { reservationId: held.id, reason: input.reason },
    tx,
  );
  if (!releasedRow) {
    // Another transaction released it first; the outcome is already correct.
    return { released: false, availableAfter: availableQuantity(product) };
  }

  await repo.adjustReservedQuantity({ productId: product.id, delta: -held.quantity }, tx);

  await writeAuditLog(
    {
      action: 'inventory.released',
      entityType: 'product',
      entityId: product.id,
      actorUserId: input.context?.actorUserId,
      channel: input.context?.channel ?? 'system',
      requestId: input.context?.requestId,
      details: {
        auctionId: input.auctionId,
        reservationId: held.id,
        quantity: held.quantity,
        reason: input.reason,
        availableAfter: availableQuantity(product) + held.quantity,
      },
    },
    tx,
  );

  return { released: true, availableAfter: availableQuantity(product) + held.quantity };
}

/** Open a transaction of its own. For callers not already in one. */
export async function reserveUnitStandalone(input: {
  productId: string;
  auctionId: string;
  context?: OperationContext | undefined;
}): Promise<ReservationOutcome> {
  return withTransaction((tx) => reserveUnit(input, tx), { maxRetries: 1 });
}

export interface InventoryReport {
  readonly productId: string;
  readonly consistent: boolean;
  readonly cachedReserved: number;
  readonly heldReserved: number;
  readonly stockQuantity: number;
}

/**
 * Check a product's cached reserved count against its held reservations.
 *
 * Detects; never repairs — the same reasoning as wallet reconciliation. A
 * disagreement is evidence of a bug, and silently rewriting the count would
 * destroy that evidence and could move the product further from the truth.
 */
export async function reconcileProductInventory(productId: string): Promise<InventoryReport> {
  const product = await repo.findProductById(productId);
  if (!product) throw productNotFound(productId);
  const heldReserved = await repo.sumHeldReservations(productId);

  const report: InventoryReport = {
    productId,
    consistent: heldReserved === product.reservedQuantity,
    cachedReserved: product.reservedQuantity,
    heldReserved,
    stockQuantity: product.stockQuantity,
  };

  if (!report.consistent) {
    await writeAuditLog({
      action: 'inventory.reconciliation_failed',
      entityType: 'product',
      entityId: productId,
      details: {
        cachedReserved: report.cachedReserved,
        heldReserved: report.heldReserved,
        stockQuantity: report.stockQuantity,
      },
    });
  }

  return report;
}
