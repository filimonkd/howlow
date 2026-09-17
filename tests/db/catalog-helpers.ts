import pg from 'pg';
import type * as CatalogModule from '@howlow/api/modules/catalog';
import type { Role } from '@howlow/shared';
import { loadEnvFile } from '../../scripts/load-env.mjs';

/**
 * Helpers for the catalog and auction suites.
 *
 * These exercise real services against real PostgreSQL: the point is the
 * behaviour of real transactions and real row locks, which no mock can
 * demonstrate. Rows are therefore created for real and cleaned up afterwards.
 */
export const TEST_EMAIL_DOMAIN = 'catalog-suite.test.local';

let counter = 0;
const unique = (): string => {
  counter += 1;
  return `${Date.now().toString(36)}${counter.toString(36)}`;
};

export async function adminClient(): Promise<pg.Client> {
  await loadEnvFile();
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    throw new Error('DATABASE_URL is required for the catalog suite.');
  }
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}

export async function createUser(
  client: pg.Client,
  options: { readonly roles?: readonly Role[] } = {},
): Promise<string> {
  const tag = unique();
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO users (email, display_name, status)
     VALUES ($1, $2, 'active') RETURNING id`,
    [`user-${tag}@${TEST_EMAIL_DOMAIN}`, `Catalog suite ${tag}`],
  );
  const userId = rows[0]!.id;
  for (const role of options.roles ?? []) {
    await client.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, $2)`, [userId, role]);
  }
  return userId;
}

/** An approved seller, which is what most catalog writes require. */
export async function createSeller(
  client: pg.Client,
  options: { readonly status?: 'pending' | 'approved' | 'suspended' } = {},
): Promise<{ userId: string; sellerId: string }> {
  const userId = await createUser(client, { roles: ['seller'] });
  const status = options.status ?? 'approved';
  const { rows } = await client.query<{ id: string }>(
    // $3 is cast explicitly at each use: without it PostgreSQL cannot deduce
    // one type for a parameter used as both an enum and a text comparison.
    `INSERT INTO sellers (user_id, display_name, status, approved_at)
     VALUES ($1, $2, $3::seller_status,
             CASE WHEN $3::text = 'approved' THEN now() ELSE NULL END)
     RETURNING id`,
    [userId, `Shop ${unique()}`, status],
  );
  return { userId, sellerId: rows[0]!.id };
}

export async function createCategory(
  client: pg.Client,
  options: { readonly isActive?: boolean } = {},
): Promise<{ id: string; slug: string }> {
  const slug = `cat-${unique()}`;
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO categories (slug, name, is_active) VALUES ($1, $2, $3) RETURNING id`,
    [slug, `Category ${slug}`, options.isActive ?? true],
  );
  return { id: rows[0]!.id, slug };
}

/**
 * An active product with stock, created directly so a test can set up a
 * scenario without going through the service under test.
 */
export async function createProductRow(
  client: pg.Client,
  input: {
    sellerId: string;
    categoryId?: string | undefined;
    stockQuantity?: number | undefined;
    status?: 'draft' | 'active' | 'archived' | undefined;
  },
): Promise<string> {
  const slug = `prod-${unique()}`;
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO products
       (seller_id, category_id, slug, title, description, retail_price_minor,
        stock_quantity, status)
     VALUES ($1, $2, $3, $4, $5, 12000000, $6, $7) RETURNING id`,
    [
      input.sellerId,
      input.categoryId ?? null,
      slug,
      `Product ${slug}`,
      'A description long enough to satisfy the service validation rules.',
      input.stockQuantity ?? 1,
      input.status ?? 'active',
    ],
  );
  return rows[0]!.id;
}

export interface AuctionTermsFixture {
  readonly title: string;
  readonly description: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly minBidMinor: bigint;
  readonly maxBidMinor: bigint;
  readonly bidIncrementMinor: bigint;
  readonly maxBidsPerUser: number;
  readonly bidFeeMinor: bigint;
  readonly winnerPaymentHours: number;
  readonly currency: 'ETB';
}

/** Terms that pass every validation rule, for tests about something else. */
export function validAuctionTerms(overrides: Partial<AuctionTermsFixture> = {}): AuctionTermsFixture {
  return {
    title: `Auction ${unique()}`,
    description: 'An auction description long enough to satisfy validation.',
    startsAt: new Date(Date.now() + 60_000),
    endsAt: new Date(Date.now() + 3_600_000),
    minBidMinor: 100n,
    maxBidMinor: 5000n,
    bidIncrementMinor: 100n,
    maxBidsPerUser: 25,
    bidFeeMinor: 500n,
    winnerPaymentHours: 48,
    currency: 'ETB',
    ...overrides,
  };
}

/**
 * Move an auction's schedule into the past so it is due.
 *
 * Written straight to the database rather than through the service, because the
 * service correctly refuses to set a deadline in the past — the point of these
 * tests is what the worker does once a deadline has genuinely passed.
 */
export async function backdateSchedule(
  client: pg.Client,
  input: { auctionId: string; startsAt: string; endsAt: string },
): Promise<void> {
  await client.query(
    `UPDATE auctions SET starts_at = now() - $2::interval, ends_at = now() - $3::interval
      WHERE id = $1`,
    [input.auctionId, input.startsAt, input.endsAt],
  );
}

export async function readAuctionRow(
  client: pg.Client,
  auctionId: string,
): Promise<{
  status: string;
  openedAt: Date | null;
  closingAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  suspendedFrom: string | null;
}> {
  const { rows } = await client.query<{
    status: string;
    opened_at: Date | null;
    closing_at: Date | null;
    cancelled_at: Date | null;
    cancel_reason: string | null;
    suspended_from: string | null;
  }>(
    `SELECT status, opened_at, closing_at, cancelled_at, cancel_reason, suspended_from
       FROM auctions WHERE id = $1`,
    [auctionId],
  );
  const row = rows[0]!;
  return {
    status: row.status,
    openedAt: row.opened_at,
    closingAt: row.closing_at,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    suspendedFrom: row.suspended_from,
  };
}

export async function readInventory(
  client: pg.Client,
  productId: string,
): Promise<{ stock: number; reserved: number; heldRows: number; releasedRows: number }> {
  const { rows } = await client.query<{
    stock_quantity: number;
    reserved_quantity: number;
    held: string;
    released: string;
  }>(
    `SELECT p.stock_quantity, p.reserved_quantity,
            COUNT(*) FILTER (WHERE r.state = 'held')::text AS held,
            COUNT(*) FILTER (WHERE r.state = 'released')::text AS released
       FROM products p
       LEFT JOIN inventory_reservations r ON r.product_id = p.id
      WHERE p.id = $1
      GROUP BY p.stock_quantity, p.reserved_quantity`,
    [productId],
  );
  const row = rows[0]!;
  return {
    stock: row.stock_quantity,
    reserved: row.reserved_quantity,
    heldRows: Number(row.held),
    releasedRows: Number(row.released),
  };
}

export async function countAuditEvents(
  client: pg.Client,
  input: { entityId: string; action: string },
): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM audit_logs WHERE entity_id = $1 AND action = $2`,
    [input.entityId, input.action],
  );
  return Number(rows[0]!.count);
}

/** An operation expected to fail, with its stable domain code. */
export async function domainRejection(operation: Promise<unknown>): Promise<{
  code: string;
  domainCode: string;
  publicMessage: string;
  message: string;
}> {
  try {
    await operation;
  } catch (error) {
    const app = error as {
      code?: unknown;
      publicMessage?: unknown;
      message?: unknown;
      details?: {
        catalogError?: unknown;
        auctionError?: unknown;
        bidError?: unknown;
        resultError?: unknown;
      };
    };
    const domainCode = [
      app.details?.bidError,
      app.details?.auctionError,
      app.details?.catalogError,
      app.details?.resultError,
    ].find((code): code is string => typeof code === 'string');
    return {
      code: typeof app.code === 'string' ? app.code : 'UNKNOWN',
      domainCode: domainCode ?? 'NOT_A_DOMAIN_ERROR',
      publicMessage: typeof app.publicMessage === 'string' ? app.publicMessage : String(app.message),
      message: typeof app.message === 'string' ? app.message : String(error),
    };
  }
  throw new Error('Expected the operation to be rejected, but it succeeded');
}

/** Settle concurrent operations without one rejection hiding the others. */
export async function settle<T>(
  operations: readonly Promise<T>[],
): Promise<{ fulfilled: T[]; domainErrors: string[]; otherErrors: unknown[] }> {
  const results = await Promise.allSettled(operations);
  const fulfilled: T[] = [];
  const domainErrors: string[] = [];
  const otherErrors: unknown[] = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      fulfilled.push(result.value);
      continue;
    }
    const details = (
      result.reason as {
        details?: {
          catalogError?: unknown;
          auctionError?: unknown;
          bidError?: unknown;
          resultError?: unknown;
        };
      }
    ).details;
    const code = details?.bidError ?? details?.auctionError ?? details?.catalogError ?? details?.resultError;
    if (typeof code === 'string') domainErrors.push(code);
    else otherErrors.push(result.reason);
  }
  return { fulfilled, domainErrors, otherErrors };
}

/**
 * Remove everything these suites created.
 *
 * `audit_logs` is append-only and products, sellers and auctions reference
 * users with ON DELETE RESTRICT — correct production behaviour, and exactly
 * what the schema guarantees. Teardown drops to
 * `session_replication_role = 'replica'` for one transaction, which suspends
 * triggers and referential actions. A test-only escape hatch: no application
 * code may do it, and the guarantees it bypasses are asserted by
 * tests/db/immutability.test.ts.
 */
export async function cleanup(client: pg.Client): Promise<void> {
  const domain = `%@${TEST_EMAIL_DOMAIN}`;
  const users = `SELECT id FROM users WHERE email LIKE $1`;
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL session_replication_role = 'replica'");
    const sellers = `SELECT id FROM sellers WHERE user_id IN (${users})`;
    const products = `SELECT id FROM products WHERE seller_id IN (${sellers})`;
    const auctions = `SELECT id FROM auctions WHERE seller_id IN (${sellers})`;
    // Results and orders reference the auction (and the winning bid) with ON
    // DELETE RESTRICT, so they go first or the auction delete below is refused.
    // `auction_results` is append-only by trigger; the replica role above is
    // what makes a test teardown able to remove one at all.
    await client.query(`DELETE FROM orders WHERE auction_id IN (${auctions})`, [domain]);
    await client.query(`DELETE FROM orders WHERE user_id IN (${users})`, [domain]);
    await client.query(`DELETE FROM auction_results WHERE auction_id IN (${auctions})`, [domain]);
    // Bids and participants reference both the auction and the bidder, so they
    // go before either. `idempotency_keys` is keyed by the submitting user.
    await client.query(`DELETE FROM bids WHERE auction_id IN (${auctions})`, [domain]);
    await client.query(`DELETE FROM bids WHERE user_id IN (${users})`, [domain]);
    await client.query(`DELETE FROM auction_participants WHERE auction_id IN (${auctions})`, [domain]);
    await client.query(`DELETE FROM auction_participants WHERE user_id IN (${users})`, [domain]);
    await client.query(`DELETE FROM idempotency_keys WHERE user_id IN (${users})`, [domain]);
    await client.query(`DELETE FROM inventory_reservations WHERE product_id IN (${products})`, [domain]);
    await client.query(`DELETE FROM auctions WHERE seller_id IN (${sellers})`, [domain]);
    await client.query(`DELETE FROM product_images WHERE product_id IN (${products})`, [domain]);
    await client.query(`DELETE FROM products WHERE seller_id IN (${sellers})`, [domain]);
    await client.query(`DELETE FROM sellers WHERE user_id IN (${users})`, [domain]);
    await client.query(`DELETE FROM audit_logs WHERE actor_user_id IN (${users})`, [domain]);
    await client.query(`DELETE FROM wallet_entries WHERE user_id IN (${users})`, [domain]);
    await client.query(`DELETE FROM wallets WHERE user_id IN (${users})`, [domain]);
    await client.query(`DELETE FROM user_roles WHERE user_id IN (${users})`, [domain]);
    await client.query(`DELETE FROM users WHERE email LIKE $1`, [domain]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

/** Categories are global, so they are cleaned by their generated prefix. */
export async function cleanupCategories(client: pg.Client): Promise<void> {
  await client.query(`DELETE FROM categories WHERE slug LIKE 'cat-%'`);
}

export type CatalogApi = typeof CatalogModule;
