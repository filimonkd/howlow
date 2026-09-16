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
  validAuctionTerms,
} from './catalog-helpers.js';

/**
 * The auction lifecycle, end to end against real PostgreSQL.
 *
 * Every transition, every refusal, and the inventory that moves with them.
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

/** A fresh draft auction on its own product, so tests never share inventory. */
async function draft(options: { stockQuantity?: number } = {}): Promise<{
  auctionId: string;
  productId: string;
}> {
  const productId = await createProductRow(db, {
    sellerId: seller.sellerId,
    stockQuantity: options.stockQuantity ?? 1,
  });
  const auction = await auctions.createAuction({
    ...validAuctionTerms(),
    sellerId: seller.sellerId,
    actorUserId: seller.userId,
    productId,
    context: { channel: 'web', actorUserId: seller.userId },
  });
  return { auctionId: auction.id, productId };
}

/** Walk a draft all the way to live, the way the platform really does. */
async function live(options: { stockQuantity?: number } = {}): Promise<{
  auctionId: string;
  productId: string;
}> {
  const made = await draft(options);
  await auctions.submitForApproval({ auctionId: made.auctionId, sellerId: seller.sellerId });
  await auctions.approve({ auctionId: made.auctionId, actorUserId: manager });
  // The service refuses a start time in the past, so the schedule is backdated
  // directly: what is under test is what happens once a deadline has passed.
  await backdateSchedule(db, { auctionId: made.auctionId, startsAt: '2 hours', endsAt: '1 hour' });
  await auctions.open({ auctionId: made.auctionId });
  return made;
}

describe('creation', () => {
  it('creates a draft with the terms it was given', async () => {
    const productId = await createProductRow(db, { sellerId: seller.sellerId });
    const auction = await auctions.createAuction({
      ...validAuctionTerms({ title: 'A Fine Telephone Auction' }),
      sellerId: seller.sellerId,
      actorUserId: seller.userId,
      productId,
    });

    expect(auction.status).toBe('draft');
    expect(auction.slug).toBe('a-fine-telephone-auction');
    expect(auction.quantity).toBe(1);
    expect(auction.algorithmVersion).toBe('LUB_V1');
    expect(auction.createdBy).toBe(seller.userId);
    expect(auction.minBidMinor).toBe(100n);
    expect(await countAuditEvents(db, { entityId: auction.id, action: 'auction.created' })).toBe(1);
  });

  it('refuses a product another seller owns', async () => {
    const other = await createSeller(db);
    const productId = await createProductRow(db, { sellerId: other.sellerId });

    const refusal = await domainRejection(
      auctions.createAuction({
        ...validAuctionTerms(),
        sellerId: seller.sellerId,
        actorUserId: seller.userId,
        productId,
      }),
    );
    expect(refusal.domainCode).toBe('PRODUCT_NOT_OWNED');
    expect(refusal.code).toBe('FORBIDDEN');
  });

  it('refuses a product that is not active', async () => {
    const productId = await createProductRow(db, { sellerId: seller.sellerId, status: 'draft' });
    const refusal = await domainRejection(
      auctions.createAuction({
        ...validAuctionTerms(),
        sellerId: seller.sellerId,
        actorUserId: seller.userId,
        productId,
      }),
    );
    expect(refusal.domainCode).toBe('PRODUCT_NOT_ELIGIBLE');
  });

  it('refuses a product with no stock', async () => {
    const productId = await createProductRow(db, {
      sellerId: seller.sellerId,
      stockQuantity: 0,
    });
    const refusal = await domainRejection(
      auctions.createAuction({
        ...validAuctionTerms(),
        sellerId: seller.sellerId,
        actorUserId: seller.userId,
        productId,
      }),
    );
    expect(refusal.domainCode).toBe('PRODUCT_NOT_ELIGIBLE');
  });

  /**
   * One unit cannot be promised to two auctions. Caught at creation as a
   * courtesy; the binding check is under the product lock when opening.
   */
  it('refuses a second auction against a single-unit product', async () => {
    const productId = await createProductRow(db, { sellerId: seller.sellerId, stockQuantity: 1 });
    await auctions.createAuction({
      ...validAuctionTerms(),
      sellerId: seller.sellerId,
      actorUserId: seller.userId,
      productId,
    });

    const refusal = await domainRejection(
      auctions.createAuction({
        ...validAuctionTerms(),
        sellerId: seller.sellerId,
        actorUserId: seller.userId,
        productId,
      }),
    );
    expect(refusal.domainCode).toBe('PRODUCT_ALREADY_COMMITTED');
  });

  it('allows as many auctions as there are units', async () => {
    const productId = await createProductRow(db, { sellerId: seller.sellerId, stockQuantity: 3 });
    for (let index = 0; index < 3; index += 1) {
      await auctions.createAuction({
        ...validAuctionTerms(),
        sellerId: seller.sellerId,
        actorUserId: seller.userId,
        productId,
      });
    }
    const refusal = await domainRejection(
      auctions.createAuction({
        ...validAuctionTerms(),
        sellerId: seller.sellerId,
        actorUserId: seller.userId,
        productId,
      }),
    );
    expect(refusal.domainCode).toBe('PRODUCT_ALREADY_COMMITTED');
  });

  it('refuses an unwalkable bid ladder', async () => {
    const productId = await createProductRow(db, { sellerId: seller.sellerId });
    const refusal = await domainRejection(
      auctions.createAuction({
        ...validAuctionTerms({ minBidMinor: 100n, maxBidMinor: 5050n, bidIncrementMinor: 100n }),
        sellerId: seller.sellerId,
        actorUserId: seller.userId,
        productId,
      }),
    );
    expect(refusal.domainCode).toBe('INVALID_AUCTION_CONFIG');
    expect(refusal.publicMessage).toMatch(/whole number of increments/);
  });
});

describe('the approval flow', () => {
  it('walks submit → approve → scheduled', async () => {
    const { auctionId } = await draft();

    const submitted = await auctions.submitForApproval({ auctionId, sellerId: seller.sellerId });
    expect(submitted.auction.status).toBe('pending_approval');
    expect(submitted.auction.submittedAt).not.toBeNull();
    expect(submitted.changed).toBe(true);

    const approved = await auctions.approve({ auctionId, actorUserId: manager });
    expect(approved.auction.status).toBe('scheduled');
    expect(approved.auction.approvedBy).toBe(manager);
    expect(approved.auction.approvedAt).not.toBeNull();

    expect(await countAuditEvents(db, { entityId: auctionId, action: 'auction.submitted' })).toBe(1);
    expect(await countAuditEvents(db, { entityId: auctionId, action: 'auction.approved' })).toBe(1);
  });

  it('returns a rejected auction to its seller with the reason', async () => {
    const { auctionId } = await draft();
    await auctions.submitForApproval({ auctionId, sellerId: seller.sellerId });

    const rejected = await auctions.reject({
      auctionId,
      reason: 'The photographs do not show the item described',
      actorUserId: manager,
    });
    expect(rejected.auction.status).toBe('draft');
    expect(rejected.auction.rejectionReason).toMatch(/photographs/);

    // And it can be fixed and resubmitted, which clears the verdict.
    const resubmitted = await auctions.submitForApproval({ auctionId, sellerId: seller.sellerId });
    expect(resubmitted.auction.status).toBe('pending_approval');
    expect(resubmitted.auction.rejectionReason).toBeNull();
  });

  /** A seller approving their own auction would defeat the review entirely. */
  it('refuses approval by a seller', async () => {
    const { auctionId } = await draft();
    await auctions.submitForApproval({ auctionId, sellerId: seller.sellerId });

    const refusal = await domainRejection(auctions.approve({ auctionId, actorUserId: seller.userId }));
    expect(refusal.domainCode).toBe('UNAUTHORIZED_AUCTION_OPERATION');
    expect((await readAuctionRow(db, auctionId)).status).toBe('pending_approval');
  });

  it('refuses a submission by another seller', async () => {
    const { auctionId } = await draft();
    const other = await createSeller(db);
    const refusal = await domainRejection(
      auctions.submitForApproval({ auctionId, sellerId: other.sellerId }),
    );
    expect(refusal.domainCode).toBe('AUCTION_NOT_OWNED');
  });

  it('refuses to approve an auction that was never submitted', async () => {
    const { auctionId } = await draft();
    const refusal = await domainRejection(auctions.approve({ auctionId, actorUserId: manager }));
    expect(refusal.domainCode).toBe('INVALID_TRANSITION');
    expect(refusal.message).toMatch(/reachable only from pending_approval/);
  });
});

describe('opening', () => {
  it('reserves exactly one unit and goes live', async () => {
    const { auctionId, productId } = await draft({ stockQuantity: 2 });
    await auctions.submitForApproval({ auctionId, sellerId: seller.sellerId });
    await auctions.approve({ auctionId, actorUserId: manager });
    await backdateSchedule(db, { auctionId, startsAt: '2 hours', endsAt: '1 hour' });

    const opened = await auctions.open({ auctionId });
    expect(opened.auction.status).toBe('live');
    expect(opened.auction.openedAt).not.toBeNull();
    expect(opened.cancelledForInventory).toBe(false);

    const inventory = await readInventory(db, productId);
    expect(inventory).toMatchObject({ stock: 2, reserved: 1, heldRows: 1 });
    expect(await countAuditEvents(db, { entityId: productId, action: 'inventory.reserved' })).toBe(1);
  });

  /**
   * The database is the clock of record: a worker whose own clock runs fast
   * must not open an auction before its published start time.
   */
  it('refuses to open before the start time', async () => {
    const { auctionId } = await draft();
    await auctions.submitForApproval({ auctionId, sellerId: seller.sellerId });
    await auctions.approve({ auctionId, actorUserId: manager });

    const refusal = await domainRejection(auctions.open({ auctionId }));
    expect(refusal.domainCode).toBe('AUCTION_NOT_DUE');
    expect((await readAuctionRow(db, auctionId)).status).toBe('scheduled');
  });

  it('refuses to open an auction that was never approved', async () => {
    const { auctionId } = await draft();
    const refusal = await domainRejection(auctions.open({ auctionId }));
    expect(refusal.domainCode).toBe('INVALID_TRANSITION');
  });

  /**
   * The safe end state when stock has gone. A live auction collecting fees for
   * an item nobody can be sent is the worse outcome, so the auction cancels
   * itself with a reason an operator can read.
   */
  it('cancels rather than going live when no unit is free', async () => {
    const productId = await createProductRow(db, { sellerId: seller.sellerId, stockQuantity: 1 });
    const first = await auctions.createAuction({
      ...validAuctionTerms(),
      sellerId: seller.sellerId,
      actorUserId: seller.userId,
      productId,
    });
    // A second auction on the same unit, created before the first took it.
    await db.query(`UPDATE products SET stock_quantity = 2 WHERE id = $1`, [productId]);
    const second = await auctions.createAuction({
      ...validAuctionTerms(),
      sellerId: seller.sellerId,
      actorUserId: seller.userId,
      productId,
    });
    await db.query(`UPDATE products SET stock_quantity = 1 WHERE id = $1`, [productId]);

    for (const id of [first.id, second.id]) {
      await auctions.submitForApproval({ auctionId: id, sellerId: seller.sellerId });
      await auctions.approve({ auctionId: id, actorUserId: manager });
      await backdateSchedule(db, { auctionId: id, startsAt: '2 hours', endsAt: '1 hour' });
    }

    const opened = await auctions.open({ auctionId: first.id });
    expect(opened.auction.status).toBe('live');

    const starved = await auctions.open({ auctionId: second.id });
    expect(starved.auction.status).toBe('cancelled');
    expect(starved.cancelledForInventory).toBe(true);
    expect(starved.auction.cancelReason).toMatch(/No product unit was available/);

    // The first auction still holds its unit; nothing was over-reserved.
    expect(await readInventory(db, productId)).toMatchObject({ stock: 1, reserved: 1, heldRows: 1 });
  });
});

describe('closing', () => {
  it('moves a live auction to closing once its deadline passes', async () => {
    const { auctionId } = await live();

    const closed = await auctions.close({ auctionId });
    expect(closed.auction.status).toBe('closing');
    expect(closed.auction.closingAt).not.toBeNull();
    expect(await countAuditEvents(db, { entityId: auctionId, action: 'auction.closing' })).toBe(1);
  });

  it('refuses to close before the deadline', async () => {
    const { auctionId } = await draft();
    await auctions.submitForApproval({ auctionId, sellerId: seller.sellerId });
    await auctions.approve({ auctionId, actorUserId: manager });
    // Started an hour ago, ends in an hour: live, but not yet due to close.
    await db.query(
      `UPDATE auctions SET starts_at = now() - interval '1 hour', ends_at = now() + interval '1 hour' WHERE id = $1`,
      [auctionId],
    );
    await auctions.open({ auctionId });

    const refusal = await domainRejection(auctions.close({ auctionId }));
    expect(refusal.domainCode).toBe('AUCTION_NOT_DUE');
    expect((await readAuctionRow(db, auctionId)).status).toBe('live');
  });

  /**
   * The Phase 4 → Phase 6 boundary. Closing stops bidding and nothing more:
   * no result, no winner, no fee refund, and the auction does not advance to
   * `calculating`.
   */
  it('stops at closing without deciding anything', async () => {
    const { auctionId, productId } = await live();
    await auctions.close({ auctionId });

    const row = await readAuctionRow(db, auctionId);
    expect(row.status).toBe('closing');

    // No result row, and no bids were invented.
    const results = await db.query(`SELECT 1 FROM auction_results WHERE auction_id = $1`, [auctionId]);
    expect(results.rowCount).toBe(0);
    const bids = await db.query(`SELECT 1 FROM bids WHERE auction_id = $1`, [auctionId]);
    expect(bids.rowCount).toBe(0);

    // The unit stays reserved: the winner has not been sent anything yet.
    expect(await readInventory(db, productId)).toMatchObject({ reserved: 1, heldRows: 1 });
  });

  /** An auction with no bids at all still closes cleanly. */
  it('closes an auction that received no bids', async () => {
    const { auctionId } = await live();
    const closed = await auctions.close({ auctionId });
    expect(closed.auction.status).toBe('closing');
    expect(closed.changed).toBe(true);
  });
});

describe('suspension', () => {
  it('suspends and resumes back to the interrupted state', async () => {
    const { auctionId, productId } = await live();

    const suspended = await auctions.suspend({
      auctionId,
      reason: 'Listing under review after a report',
      actorUserId: manager,
    });
    expect(suspended.auction.status).toBe('suspended');
    expect(suspended.auction.suspendedFrom).toBe('live');
    expect(suspended.auction.suspendReason).toMatch(/under review/);

    // The unit is kept, or another auction could take the stock and resume
    // would then fail.
    expect(await readInventory(db, productId)).toMatchObject({ reserved: 1, heldRows: 1 });

    const resumed = await auctions.resume({ auctionId, actorUserId: manager });
    expect(resumed.auction.status).toBe('live');
    expect(resumed.auction.suspendedAt).toBeNull();
    expect(resumed.auction.suspendReason).toBeNull();
    expect(resumed.auction.suspendedFrom).toBeNull();
  });

  it('restores a scheduled auction to scheduled, not to live', async () => {
    const { auctionId } = await draft();
    await auctions.submitForApproval({ auctionId, sellerId: seller.sellerId });
    await auctions.approve({ auctionId, actorUserId: manager });

    await auctions.suspend({ auctionId, reason: 'Paused pending seller reply', actorUserId: manager });
    const resumed = await auctions.resume({ auctionId, actorUserId: manager });
    expect(resumed.auction.status).toBe('scheduled');
  });

  it('refuses suspension by someone without authority', async () => {
    const { auctionId } = await live();
    const refusal = await domainRejection(
      auctions.suspend({ auctionId, reason: 'I would like this paused', actorUserId: seller.userId }),
    );
    expect(refusal.domainCode).toBe('UNAUTHORIZED_AUCTION_OPERATION');
    expect((await readAuctionRow(db, auctionId)).status).toBe('live');
  });
});

describe('cancellation', () => {
  it('releases the reserved unit in the same breath', async () => {
    const { auctionId, productId } = await live();
    expect(await readInventory(db, productId)).toMatchObject({ reserved: 1, heldRows: 1 });

    const cancelled = await auctions.cancel({
      auctionId,
      reason: 'The seller can no longer supply the item',
      actorUserId: manager,
    });
    expect(cancelled.auction.status).toBe('cancelled');

    expect(await readInventory(db, productId)).toMatchObject({
      reserved: 0,
      heldRows: 0,
      releasedRows: 1,
    });
    expect(await countAuditEvents(db, { entityId: productId, action: 'inventory.released' })).toBe(1);
  });

  it('lets a seller withdraw their own auction before it starts', async () => {
    const { auctionId } = await draft();
    const cancelled = await auctions.cancel({
      auctionId,
      reason: 'Listed the wrong item by mistake',
      actorUserId: seller.userId,
      sellerId: seller.sellerId,
    });
    expect(cancelled.auction.status).toBe('cancelled');
  });

  /** Once bidders have committed, withdrawing is a staff decision. */
  it('refuses a seller cancelling their own live auction', async () => {
    const { auctionId } = await live();
    const refusal = await domainRejection(
      auctions.cancel({
        auctionId,
        reason: 'Changed my mind about selling',
        actorUserId: seller.userId,
        sellerId: seller.sellerId,
      }),
    );
    expect(refusal.domainCode).toBe('UNAUTHORIZED_AUCTION_OPERATION');
    expect((await readAuctionRow(db, auctionId)).status).toBe('live');
  });

  it('is terminal', async () => {
    const { auctionId } = await draft();
    await auctions.cancel({ auctionId, reason: 'No longer required', actorUserId: manager });

    // Thunks, not promises: an array of already-started promises would leave
    // the ones not yet awaited rejecting unhandled.
    const attempts = [
      () => auctions.submitForApproval({ auctionId, sellerId: seller.sellerId }),
      () => auctions.approve({ auctionId, actorUserId: manager }),
      () => auctions.open({ auctionId }),
      () => auctions.suspend({ auctionId, reason: 'Trying to suspend it', actorUserId: manager }),
    ];
    for (const attempt of attempts) {
      const refusal = await domainRejection(attempt());
      expect(refusal.domainCode).toBe('INVALID_TRANSITION');
    }
  });
});

describe('term immutability', () => {
  it('allows edits before the auction starts', async () => {
    const { auctionId } = await draft();
    const updated = await auctions.updateAuction({
      auctionId,
      sellerId: seller.sellerId,
      actorUserId: seller.userId,
      changes: { minBidMinor: 200n, maxBidMinor: 5200n },
    });
    expect(updated.minBidMinor).toBe(200n);
    expect(updated.maxBidMinor).toBe(5200n);
  });

  it('validates a partial edit against the terms it does not change', async () => {
    const { auctionId } = await draft();
    // 100–5050 in steps of 100 leaves 5050 unreachable.
    const refusal = await domainRejection(
      auctions.updateAuction({
        auctionId,
        sellerId: seller.sellerId,
        actorUserId: seller.userId,
        changes: { maxBidMinor: 5050n },
      }),
    );
    expect(refusal.domainCode).toBe('INVALID_AUCTION_CONFIG');
  });

  it('refuses every term change once the auction is live', async () => {
    const { auctionId } = await live();
    for (const changes of [
      { minBidMinor: 200n },
      { maxBidMinor: 9900n },
      { bidFeeMinor: 0n },
      { maxBidsPerUser: 1 },
      { endsAt: new Date(Date.now() + 86_400_000) },
    ]) {
      const refusal = await domainRejection(
        auctions.updateAuction({
          auctionId,
          sellerId: seller.sellerId,
          actorUserId: seller.userId,
          changes,
        }),
      );
      expect(refusal.domainCode).toBe('AUCTION_IMMUTABLE');
    }
  });

  /**
   * And the database refuses it too, independently of the service — so a
   * future code path that forgot the check still cannot rewrite live terms.
   */
  it('is enforced by the database as well as the service', async () => {
    const { auctionId } = await live();
    await expect(
      db.query(`UPDATE auctions SET min_bid_minor = 999 WHERE id = $1`, [auctionId]),
    ).rejects.toThrow(/immutable/);
  });
});

describe('public visibility', () => {
  /**
   * An unpublished auction must not be readable by anyone who knows its
   * address. Found by probing the real endpoint: the listing filtered by status
   * but the detail read did not, so a draft's terms, seller and product were
   * publicly readable.
   */
  it('hides an auction that is not publicly visible', async () => {
    const { auctionId } = await draft();

    // Draft.
    let refusal = await domainRejection(auctions.getPublicAuction(auctionId));
    expect(refusal.domainCode).toBe('AUCTION_NOT_FOUND');
    // NOT_FOUND rather than FORBIDDEN, so the answer does not confirm it exists.
    expect(refusal.code).toBe('NOT_FOUND');

    // Awaiting review.
    await auctions.submitForApproval({ auctionId, sellerId: seller.sellerId });
    refusal = await domainRejection(auctions.getPublicAuction(auctionId));
    expect(refusal.domainCode).toBe('AUCTION_NOT_FOUND');

    // Approved: now public.
    await auctions.approve({ auctionId, actorUserId: manager });
    const visible = await auctions.getPublicAuction(auctionId);
    expect(visible.status).toBe('scheduled');

    // Suspended: hidden again while it is under review.
    await auctions.suspend({ auctionId, reason: 'Hidden while investigated', actorUserId: manager });
    refusal = await domainRejection(auctions.getPublicAuction(auctionId));
    expect(refusal.domainCode).toBe('AUCTION_NOT_FOUND');
  });

  it('reads a public auction by slug as well as by id', async () => {
    const { auctionId } = await draft();
    await auctions.submitForApproval({ auctionId, sellerId: seller.sellerId });
    const approved = await auctions.approve({ auctionId, actorUserId: manager });

    const bySlug = await auctions.getPublicAuction(approved.auction.slug!);
    expect(bySlug.id).toBe(auctionId);
  });

  it('never lists an unpublished auction, whatever status is requested', async () => {
    const { auctionId } = await draft();

    for (const status of ['draft', 'pending_approval', 'suspended'] as const) {
      const page = await auctions.listPublicAuctions({ status, sort: 'newest', limit: 50 });
      expect(page.auctions.map((auction) => auction.id)).not.toContain(auctionId);
    }

    // And with no filter at all.
    const unfiltered = await auctions.listPublicAuctions({ sort: 'newest', limit: 50 });
    expect(unfiltered.auctions.map((auction) => auction.id)).not.toContain(auctionId);
  });

  /**
   * The same microsecond-versus-millisecond cursor defect the product listing
   * had, from the other direction. Ascending sorts do not skip on a truncated
   * cursor — they repeat, because a cursor rounded down still precedes the
   * rows sharing its millisecond, including the one it was taken from. A page
   * filled entirely by one millisecond would then never advance, so this
   * asserts termination and no duplicates, not just the count.
   */
  it('pages an ascending sort across auctions ending within the same millisecond', async () => {
    const made = [];
    for (let index = 0; index < 4; index += 1) made.push(await draft());
    const ends = [
      '2027-01-01T00:00:00.400000Z',
      '2027-01-01T00:00:00.500100Z', // last row of page one
      '2027-01-01T00:00:00.500900Z', // the row a truncated cursor returned twice
      '2027-01-01T00:00:00.600000Z',
    ];
    for (const [index, { auctionId }] of made.entries()) {
      await auctions.submitForApproval({ auctionId, sellerId: seller.sellerId });
      await auctions.approve({ auctionId, actorUserId: manager });
      // Written directly: ends_at is immutable through the service once
      // approved, and what is under test is the cursor, not the transition.
      await db.query('UPDATE auctions SET ends_at = $2::timestamptz WHERE id = $1', [auctionId, ends[index]]);
    }

    const wanted = new Set(made.map((entry) => entry.auctionId));
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 50; guard += 1) {
      const page = await auctions.listPublicAuctions({
        sort: 'ending_soon',
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...page.auctions.map((auction) => auction.id).filter((id) => wanted.has(id)));
      if (page.nextCursor === null) break;
      cursor = auctions.encodeCursor(page.nextCursor);
      if (guard === 49) throw new Error('pagination did not terminate');
    }

    expect(new Set(seen)).toEqual(wanted);
    expect(seen).toHaveLength(4);
  });

  /**
   * The public payload carries nothing a bidder could use to work out the
   * lowest unique bid.
   */
  it('exposes no bid counts, bidders or uniqueness signal', async () => {
    const { auctionId } = await live();
    const auction = await auctions.getPublicAuction(auctionId);
    const dto = auctions.toDetailDto(auction, []);
    const keys = Object.keys(dto);

    expect(keys).not.toContain('bidCount');
    expect(keys).not.toContain('participantCount');
    expect(keys).not.toContain('bids');
    expect(keys).not.toContain('uniqueAmounts');
    expect(keys).not.toContain('winnerUserId');
    expect(keys).not.toContain('sellerId');

    // The terms a bidder needs, and only those.
    expect(Object.keys(dto.terms).sort()).toEqual([
      'bidFeeMinor',
      'bidIncrementMinor',
      'currency',
      'maxBidMinor',
      'maxBidsPerUser',
      'minBidMinor',
      'winnerPaymentHours',
    ]);
  });
});

describe('product archival', () => {
  it('refuses to archive a product an unfinished auction depends on', async () => {
    const { auctionId, productId } = await live();
    const refusal = await domainRejection(
      catalog.archiveProduct({
        productId,
        sellerId: seller.sellerId,
        actorUserId: seller.userId,
      }),
    );
    expect(refusal.domainCode).toBe('PRODUCT_IN_USE');

    // Once the auction is out of the way, archival is allowed — and the
    // product is kept, not deleted, because it is auction history.
    await auctions.cancel({ auctionId, reason: 'Closing the test scenario', actorUserId: manager });
    const archived = await catalog.archiveProduct({
      productId,
      sellerId: seller.sellerId,
      actorUserId: seller.userId,
    });
    expect(archived.status).toBe('archived');

    const stillThere = await db.query(`SELECT 1 FROM products WHERE id = $1`, [productId]);
    expect(stillThere.rowCount).toBe(1);
  });
});
