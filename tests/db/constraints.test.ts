import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, createFixtures, expectRejected, type Fixtures } from './helpers.js';

/**
 * These prove the schema rejects invalid data at the database level. Every rule
 * here protects money, bid integrity or auction integrity, and each is written
 * so it would fail if the constraint were dropped — which is the point: an
 * application-level check can be raced past by a concurrent request, a database
 * constraint cannot.
 */
let client: pg.Client;
let fx: Fixtures;

beforeAll(async () => {
  client = await connect();
  await client.query('BEGIN');
  fx = await createFixtures(client, 'constraints');
});

afterAll(async () => {
  await client.query('ROLLBACK');
  await client.end();
});

describe('duplicate-bid rule', () => {
  it('rejects a second valid bid at the same amount by the same user', async () => {
    await client.query(
      `INSERT INTO bids (auction_id, user_id, amount_minor, fee_minor, channel)
       VALUES ($1, $2, 1500, 500, 'web')`,
      [fx.auctionId, fx.userId],
    );

    const failure = await expectRejected(client, () =>
      client.query(
        `INSERT INTO bids (auction_id, user_id, amount_minor, fee_minor, channel)
         VALUES ($1, $2, 1500, 500, 'telegram')`,
        [fx.auctionId, fx.userId],
      ),
    );

    // 23505 unique_violation
    expect(failure.code).toBe('23505');
    expect(failure.constraint).toBe('bids_valid_amount_unique_key');
  });

  it('allows the same amount from a different user — that is the whole game', async () => {
    const inserted = await client.query(
      `INSERT INTO bids (auction_id, user_id, amount_minor, fee_minor, channel)
       VALUES ($1, $2, 1500, 500, 'web') RETURNING id`,
      [fx.auctionId, fx.otherUserId],
    );
    expect(inserted.rowCount).toBe(1);
  });

  it('frees the amount once the earlier bid is voided', async () => {
    await client.query(
      `INSERT INTO bids (auction_id, user_id, amount_minor, fee_minor, channel)
       VALUES ($1, $2, 2500, 500, 'web')`,
      [fx.auctionId, fx.userId],
    );
    await client.query(
      `UPDATE bids SET status = 'void', voided_at = now(), void_reason = 'test'
       WHERE auction_id = $1 AND user_id = $2 AND amount_minor = 2500`,
      [fx.auctionId, fx.userId],
    );

    const rebid = await client.query(
      `INSERT INTO bids (auction_id, user_id, amount_minor, fee_minor, channel)
       VALUES ($1, $2, 2500, 500, 'web') RETURNING id`,
      [fx.auctionId, fx.userId],
    );
    expect(rebid.rowCount).toBe(1);
  });

  it('rejects a replayed idempotency key rather than creating a second bid', async () => {
    await client.query(
      `INSERT INTO bids (auction_id, user_id, amount_minor, fee_minor, channel, idempotency_key)
       VALUES ($1, $2, 3100, 500, 'web', 'idem-key-1')`,
      [fx.auctionId, fx.userId],
    );

    const failure = await expectRejected(client, () =>
      client.query(
        `INSERT INTO bids (auction_id, user_id, amount_minor, fee_minor, channel, idempotency_key)
         VALUES ($1, $2, 3200, 500, 'web', 'idem-key-1')`,
        [fx.auctionId, fx.userId],
      ),
    );
    expect(failure.constraint).toBe('bids_idempotency_key_unique');
  });

  it('rejects a non-positive bid amount', async () => {
    const failure = await expectRejected(client, () =>
      client.query(
        `INSERT INTO bids (auction_id, user_id, amount_minor, fee_minor, channel)
         VALUES ($1, $2, 0, 500, 'web')`,
        [fx.auctionId, fx.userId],
      ),
    );
    // 23514 check_violation
    expect(failure.code).toBe('23514');
    expect(failure.constraint).toBe('bids_amount_positive');
  });
});

describe('auction integrity', () => {
  it('rejects an auction that ends before it starts', async () => {
    const failure = await expectRejected(client, () =>
      client.query(
        `INSERT INTO auctions
           (product_id, seller_id, title, bid_fee_minor, min_bid_minor, max_bid_minor,
            max_bids_per_user, starts_at, ends_at, status)
         VALUES ($1, $2, 'backwards', 500, 100, 50000, 10,
                 now() + interval '2 hours', now() + interval '1 hour', 'draft')`,
        [fx.productId, fx.sellerId],
      ),
    );
    expect(failure.constraint).toBe('auctions_time_range_ordered');
  });

  it('rejects a bid range whose maximum is below its minimum', async () => {
    const failure = await expectRejected(client, () =>
      client.query(
        `INSERT INTO auctions
           (product_id, seller_id, title, bid_fee_minor, min_bid_minor, max_bid_minor,
            max_bids_per_user, starts_at, ends_at, status)
         VALUES ($1, $2, 'inverted range', 500, 50000, 100, 10,
                 now(), now() + interval '1 hour', 'draft')`,
        [fx.productId, fx.sellerId],
      ),
    );
    expect(failure.constraint).toBe('auctions_bid_range_ordered');
  });

  it('rejects a maximum-bids-per-user of zero', async () => {
    const failure = await expectRejected(client, () =>
      client.query(
        `INSERT INTO auctions
           (product_id, seller_id, title, bid_fee_minor, min_bid_minor, max_bid_minor,
            max_bids_per_user, starts_at, ends_at, status)
         VALUES ($1, $2, 'no bids allowed', 500, 100, 50000, 0,
                 now(), now() + interval '1 hour', 'draft')`,
        [fx.productId, fx.sellerId],
      ),
    );
    expect(failure.constraint).toBe('auctions_max_bids_per_user_positive');
  });

  it('rejects any result algorithm other than LUB_V1', async () => {
    const failure = await expectRejected(client, () =>
      client.query(
        `INSERT INTO auctions
           (product_id, seller_id, title, bid_fee_minor, min_bid_minor, max_bid_minor,
            max_bids_per_user, starts_at, ends_at, status, algorithm_version)
         VALUES ($1, $2, 'other algorithm', 500, 100, 50000, 10,
                 now(), now() + interval '1 hour', 'draft', 'LUB_V2')`,
        [fx.productId, fx.sellerId],
      ),
    );
    expect(failure.constraint).toBe('auctions_algorithm_is_lub_v1');
  });

  it('rejects a second participation row for the same user in one auction', async () => {
    await client.query(
      `INSERT INTO auction_participants (auction_id, user_id, joined_channel)
       VALUES ($1, $2, 'web')`,
      [fx.auctionId, fx.userId],
    );
    const failure = await expectRejected(client, () =>
      client.query(
        `INSERT INTO auction_participants (auction_id, user_id, joined_channel)
         VALUES ($1, $2, 'telegram')`,
        [fx.auctionId, fx.userId],
      ),
    );
    expect(failure.constraint).toBe('auction_participants_unique_key');
  });
});

describe('catalog integrity', () => {
  it('rejects negative product stock', async () => {
    const failure = await expectRejected(client, () =>
      client.query(`UPDATE products SET stock_quantity = -1 WHERE id = $1`, [fx.productId]),
    );
    expect(failure.code).toBe('23514');
    expect(failure.constraint).toBe('products_stock_non_negative');
  });

  it('rejects a non-positive retail price', async () => {
    const failure = await expectRejected(client, () =>
      client.query(`UPDATE products SET retail_price_minor = 0 WHERE id = $1`, [fx.productId]),
    );
    expect(failure.constraint).toBe('products_retail_price_positive');
  });

  it('allows only one primary image per product', async () => {
    await client.query(
      `INSERT INTO product_images (product_id, storage_key, position, is_primary)
       VALUES ($1, 'a.jpg', 0, true)`,
      [fx.productId],
    );
    const failure = await expectRejected(client, () =>
      client.query(
        `INSERT INTO product_images (product_id, storage_key, position, is_primary)
         VALUES ($1, 'b.jpg', 1, true)`,
        [fx.productId],
      ),
    );
    expect(failure.constraint).toBe('product_images_primary_key');
  });
});

describe('wallet integrity', () => {
  it('rejects a negative available balance', async () => {
    const failure = await expectRejected(client, () =>
      client.query(`UPDATE wallets SET available_minor = -1 WHERE id = $1`, [fx.walletId]),
    );
    expect(failure.code).toBe('23514');
    expect(failure.constraint).toBe('wallets_available_non_negative');
  });

  it('rejects a negative reserved balance', async () => {
    const failure = await expectRejected(client, () =>
      client.query(`UPDATE wallets SET reserved_minor = -5 WHERE id = $1`, [fx.walletId]),
    );
    expect(failure.constraint).toBe('wallets_reserved_non_negative');
  });

  it('rejects a second wallet for the same user and currency', async () => {
    const failure = await expectRejected(client, () =>
      client.query(`INSERT INTO wallets (user_id, currency) VALUES ($1, 'ETB')`, [fx.userId]),
    );
    expect(failure.constraint).toBe('wallets_user_currency_key');
  });

  it('rejects a zero-value ledger entry', async () => {
    const failure = await expectRejected(client, () =>
      client.query(
        `INSERT INTO wallet_entries
           (wallet_id, user_id, seq, entry_type, currency, amount_minor, balance_after_minor)
         VALUES ($1, $2, (SELECT COALESCE(MAX(seq), 0) + 1 FROM wallet_entries WHERE wallet_id = $1), 'admin_credit', 'ETB', 0, 0)`,
        [fx.walletId, fx.userId],
      ),
    );
    expect(failure.constraint).toBe('wallet_entries_amount_non_zero');
  });

  it('rejects a ledger entry leaving a negative balance', async () => {
    const failure = await expectRejected(client, () =>
      client.query(
        `INSERT INTO wallet_entries
           (wallet_id, user_id, seq, entry_type, currency, amount_minor, balance_after_minor)
         VALUES ($1, $2, (SELECT COALESCE(MAX(seq), 0) + 1 FROM wallet_entries WHERE wallet_id = $1), 'bid_fee', 'ETB', -500, -500)`,
        [fx.walletId, fx.userId],
      ),
    );
    expect(failure.constraint).toBe('wallet_entries_balance_non_negative');
  });

  it('rejects a replayed ledger idempotency key', async () => {
    await client.query(
      `INSERT INTO wallet_entries
         (wallet_id, user_id, seq, entry_type, currency, amount_minor, balance_after_minor, idempotency_key)
       VALUES ($1, $2, (SELECT COALESCE(MAX(seq), 0) + 1 FROM wallet_entries WHERE wallet_id = $1), 'deposit', 'ETB', 10000, 10000, 'ledger-key-1')`,
      [fx.walletId, fx.userId],
    );
    const failure = await expectRejected(client, () =>
      client.query(
        `INSERT INTO wallet_entries
           (wallet_id, user_id, seq, entry_type, currency, amount_minor, balance_after_minor, idempotency_key)
         VALUES ($1, $2, (SELECT COALESCE(MAX(seq), 0) + 1 FROM wallet_entries WHERE wallet_id = $1), 'deposit', 'ETB', 10000, 20000, 'ledger-key-1')`,
        [fx.walletId, fx.userId],
      ),
    );
    expect(failure.constraint).toBe('wallet_entries_idempotency_key_unique');
  });

  it('keeps large amounts exact well beyond 2^53', async () => {
    // 90,071,992,547,409.93 ETB in minor units: past the point where a double
    // would start losing whole cents.
    const huge = '9007199254740993';
    const inserted = await client.query<{ balance_after_minor: string }>(
      `INSERT INTO wallet_entries
         (wallet_id, user_id, seq, entry_type, currency, amount_minor, balance_after_minor)
       VALUES ($1, $2, (SELECT COALESCE(MAX(seq), 0) + 1 FROM wallet_entries WHERE wallet_id = $1), 'deposit', 'ETB', $3, $3) RETURNING balance_after_minor`,
      [fx.walletId, fx.userId, huge],
    );
    // Returned as a string by the driver's BIGINT parser, so precision survives.
    expect(inserted.rows[0]?.balance_after_minor).toBe(huge);
  });
});

describe('order integrity', () => {
  it('rejects a total that does not equal the sum of its parts', async () => {
    const failure = await expectRejected(client, () =>
      client.query(
        `INSERT INTO orders
           (order_number, user_id, seller_id, product_id, subtotal_minor,
            shipping_minor, tax_minor, discount_minor, total_minor)
         VALUES ('HL-TEST-1', $1, $2, $3, 10000, 500, 100, 0, 99999)`,
        [fx.userId, fx.sellerId, fx.productId],
      ),
    );
    expect(failure.constraint).toBe('orders_total_is_sum_of_parts');
  });

  it('accepts a total that does', async () => {
    const inserted = await client.query(
      `INSERT INTO orders
         (order_number, user_id, seller_id, product_id, subtotal_minor,
          shipping_minor, tax_minor, discount_minor, total_minor)
       VALUES ('HL-TEST-2', $1, $2, $3, 10000, 500, 100, 200, 10400) RETURNING id`,
      [fx.userId, fx.sellerId, fx.productId],
    );
    expect(inserted.rowCount).toBe(1);
  });
});
