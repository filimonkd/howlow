import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as catalog from '@howlow/api/modules/catalog';
import { closePool } from '@howlow/api/db';
import {
  adminClient,
  cleanup,
  cleanupCategories,
  countAuditEvents,
  createCategory,
  createProductRow,
  createSeller,
  createUser,
  domainRejection,
  readInventory,
  settle,
} from './catalog-helpers.js';

/** Categories, products and images against real PostgreSQL. */
let db: pg.Client;
let manager: string;
let seller: { userId: string; sellerId: string };

const DESCRIPTION = 'A description comfortably longer than the twenty-character minimum.';

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

describe('sellers', () => {
  it('registers a seller as pending, and registering twice is idempotent', async () => {
    const userId = await createUser(db, { roles: ['seller'] });
    const first = await catalog.registerSeller({ userId, displayName: 'A New Shop' });
    const again = await catalog.registerSeller({ userId, displayName: 'A Different Name' });

    expect(first.status).toBe('pending');
    expect(first.approvedAt).toBeNull();
    expect(again.id).toBe(first.id);
    expect(again.displayName).toBe('A New Shop');
  });

  /** A pending seller may read their catalog but not add to it. */
  it('refuses catalog writes from a seller who is not approved', async () => {
    const pending = await createSeller(db, { status: 'pending' });
    const refusal = await domainRejection(catalog.requireApprovedSeller(pending.userId));
    expect(refusal.domainCode).toBe('SELLER_NOT_APPROVED');
    expect(refusal.code).toBe('FORBIDDEN');
  });

  it('records approval with its timestamp, and clears it on suspension', async () => {
    const pending = await createSeller(db, { status: 'pending' });
    const approved = await catalog.setSellerStatus({
      sellerId: pending.sellerId,
      status: 'approved',
      actorUserId: manager,
    });
    expect(approved.status).toBe('approved');
    expect(approved.approvedAt).not.toBeNull();

    const suspended = await catalog.setSellerStatus({
      sellerId: pending.sellerId,
      status: 'suspended',
      actorUserId: manager,
    });
    // The CHECK ties approved_at to the approved status, so both move together.
    expect(suspended.approvedAt).toBeNull();
  });

  it('refuses a status change by someone without authority', async () => {
    const refusal = await domainRejection(
      catalog.setSellerStatus({
        sellerId: seller.sellerId,
        status: 'suspended',
        actorUserId: seller.userId,
      }),
    );
    expect(refusal.domainCode).toBe('UNAUTHORIZED_CATALOG_OPERATION');
  });
});

describe('categories', () => {
  it('creates a category and derives its slug from the name', async () => {
    const category = await catalog.createCategory({
      name: 'Mobile Téléphones',
      actorUserId: manager,
    });
    expect(category.slug).toBe('mobile-telephones');
    expect(category.isActive).toBe(true);
    await db.query(`DELETE FROM categories WHERE id = $1`, [category.id]);
  });

  it('refuses a duplicate slug', async () => {
    const existing = await createCategory(db);
    const refusal = await domainRejection(
      catalog.createCategory({ name: 'Anything', slug: existing.slug, actorUserId: manager }),
    );
    expect(refusal.domainCode).toBe('CATEGORY_SLUG_TAKEN');
  });

  it('refuses an unknown parent', async () => {
    const refusal = await domainRejection(
      catalog.createCategory({
        name: 'Orphan',
        parentId: '00000000-0000-4000-8000-000000000000',
        actorUserId: manager,
      }),
    );
    expect(refusal.domainCode).toBe('CATEGORY_NOT_FOUND');
  });

  /**
   * A cycle would make the tree unwalkable and any recursive read
   * non-terminating. The database's CHECK catches only the direct case.
   */
  it('refuses a parent change that would make a category its own ancestor', async () => {
    const grandparent = await catalog.createCategory({ name: 'Level One', actorUserId: manager });
    const parent = await catalog.createCategory({
      name: 'Level Two',
      parentId: grandparent.id,
      actorUserId: manager,
    });
    const child = await catalog.createCategory({
      name: 'Level Three',
      parentId: parent.id,
      actorUserId: manager,
    });

    // Direct: a category as its own parent.
    const direct = await domainRejection(
      catalog.updateCategory({
        categoryId: grandparent.id,
        changes: { parentId: grandparent.id },
        actorUserId: manager,
      }),
    );
    expect(direct.domainCode).toBe('CATEGORY_CYCLE');

    // Transitive: the grandparent beneath its own grandchild.
    const transitive = await domainRejection(
      catalog.updateCategory({
        categoryId: grandparent.id,
        changes: { parentId: child.id },
        actorUserId: manager,
      }),
    );
    expect(transitive.domainCode).toBe('CATEGORY_CYCLE');

    for (const id of [child.id, parent.id, grandparent.id]) {
      await db.query(`DELETE FROM categories WHERE id = $1`, [id]);
    }
  });

  it('refuses new products in an inactive category', async () => {
    const inactive = await createCategory(db, { isActive: false });
    const refusal = await domainRejection(
      catalog.createProduct({
        sellerId: seller.sellerId,
        actorUserId: seller.userId,
        title: 'A Product',
        description: DESCRIPTION,
        categoryId: inactive.id,
        condition: 'new',
        specs: {},
        currency: 'ETB',
        retailPriceMinor: 12_000_000n,
        stockQuantity: 1,
      }),
    );
    expect(refusal.domainCode).toBe('CATEGORY_INACTIVE');
  });

  it('shows only active categories in the public tree', async () => {
    const active = await createCategory(db, { isActive: true });
    const hidden = await createCategory(db, { isActive: false });

    const publicTree = await catalog.getCategoryTree();
    const slugs = publicTree.map((category) => category.slug);
    expect(slugs).toContain(active.slug);
    expect(slugs).not.toContain(hidden.slug);

    const staffTree = await catalog.getCategoryTree({ includeInactive: true });
    expect(staffTree.map((category) => category.slug)).toContain(hidden.slug);
  });

  it('nests children under their parent', async () => {
    const parent = await catalog.createCategory({ name: 'Electronics Root', actorUserId: manager });
    const child = await catalog.createCategory({
      name: 'Electronics Phones',
      parentId: parent.id,
      actorUserId: manager,
    });

    const tree = await catalog.getCategoryTree();
    const found = tree.find((category) => category.id === parent.id);
    expect(found?.children.map((item) => item.id)).toEqual([child.id]);
    // A child is not also listed as a root.
    expect(tree.map((category) => category.id)).not.toContain(child.id);

    await db.query(`DELETE FROM categories WHERE id = ANY($1::uuid[])`, [[child.id, parent.id]]);
  });
});

describe('products', () => {
  const baseProduct = {
    description: DESCRIPTION,
    condition: 'new' as const,
    specs: {},
    currency: 'ETB' as const,
    retailPriceMinor: 12_000_000n,
    stockQuantity: 3,
  };

  it('creates a draft product with a derived slug', async () => {
    const product = await catalog.createProduct({
      ...baseProduct,
      sellerId: seller.sellerId,
      actorUserId: seller.userId,
      title: 'iPhone 16 Pro 256GB',
      sku: `SKU-${Date.now()}`,
      brand: 'Apple',
      specs: { Storage: '256GB', Colour: 'Titanium' },
    });

    expect(product.status).toBe('draft');
    expect(product.slug).toBe('iphone-16-pro-256gb');
    expect(product.specs).toEqual({ Storage: '256GB', Colour: 'Titanium' });
    // The record carries stock and reservations; availability is derived, and
    // only the DTO flattens it.
    expect(catalog.availableQuantity(product)).toBe(3);
    expect(await countAuditEvents(db, { entityId: product.id, action: 'product.created' })).toBe(1);
  });

  /** Titles collide constantly, so a suffix is appended rather than refusing. */
  it('suffixes a colliding derived slug', async () => {
    const title = `Colliding Title ${Date.now()}`;
    const first = await catalog.createProduct({
      ...baseProduct,
      sellerId: seller.sellerId,
      actorUserId: seller.userId,
      title,
    });
    const second = await catalog.createProduct({
      ...baseProduct,
      sellerId: seller.sellerId,
      actorUserId: seller.userId,
      title,
    });
    expect(second.slug).toBe(`${first.slug}-2`);
  });

  /** But an explicitly chosen slug is never silently altered. */
  it('refuses an explicitly requested slug that is taken', async () => {
    const first = await catalog.createProduct({
      ...baseProduct,
      sellerId: seller.sellerId,
      actorUserId: seller.userId,
      title: 'Explicit Slug Product',
    });
    const refusal = await domainRejection(
      catalog.createProduct({
        ...baseProduct,
        sellerId: seller.sellerId,
        actorUserId: seller.userId,
        title: 'Another Title',
        slug: first.slug,
      }),
    );
    expect(refusal.domainCode).toBe('PRODUCT_SLUG_TAKEN');
  });

  /** SKUs are unique per seller, not globally. */
  it('refuses a duplicate SKU for the same seller but allows it for another', async () => {
    const sku = `SHARED-${Date.now()}`;
    await catalog.createProduct({
      ...baseProduct,
      sellerId: seller.sellerId,
      actorUserId: seller.userId,
      title: 'First With Sku',
      sku,
    });

    const refusal = await domainRejection(
      catalog.createProduct({
        ...baseProduct,
        sellerId: seller.sellerId,
        actorUserId: seller.userId,
        title: 'Second With Sku',
        sku,
      }),
    );
    expect(refusal.domainCode).toBe('PRODUCT_SKU_TAKEN');

    const other = await createSeller(db);
    const allowed = await catalog.createProduct({
      ...baseProduct,
      sellerId: other.sellerId,
      actorUserId: other.userId,
      title: 'Another Seller Same Sku',
      sku,
    });
    expect(allowed.sku).toBe(sku);
  });

  it('refuses to read or write another seller’s product', async () => {
    const other = await createSeller(db);
    const productId = await createProductRow(db, { sellerId: other.sellerId });

    for (const attempt of [
      () => catalog.getOwnedProduct({ productId, sellerId: seller.sellerId }),
      () =>
        catalog.updateProduct({
          productId,
          sellerId: seller.sellerId,
          actorUserId: seller.userId,
          changes: { title: 'Hijacked' },
        }),
      () =>
        catalog.archiveProduct({
          productId,
          sellerId: seller.sellerId,
          actorUserId: seller.userId,
        }),
    ]) {
      const refusal = await domainRejection(attempt());
      expect(refusal.domainCode).toBe('PRODUCT_NOT_OWNED');
      expect(refusal.code).toBe('FORBIDDEN');
    }
  });

  it('archives rather than deletes, and refuses edits afterwards', async () => {
    const productId = await createProductRow(db, { sellerId: seller.sellerId });
    const archived = await catalog.archiveProduct({
      productId,
      sellerId: seller.sellerId,
      actorUserId: seller.userId,
    });
    expect(archived.status).toBe('archived');

    const refusal = await domainRejection(
      catalog.updateProduct({
        productId,
        sellerId: seller.sellerId,
        actorUserId: seller.userId,
        changes: { title: 'Edited After Archiving' },
      }),
    );
    expect(refusal.domainCode).toBe('PRODUCT_ARCHIVED');
  });

  /** Those units are promised to bidders, so stock cannot be pulled from under them. */
  it('refuses a stock reduction below what live auctions hold', async () => {
    const productId = await createProductRow(db, { sellerId: seller.sellerId, stockQuantity: 2 });
    const auctionRow = await db.query<{ id: string }>(
      `INSERT INTO auctions (product_id, seller_id, title, bid_fee_minor, min_bid_minor,
         max_bid_minor, bid_increment_minor, max_bids_per_user, starts_at, ends_at, status)
       VALUES ($1, $2, 'Holder', 500, 100, 5000, 100, 25,
               now() - interval '1 hour', now() + interval '1 hour', 'scheduled')
       RETURNING id`,
      [productId, seller.sellerId],
    );
    await catalog.reserveUnitStandalone({ productId, auctionId: auctionRow.rows[0]!.id });

    const refusal = await domainRejection(
      catalog.updateProduct({
        productId,
        sellerId: seller.sellerId,
        actorUserId: seller.userId,
        changes: { stockQuantity: 0 },
      }),
    );
    expect(refusal.domainCode).toBe('INSUFFICIENT_INVENTORY');

    // Reducing to exactly what is held is fine.
    const reduced = await catalog.updateProduct({
      productId,
      sellerId: seller.sellerId,
      actorUserId: seller.userId,
      changes: { stockQuantity: 1 },
    });
    expect(reduced.stockQuantity).toBe(1);
  });

  /** Walk every page, following the cursor exactly as a client would. */
  async function pageThrough(sellerId: string, limit: number): Promise<string[]> {
    const seen: string[] = [];
    let cursor: catalog.ProductCursor | undefined;
    for (let guard = 0; guard < 50; guard += 1) {
      const page = await catalog.listProducts({ sellerId, limit, cursor });
      seen.push(...page.products.map((product) => product.id));
      if (page.nextCursor === null) return seen;
      cursor = page.nextCursor;
    }
    throw new Error('pagination did not terminate');
  }

  it('pages without repeating or skipping a product', async () => {
    const pagingSeller = await createSeller(db);
    for (let index = 0; index < 7; index += 1) {
      await createProductRow(db, { sellerId: pagingSeller.sellerId });
    }

    const seen = await pageThrough(pagingSeller.sellerId, 3);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  /**
   * The regression this pins: `timestamptz` keeps microseconds and a
   * JavaScript `Date` keeps milliseconds, so a cursor round-tripped through a
   * `Date` named a coarser instant than the row it came from and the rows
   * sharing that millisecond were dropped from the next page. Inserting
   * explicit microsecond timestamps makes it deterministic; created naturally
   * it only showed up when a page boundary happened to land inside a
   * millisecond, which is why it read as a flaky test.
   */
  it('pages across products created within the same millisecond', async () => {
    const pagingSeller = await createSeller(db);
    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      ids.push(await createProductRow(db, { sellerId: pagingSeller.sellerId }));
    }
    // Descending order, with a same-millisecond pair straddling the boundary of
    // the first page: the truncated cursor taken from .500900 sorted after
    // .500100, so the second page began past it. The pair has to straddle the
    // boundary — a pair inside one page is unaffected.
    const stamps = [
      '2026-01-01T00:00:00.600000Z',
      '2026-01-01T00:00:00.500900Z', // last row of page one
      '2026-01-01T00:00:00.500100Z', // the row that used to disappear
      '2026-01-01T00:00:00.400000Z',
    ];
    for (const [index, id] of ids.entries()) {
      await db.query('UPDATE products SET created_at = $2::timestamptz WHERE id = $1', [id, stamps[index]]);
    }

    const seen = await pageThrough(pagingSeller.sellerId, 2);
    expect(new Set(seen)).toEqual(new Set(ids));
    expect(seen).toHaveLength(4);
  });
});

describe('product images', () => {
  it('registers images, makes the first primary, and reorders', async () => {
    const productId = await createProductRow(db, { sellerId: seller.sellerId });
    const tickets = [];
    for (let index = 0; index < 3; index += 1) {
      tickets.push(
        await catalog.createImageUploadSlot({
          productId,
          sellerId: seller.sellerId,
          actorUserId: seller.userId,
          contentType: 'image/jpeg',
          sizeBytes: 1024,
          altText: `Image ${index + 1}`,
        }),
      );
    }

    // The slot is a presigned PUT for a server-generated key.
    expect(tickets[0]?.method).toBe('PUT');
    expect(tickets[0]?.uploadUrl).toContain('X-Amz-Signature=');
    expect(tickets[0]?.headers['content-type']).toBe('image/jpeg');

    const withImages = await catalog.getProduct(productId);
    expect(withImages.images).toHaveLength(3);
    expect(withImages.images[0]?.isPrimary).toBe(true);
    expect(withImages.images.map((image) => image.position)).toEqual([0, 1, 2]);
    // The stored value is a bucket key under the owning seller and product.
    expect(withImages.images[0]?.storageKey).toContain(`products/${seller.sellerId}/${productId}/`);

    const reordered = await catalog.reorderProductImages({
      productId,
      sellerId: seller.sellerId,
      actorUserId: seller.userId,
      imageIds: [tickets[2]!.imageId, tickets[0]!.imageId, tickets[1]!.imageId],
    });
    expect(reordered.map((image) => image.id)).toEqual([
      tickets[2]!.imageId,
      tickets[0]!.imageId,
      tickets[1]!.imageId,
    ]);
    expect(reordered[0]?.isPrimary).toBe(true);
    expect(reordered.filter((image) => image.isPrimary)).toHaveLength(1);
  });

  it('refuses a reorder that does not list every image', async () => {
    const productId = await createProductRow(db, { sellerId: seller.sellerId });
    const first = await catalog.createImageUploadSlot({
      productId,
      sellerId: seller.sellerId,
      actorUserId: seller.userId,
      contentType: 'image/png',
      sizeBytes: 2048,
    });
    await catalog.createImageUploadSlot({
      productId,
      sellerId: seller.sellerId,
      actorUserId: seller.userId,
      contentType: 'image/png',
      sizeBytes: 2048,
    });

    const partial = await domainRejection(
      catalog.reorderProductImages({
        productId,
        sellerId: seller.sellerId,
        actorUserId: seller.userId,
        imageIds: [first.imageId],
      }),
    );
    expect(partial.publicMessage).toMatch(/must list every image/);

    const repeated = await domainRejection(
      catalog.reorderProductImages({
        productId,
        sellerId: seller.sellerId,
        actorUserId: seller.userId,
        imageIds: [first.imageId, first.imageId],
      }),
    );
    expect(repeated.publicMessage).toMatch(/same image twice/);
  });

  it('closes the gap and keeps a primary after a deletion', async () => {
    const productId = await createProductRow(db, { sellerId: seller.sellerId });
    const slots = [];
    for (let index = 0; index < 3; index += 1) {
      slots.push(
        await catalog.createImageUploadSlot({
          productId,
          sellerId: seller.sellerId,
          actorUserId: seller.userId,
          contentType: 'image/webp',
          sizeBytes: 512,
        }),
      );
    }

    // Remove the primary; the next image must take over.
    await catalog.deleteProductImage({
      productId,
      imageId: slots[0]!.imageId,
      sellerId: seller.sellerId,
      actorUserId: seller.userId,
    });

    const remaining = await catalog.getProduct(productId);
    expect(remaining.images).toHaveLength(2);
    expect(remaining.images.map((image) => image.position)).toEqual([0, 1]);
    expect(remaining.images.filter((image) => image.isPrimary)).toHaveLength(1);
    expect(remaining.images[0]?.id).toBe(slots[1]!.imageId);
  });

  it('refuses more images than the limit', async () => {
    const productId = await createProductRow(db, { sellerId: seller.sellerId });
    for (let index = 0; index < catalog.MAX_PRODUCT_IMAGES; index += 1) {
      await catalog.createImageUploadSlot({
        productId,
        sellerId: seller.sellerId,
        actorUserId: seller.userId,
        contentType: 'image/jpeg',
        sizeBytes: 1024,
      });
    }
    const refusal = await domainRejection(
      catalog.createImageUploadSlot({
        productId,
        sellerId: seller.sellerId,
        actorUserId: seller.userId,
        contentType: 'image/jpeg',
        sizeBytes: 1024,
      }),
    );
    expect(refusal.domainCode).toBe('IMAGE_LIMIT_REACHED');
  });

  it('refuses images on another seller’s product', async () => {
    const other = await createSeller(db);
    const productId = await createProductRow(db, { sellerId: other.sellerId });
    const refusal = await domainRejection(
      catalog.createImageUploadSlot({
        productId,
        sellerId: seller.sellerId,
        actorUserId: seller.userId,
        contentType: 'image/jpeg',
        sizeBytes: 1024,
      }),
    );
    expect(refusal.domainCode).toBe('PRODUCT_NOT_OWNED');
  });
});

describe('inventory', () => {
  it('reserves and releases idempotently', async () => {
    const productId = await createProductRow(db, { sellerId: seller.sellerId, stockQuantity: 2 });
    const auctionRow = await db.query<{ id: string }>(
      `INSERT INTO auctions (product_id, seller_id, title, bid_fee_minor, min_bid_minor,
         max_bid_minor, bid_increment_minor, max_bids_per_user, starts_at, ends_at, status)
       VALUES ($1, $2, 'Reserver', 500, 100, 5000, 100, 25,
               now() - interval '1 hour', now() + interval '1 hour', 'scheduled')
       RETURNING id`,
      [productId, seller.sellerId],
    );
    const auctionId = auctionRow.rows[0]!.id;

    const first = await catalog.reserveUnitStandalone({ productId, auctionId });
    expect(first.created).toBe(true);
    const replay = await catalog.reserveUnitStandalone({ productId, auctionId });
    expect(replay.created).toBe(false);
    expect(replay.reservation.id).toBe(first.reservation.id);

    expect(await readInventory(db, productId)).toMatchObject({
      stock: 2,
      reserved: 1,
      heldRows: 1,
    });
    expect(await countAuditEvents(db, { entityId: productId, action: 'inventory.reserved' })).toBe(1);

    const report = await catalog.reconcileProductInventory(productId);
    expect(report).toMatchObject({ consistent: true, cachedReserved: 1, heldReserved: 1 });
  });

  /**
   * Detects, never repairs — the same reasoning as wallet reconciliation. A
   * disagreement is evidence of a bug, and rewriting the count would destroy it.
   */
  it('detects a cached reserved count that no longer matches, and leaves it alone', async () => {
    const productId = await createProductRow(db, { sellerId: seller.sellerId, stockQuantity: 3 });
    await db.query(`UPDATE products SET reserved_quantity = 2 WHERE id = $1`, [productId]);

    const report = await catalog.reconcileProductInventory(productId);
    expect(report.consistent).toBe(false);
    expect(report.cachedReserved).toBe(2);
    expect(report.heldReserved).toBe(0);

    expect((await readInventory(db, productId)).reserved).toBe(2);
    expect(
      await countAuditEvents(db, { entityId: productId, action: 'inventory.reconciliation_failed' }),
    ).toBe(1);
  });

  it('refuses to reserve beyond the stock that exists', async () => {
    const productId = await createProductRow(db, { sellerId: seller.sellerId, stockQuantity: 1 });
    const auctionIds: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const row = await db.query<{ id: string }>(
        `INSERT INTO auctions (product_id, seller_id, title, bid_fee_minor, min_bid_minor,
           max_bid_minor, bid_increment_minor, max_bids_per_user, starts_at, ends_at, status)
         VALUES ($1, $2, 'Contender', 500, 100, 5000, 100, 25,
                 now() - interval '1 hour', now() + interval '1 hour', 'scheduled')
         RETURNING id`,
        [productId, seller.sellerId],
      );
      auctionIds.push(row.rows[0]!.id);
    }

    await catalog.reserveUnitStandalone({ productId, auctionId: auctionIds[0]! });
    const refusal = await domainRejection(
      catalog.reserveUnitStandalone({ productId, auctionId: auctionIds[1]! }),
    );
    expect(refusal.domainCode).toBe('INSUFFICIENT_INVENTORY');
    expect(await readInventory(db, productId)).toMatchObject({ reserved: 1, heldRows: 1 });
  });

  it('never oversells under concurrent reservation attempts', async () => {
    const productId = await createProductRow(db, { sellerId: seller.sellerId, stockQuantity: 3 });
    const auctionIds: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const row = await db.query<{ id: string }>(
        `INSERT INTO auctions (product_id, seller_id, title, bid_fee_minor, min_bid_minor,
           max_bid_minor, bid_increment_minor, max_bids_per_user, starts_at, ends_at, status)
         VALUES ($1, $2, 'Crowd', 500, 100, 5000, 100, 25,
                 now() - interval '1 hour', now() + interval '1 hour', 'scheduled')
         RETURNING id`,
        [productId, seller.sellerId],
      );
      auctionIds.push(row.rows[0]!.id);
    }

    const { fulfilled, domainErrors, otherErrors } = await settle(
      auctionIds.map((auctionId) => catalog.reserveUnitStandalone({ productId, auctionId })),
    );

    expect(otherErrors).toEqual([]);
    expect(fulfilled).toHaveLength(3);
    expect(domainErrors).toHaveLength(7);
    expect(new Set(domainErrors)).toEqual(new Set(['INSUFFICIENT_INVENTORY']));

    expect(await readInventory(db, productId)).toMatchObject({
      stock: 3,
      reserved: 3,
      heldRows: 3,
    });
    expect((await catalog.reconcileProductInventory(productId)).consistent).toBe(true);
  });
});
