import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as auctions from '@howlow/api/modules/auctions';
import * as catalog from '@howlow/api/modules/catalog';
import { closePool } from '@howlow/api/db';
import {
  adminClient,
  backdateSchedule,
  cleanup,
  cleanupCategories,
  countAuditEvents,
  createProductRow,
  createSeller,
  createUser,
  domainRejection,
  readAuctionRow,
  readInventory,
  settle,
  validAuctionTerms,
} from './catalog-helpers.js';

/**
 * Concurrency: the tests this phase exists to pass.
 *
 * Every one runs real, simultaneous transactions against real PostgreSQL. A
 * mock cannot demonstrate that a row lock serialises anything, and an
 * assertion about locking that does not actually run two transactions at once
 * asserts nothing.
 *
 * The invariants under test throughout: an auction opens once and closes once,
 * a product unit is never promised twice, and repeating any operation leaves
 * the same state and no duplicate side effects.
 */
let db: pg.Client;
let manager: string;
let seller: { userId: string; sellerId: string };

beforeAll(async () => {
  db = await adminClient();
  manager = await createUser(db, { roles: ['auction_manager'] });
  seller = await createSeller(db);
});

afterAll(async () => {
  await cleanup(db);
  await cleanupCategories(db);
  await db.end();
  await closePool();
});

/** An auction scheduled and already due, ready for the worker to open. */
async function dueToOpen(input: { productId: string }): Promise<string> {
  const auction = await auctions.createAuction({
    ...validAuctionTerms(),
    sellerId: seller.sellerId,
    actorUserId: seller.userId,
    productId: input.productId,
  });
  await auctions.submitForApproval({ auctionId: auction.id, sellerId: seller.sellerId });
  await auctions.approve({ auctionId: auction.id, actorUserId: manager });
  await backdateSchedule(db, { auctionId: auction.id, startsAt: '2 hours', endsAt: '1 hour' });
  return auction.id;
}

describe('concurrent auction operations', () => {
  /**
   * 1. Two auctions cannot reserve the final available unit.
   *
   * Without the product row lock both would read one unit free, both would
   * pass their own availability check, and the product would end up with
   * reserved_quantity of 2 against a stock of 1 — which the CHECK would catch,
   * but as a database error rather than a clean outcome.
   */
  it('never lets two auctions reserve the last unit', async () => {
    const productId = await createProductRow(db, { sellerId: seller.sellerId, stockQuantity: 2 });
    const first = await dueToOpen({ productId });
    const second = await dueToOpen({ productId });
    // Both auctions exist against two units; now take one away so only one can win.
    await db.query(`UPDATE products SET stock_quantity = 1 WHERE id = $1`, [productId]);

    const { fulfilled, otherErrors } = await settle([
      auctions.open({ auctionId: first }),
      auctions.open({ auctionId: second }),
    ]);

    expect(otherErrors).toEqual([]);
    expect(fulfilled).toHaveLength(2);

    // Exactly one went live; the other cancelled itself rather than running
    // against stock that does not exist.
    const live = fulfilled.filter((result) => result.auction.status === 'live');
    const cancelled = fulfilled.filter((result) => result.auction.status === 'cancelled');
    expect(live).toHaveLength(1);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.cancelledForInventory).toBe(true);

    expect(await readInventory(db, productId)).toMatchObject({
      stock: 1,
      reserved: 1,
      heldRows: 1,
    });
  });

  /**
   * 1b. The same contention, driven rather than hoped for.
   *
   * The test above exercises the whole `open` path but leaves the dangerous
   * overlap to timing — with the product lock removed it still passed on two
   * runs out of three. This one holds the overlap open: one transaction
   * reserves the last unit and keeps its lock while a second tries the same,
   * so the race happens on every run.
   *
   * Without `FOR UPDATE` on the product row, the second transaction reads one
   * unit free, inserts its own hold, and only then trips the
   * `reserved_quantity <= stock_quantity` CHECK — a raw database error instead
   * of a clean refusal.
   */
  it('makes the second reservation of one unit wait, then refuses it', async () => {
    const productId = await createProductRow(db, { sellerId: seller.sellerId, stockQuantity: 1 });
    const firstAuction = await dueToOpen({ productId });
    await db.query(`UPDATE products SET stock_quantity = 2 WHERE id = $1`, [productId]);
    const secondAuction = await dueToOpen({ productId });
    await db.query(`UPDATE products SET stock_quantity = 1 WHERE id = $1`, [productId]);

    // `Tx` is just something that can run a query, so a plain client inside a
    // transaction is a legitimate one and lets the test control the overlap.
    const holder = await adminClient();
    const contender = await adminClient();
    try {
      await holder.query('BEGIN');
      await contender.query('BEGIN');

      const held = await catalog.reserveUnit(
        { productId, auctionId: firstAuction, quantity: 1 },
        holder,
      );
      expect(held.created).toBe(true);
      expect(held.availableAfter).toBe(0);

      let contenderSettled = false;
      const blocked = catalog
        .reserveUnit({ productId, auctionId: secondAuction, quantity: 1 }, contender)
        .finally(() => {
          contenderSettled = true;
        });

      // The first transaction holds the product lock, so the second cannot
      // have read availability yet.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(contenderSettled).toBe(false);

      await holder.query('COMMIT');

      const refusal = await domainRejection(blocked);
      expect(refusal.domainCode).toBe('INSUFFICIENT_INVENTORY');
      expect(refusal.publicMessage).toMatch(/out of stock/);
      await contender.query('ROLLBACK');
    } finally {
      await holder.end();
      await contender.end();
    }

    expect(await readInventory(db, productId)).toMatchObject({
      stock: 1,
      reserved: 1,
      heldRows: 1,
    });
  });

  /**
   * 2. Two workers cannot open the same auction twice.
   *
   * Ten simultaneous attempts: one does the work, the rest find the status the
   * winner committed and report no change.
   */
  it('opens an auction exactly once under ten concurrent attempts', async () => {
    const productId = await createProductRow(db, { sellerId: seller.sellerId, stockQuantity: 1 });
    const auctionId = await dueToOpen({ productId });

    const { fulfilled, otherErrors } = await settle(
      Array.from({ length: 10 }, () => auctions.open({ auctionId })),
    );

    expect(otherErrors).toEqual([]);
    expect(fulfilled).toHaveLength(10);
    expect(fulfilled.every((result) => result.auction.status === 'live')).toBe(true);
    // Exactly one attempt actually changed anything.
    expect(fulfilled.filter((result) => result.changed)).toHaveLength(1);

    // One audit event, one reservation, one unit.
    expect(await countAuditEvents(db, { entityId: auctionId, action: 'auction.opened' })).toBe(1);
    expect(await readInventory(db, productId)).toMatchObject({ reserved: 1, heldRows: 1 });
  });

  /**
   * 3. Two workers cannot close the same auction twice.
   */
  it('closes an auction exactly once under ten concurrent attempts', async () => {
    const productId = await createProductRow(db, { sellerId: seller.sellerId, stockQuantity: 1 });
    const auctionId = await dueToOpen({ productId });
    await auctions.open({ auctionId });

    const { fulfilled, otherErrors } = await settle(
      Array.from({ length: 10 }, () => auctions.close({ auctionId })),
    );

    expect(otherErrors).toEqual([]);
    expect(fulfilled.every((result) => result.auction.status === 'closing')).toBe(true);
    expect(fulfilled.filter((result) => result.changed)).toHaveLength(1);
    expect(await countAuditEvents(db, { entityId: auctionId, action: 'auction.closing' })).toBe(1);
  });

  /**
   * 4. The safety sweeper and the scheduled job must be idempotent together.
   *
   * The sweeper exists to repair missed executions, so it will regularly race
   * the scheduled job for the same auction. Both call the same lifecycle
   * service, and the effect must be one open and one close.
   */
  it('lets the sweeper and the scheduled job race without duplicating effects', async () => {
    const productId = await createProductRow(db, { sellerId: seller.sellerId, stockQuantity: 1 });
    const auctionId = await dueToOpen({ productId });

    // The sweeper finds it, and the scheduled job fires, at the same moment.
    const due = await auctions.findDueToOpen(10);
    expect(due).toContain(auctionId);

    const { otherErrors } = await settle([
      auctions.open({ auctionId }),
      auctions.open({ auctionId }),
      auctions.open({ auctionId }),
    ]);
    expect(otherErrors).toEqual([]);
    expect(await countAuditEvents(db, { entityId: auctionId, action: 'auction.opened' })).toBe(1);

    const dueToClose = await auctions.findDueToClose(10);
    expect(dueToClose).toContain(auctionId);

    const closing = await settle([
      auctions.close({ auctionId }),
      auctions.close({ auctionId }),
      auctions.close({ auctionId }),
    ]);
    expect(closing.otherErrors).toEqual([]);
    expect(await countAuditEvents(db, { entityId: auctionId, action: 'auction.closing' })).toBe(1);
    expect((await readAuctionRow(db, auctionId)).status).toBe('closing');
    expect(await readInventory(db, productId)).toMatchObject({ reserved: 1, heldRows: 1 });
  });

  /**
   * 5. Cancel and open cannot both claim the same unit.
   *
   * Whichever wins, the product must not end up with a unit reserved by a
   * cancelled auction, nor a live auction holding nothing.
   */
  it('never lets a cancel and an open disagree about the same unit', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const productId = await createProductRow(db, { sellerId: seller.sellerId, stockQuantity: 1 });
      const auctionId = await dueToOpen({ productId });

      const { fulfilled, otherErrors } = await settle([
        auctions.open({ auctionId }),
        auctions.cancel({ auctionId, reason: 'Withdrawn while opening', actorUserId: manager }),
      ]);

      // One of the two legitimately loses the race on the auction row lock and
      // is refused as an invalid transition; neither may crash.
      expect(otherErrors).toEqual([]);
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);

      const row = await readAuctionRow(db, auctionId);
      const inventory = await readInventory(db, productId);

      // The invariant: a live auction holds its unit, and anything else holds none.
      if (row.status === 'live') {
        expect(inventory).toMatchObject({ reserved: 1, heldRows: 1 });
      } else {
        expect(row.status).toBe('cancelled');
        expect(inventory).toMatchObject({ reserved: 0, heldRows: 0 });
      }
    }
  });

  /**
   * 6. Repeating approval, opening and closing must not duplicate side effects.
   *
   * Every operation is run three times in sequence as well as concurrently:
   * a retried request is as likely as a raced one.
   */
  it('produces one effect however many times each operation is repeated', async () => {
    const productId = await createProductRow(db, { sellerId: seller.sellerId, stockQuantity: 1 });
    const auction = await auctions.createAuction({
      ...validAuctionTerms(),
      sellerId: seller.sellerId,
      actorUserId: seller.userId,
      productId,
    });
    const auctionId = auction.id;

    const submits = await settle(
      Array.from({ length: 3 }, () =>
        auctions.submitForApproval({ auctionId, sellerId: seller.sellerId }),
      ),
    );
    expect(submits.otherErrors).toEqual([]);
    expect(await countAuditEvents(db, { entityId: auctionId, action: 'auction.submitted' })).toBe(1);

    const approvals = await settle(
      Array.from({ length: 3 }, () => auctions.approve({ auctionId, actorUserId: manager })),
    );
    expect(approvals.otherErrors).toEqual([]);
    expect(await countAuditEvents(db, { entityId: auctionId, action: 'auction.approved' })).toBe(1);

    // Repeated again in sequence, which is the retry case rather than the race.
    await auctions.approve({ auctionId, actorUserId: manager });
    await auctions.approve({ auctionId, actorUserId: manager });
    expect(await countAuditEvents(db, { entityId: auctionId, action: 'auction.approved' })).toBe(1);

    await backdateSchedule(db, { auctionId, startsAt: '2 hours', endsAt: '1 hour' });
    await auctions.open({ auctionId });
    await auctions.open({ auctionId });
    expect(await countAuditEvents(db, { entityId: auctionId, action: 'auction.opened' })).toBe(1);
    expect(await countAuditEvents(db, { entityId: productId, action: 'inventory.reserved' })).toBe(1);

    await auctions.close({ auctionId });
    await auctions.close({ auctionId });
    expect(await countAuditEvents(db, { entityId: auctionId, action: 'auction.closing' })).toBe(1);

    expect(await readInventory(db, productId)).toMatchObject({
      stock: 1,
      reserved: 1,
      heldRows: 1,
      releasedRows: 0,
    });
  });

  /**
   * Direct evidence that the auction row lock — not luck, and not the
   * connection pool — is what serialises transitions.
   *
   * An outer transaction takes the same FOR UPDATE lock the lifecycle takes
   * and holds it. An open started while it is held must make no progress, and
   * must complete as soon as the lock is released.
   */
  it('blocks a transition while the auction row is locked elsewhere', async () => {
    const productId = await createProductRow(db, { sellerId: seller.sellerId, stockQuantity: 1 });
    const auctionId = await dueToOpen({ productId });

    await db.query('BEGIN');
    await db.query('SELECT id FROM auctions WHERE id = $1 FOR UPDATE', [auctionId]);

    let settled = false;
    const opening = auctions.open({ auctionId }).finally(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settled).toBe(false);

    await db.query('COMMIT');
    const result = await opening;

    expect(settled).toBe(true);
    expect(result.auction.status).toBe('live');
  });

  /**
   * Inventory release is idempotent in the other direction: cancelling an
   * auction that never opened must not fail for having nothing to give back,
   * and must not push the reserved count negative.
   */
  it('releases a unit at most once under concurrent cancels', async () => {
    const productId = await createProductRow(db, { sellerId: seller.sellerId, stockQuantity: 1 });
    const auctionId = await dueToOpen({ productId });
    await auctions.open({ auctionId });

    const { otherErrors } = await settle(
      Array.from({ length: 5 }, () =>
        auctions.cancel({ auctionId, reason: 'Concurrent withdrawal test', actorUserId: manager }),
      ),
    );

    expect(otherErrors).toEqual([]);
    expect(await countAuditEvents(db, { entityId: productId, action: 'inventory.released' })).toBe(1);
    expect(await readInventory(db, productId)).toMatchObject({
      reserved: 0,
      heldRows: 0,
      releasedRows: 1,
    });

    const report = await catalog.reconcileProductInventory(productId);
    expect(report.consistent).toBe(true);
  });
});
