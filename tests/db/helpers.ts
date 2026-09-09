import pg from 'pg';

/**
 * Helpers for the integration suite that runs against real PostgreSQL.
 *
 * Every test file opens one connection and one outer transaction that is rolled
 * back at the end, so the suite never leaves rows behind and never depends on
 * the seed data. Operations expected to fail run inside a SAVEPOINT, because a
 * constraint violation aborts the surrounding transaction.
 */
export async function connect(): Promise<pg.Client> {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    throw new Error(
      'DATABASE_URL is required for the database suite. Run `npm run docker:up` and `npm run migrate` first.',
    );
  }
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}

export interface DatabaseFailure {
  readonly code: string;
  readonly message: string;
  readonly constraint: string | undefined;
}

/**
 * Run `operation` expecting PostgreSQL to reject it, and return the error for
 * assertion. Fails loudly if the operation is accepted — a constraint that
 * silently permits invalid data is the exact defect these tests exist to catch.
 */
export async function expectRejected(
  client: pg.Client,
  operation: () => Promise<unknown>,
): Promise<DatabaseFailure> {
  await client.query('SAVEPOINT expect_rejected');
  let caught: unknown;
  let accepted = false;
  try {
    await operation();
    accepted = true;
  } catch (error) {
    caught = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expect_rejected');

  if (accepted) {
    throw new Error('Expected PostgreSQL to reject this operation, but it was accepted');
  }

  const error = caught as { code?: unknown; message?: unknown; constraint?: unknown };
  return {
    code: typeof error.code === 'string' ? error.code : 'unknown',
    message: typeof error.message === 'string' ? error.message : String(caught),
    constraint: typeof error.constraint === 'string' ? error.constraint : undefined,
  };
}

export interface Fixtures {
  readonly userId: string;
  readonly otherUserId: string;
  readonly sellerId: string;
  readonly categoryId: string;
  readonly productId: string;
  readonly auctionId: string;
  readonly walletId: string;
}

/** Build a self-contained graph of rows for one test file. */
export async function createFixtures(client: pg.Client, tag: string): Promise<Fixtures> {
  const user = await client.query<{ id: string }>(
    `INSERT INTO users (email, display_name, status) VALUES ($1, $2, 'active') RETURNING id`,
    [`${tag}-bidder@test.local`, `${tag} bidder`],
  );
  const otherUser = await client.query<{ id: string }>(
    `INSERT INTO users (email, display_name, status) VALUES ($1, $2, 'active') RETURNING id`,
    [`${tag}-other@test.local`, `${tag} other`],
  );
  const sellerUser = await client.query<{ id: string }>(
    `INSERT INTO users (email, display_name, status) VALUES ($1, $2, 'active') RETURNING id`,
    [`${tag}-seller@test.local`, `${tag} seller`],
  );

  const seller = await client.query<{ id: string }>(
    `INSERT INTO sellers (user_id, display_name, status, approved_at)
     VALUES ($1, $2, 'approved', now()) RETURNING id`,
    [sellerUser.rows[0]!.id, `${tag} shop`],
  );
  const category = await client.query<{ id: string }>(
    `INSERT INTO categories (slug, name) VALUES ($1, $2) RETURNING id`,
    [`${tag}-category`, `${tag} category`],
  );
  const product = await client.query<{ id: string }>(
    `INSERT INTO products (seller_id, category_id, slug, title, retail_price_minor, stock_quantity, status)
     VALUES ($1, $2, $3, $4, 5000000, 10, 'active') RETURNING id`,
    [seller.rows[0]!.id, category.rows[0]!.id, `${tag}-product`, `${tag} product`],
  );
  const auction = await client.query<{ id: string }>(
    `INSERT INTO auctions
       (product_id, seller_id, title, bid_fee_minor, min_bid_minor, max_bid_minor,
        max_bids_per_user, starts_at, ends_at, status)
     VALUES ($1, $2, $3, 500, 100, 50000, 25,
             now() - interval '1 hour', now() + interval '1 hour', 'live')
     RETURNING id`,
    [product.rows[0]!.id, seller.rows[0]!.id, `${tag} auction`],
  );
  const wallet = await client.query<{ id: string }>(
    `INSERT INTO wallets (user_id, currency) VALUES ($1, 'ETB') RETURNING id`,
    [user.rows[0]!.id],
  );

  return {
    userId: user.rows[0]!.id,
    otherUserId: otherUser.rows[0]!.id,
    sellerId: seller.rows[0]!.id,
    categoryId: category.rows[0]!.id,
    productId: product.rows[0]!.id,
    auctionId: auction.rows[0]!.id,
    walletId: wallet.rows[0]!.id,
  };
}
