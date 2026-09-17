import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, createFixtures, expectRejected, type Fixtures } from './helpers.js';

/**
 * Append-only tables and immutability triggers. These records are financial and
 * legal evidence; the guarantee that they cannot be rewritten has to live in the
 * database, because the code that would rewrite them is the code being audited.
 */
let client: pg.Client;
let fx: Fixtures;

beforeAll(async () => {
  client = await connect();
  await client.query('BEGIN');
  fx = await createFixtures(client, 'immutability');
});

afterAll(async () => {
  await client.query('ROLLBACK');
  await client.end();
});

describe('wallet_entries is append-only', () => {
  it('refuses UPDATE and DELETE', async () => {
    const entry = await client.query<{ id: string }>(
      `INSERT INTO wallet_entries
         (wallet_id, user_id, seq, entry_type, currency, amount_minor, balance_after_minor)
       VALUES ($1, $2, (SELECT COALESCE(MAX(seq), 0) + 1 FROM wallet_entries WHERE wallet_id = $1), 'deposit', 'ETB', 5000, 5000) RETURNING id`,
      [fx.walletId, fx.userId],
    );
    const id = entry.rows[0]!.id;

    const onUpdate = await expectRejected(client, () =>
      client.query(`UPDATE wallet_entries SET amount_minor = 999999 WHERE id = $1`, [id]),
    );
    expect(onUpdate.message).toMatch(/append-only/);

    const onDelete = await expectRejected(client, () =>
      client.query(`DELETE FROM wallet_entries WHERE id = $1`, [id]),
    );
    expect(onDelete.message).toMatch(/append-only/);
  });
});

describe('audit_logs is append-only', () => {
  it('refuses UPDATE and DELETE', async () => {
    const log = await client.query<{ id: string }>(
      `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id)
       VALUES ($1, 'test.action', 'auction', $2) RETURNING id`,
      [fx.userId, fx.auctionId],
    );
    const id = log.rows[0]!.id;

    const onUpdate = await expectRejected(client, () =>
      client.query(`UPDATE audit_logs SET action = 'tampered' WHERE id = $1`, [id]),
    );
    expect(onUpdate.message).toMatch(/append-only/);

    const onDelete = await expectRejected(client, () =>
      client.query(`DELETE FROM audit_logs WHERE id = $1`, [id]),
    );
    expect(onDelete.message).toMatch(/append-only/);
  });
});

describe('auction_results is immutable', () => {
  it('accepts one result then refuses to change or remove it', async () => {
    await client.query(
      `INSERT INTO auction_results
         (auction_id, outcome, total_bids, total_valid_bids, unique_amount_count,
          participant_count, frozen_bid_checksum)
       VALUES ($1, 'no_unique_bid', 10, 9, 0, 3, 'sha256:test')`,
      [fx.auctionId],
    );

    const onUpdate = await expectRejected(client, () =>
      client.query(`UPDATE auction_results SET total_bids = 999 WHERE auction_id = $1`, [fx.auctionId]),
    );
    expect(onUpdate.message).toMatch(/append-only/);

    const onDelete = await expectRejected(client, () =>
      client.query(`DELETE FROM auction_results WHERE auction_id = $1`, [fx.auctionId]),
    );
    expect(onDelete.message).toMatch(/append-only/);
  });

  it('refuses a second result for the same auction', async () => {
    const failure = await expectRejected(client, () =>
      client.query(
        `INSERT INTO auction_results
           (auction_id, outcome, total_bids, total_valid_bids, unique_amount_count,
            participant_count, frozen_bid_checksum)
         VALUES ($1, 'no_unique_bid', 1, 1, 0, 1, 'sha256:second')`,
        [fx.auctionId],
      ),
    );
    expect(failure.constraint).toBe('auction_results_auction_id_key');
  });

  it('refuses a half-specified winner', async () => {
    const other = await client.query<{ id: string }>(
      `INSERT INTO auctions
         (product_id, seller_id, title, bid_fee_minor, min_bid_minor, max_bid_minor,
          max_bids_per_user, starts_at, ends_at, status, closed_at)
       VALUES ($1, $2, 'half winner', 500, 100, 50000, 10,
               now() - interval '2 hours', now() - interval '1 hour', 'calculating', now())
       RETURNING id`,
      [fx.productId, fx.sellerId],
    );

    const failure = await expectRejected(client, () =>
      client.query(
        `INSERT INTO auction_results
           (auction_id, outcome, winner_user_id, total_bids, total_valid_bids,
            unique_amount_count, participant_count, frozen_bid_checksum)
         VALUES ($1, 'winner', $2, 5, 5, 2, 2, 'sha256:partial')`,
        [other.rows[0]!.id, fx.userId],
      ),
    );
    expect(failure.constraint).toBe('auction_results_winner_complete');
  });

  /**
   * The outcome and the winner columns must agree.
   *
   * Phase 1's `winner_complete` says the three winner facts arrive together;
   * these say which outcomes may carry them. Without them a result could
   * claim `winner` while naming no winning bid, or claim `no_bids` while
   * carrying a full statistics row — and every reader downstream would have to
   * decide which half to believe.
   */
  it('refuses an outcome that contradicts the winner columns', async () => {
    const auctionFor = async (title: string): Promise<string> => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO auctions
           (product_id, seller_id, title, bid_fee_minor, min_bid_minor, max_bid_minor,
            max_bids_per_user, starts_at, ends_at, status, closed_at)
         VALUES ($1, $2, $3, 500, 100, 50000, 10,
                 now() - interval '2 hours', now() - interval '1 hour', 'calculating', now())
         RETURNING id`,
        [fx.productId, fx.sellerId, title],
      );
      return rows[0]!.id;
    };

    // `winner` with no winning bid.
    const emptyWinner = await expectRejected(client, async () =>
      client.query(
        `INSERT INTO auction_results
           (auction_id, outcome, total_bids, total_valid_bids, unique_amount_count,
            participant_count, frozen_bid_checksum)
         VALUES ($1, 'winner', 3, 3, 1, 2, 'sha256:x')`,
        [await auctionFor('winner without a winner')],
      ),
    );
    expect(emptyWinner.constraint).toBe('auction_results_winner_matches_outcome');

    // `no_bids` that counted bids.
    const busyNoBids = await expectRejected(client, async () =>
      client.query(
        `INSERT INTO auction_results
           (auction_id, outcome, total_bids, total_valid_bids, unique_amount_count,
            participant_count, frozen_bid_checksum)
         VALUES ($1, 'no_bids', 3, 3, 0, 2, 'sha256:y')`,
        [await auctionFor('no bids with bids')],
      ),
    );
    expect(busyNoBids.constraint).toBe('auction_results_no_bids_has_no_bids');

    // `no_unique_bid` that found a unique amount after all.
    const contradictory = await expectRejected(client, async () =>
      client.query(
        `INSERT INTO auction_results
           (auction_id, outcome, total_bids, total_valid_bids, unique_amount_count,
            participant_count, frozen_bid_checksum)
         VALUES ($1, 'no_unique_bid', 3, 3, 1, 2, 'sha256:z')`,
        [await auctionFor('no unique bid with one')],
      ),
    );
    expect(contradictory.constraint).toBe('auction_results_no_unique_had_bids');
  });

  /** An auction order must carry the deadline its winner was told. */
  it('refuses an auction order with no payment deadline', async () => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO auctions
         (product_id, seller_id, title, bid_fee_minor, min_bid_minor, max_bid_minor,
          max_bids_per_user, starts_at, ends_at, status, closed_at)
       VALUES ($1, $2, 'deadline-less order', 500, 100, 50000, 10,
               now() - interval '2 hours', now() - interval '1 hour', 'calculating', now())
       RETURNING id`,
      [fx.productId, fx.sellerId],
    );

    const failure = await expectRejected(client, () =>
      client.query(
        `INSERT INTO orders
           (order_number, user_id, seller_id, product_id, auction_id,
            subtotal_minor, total_minor)
         VALUES ('HL-TEST-000001', $1, $2, $3, $4, 100, 100)`,
        [fx.userId, fx.sellerId, fx.productId, rows[0]!.id],
      ),
    );
    expect(failure.constraint).toBe('orders_auction_order_has_deadline');
  });
});

describe('auctions past bidding keep their terms', () => {
  it('refuses to re-price or re-time an auction once bidding has ended', async () => {
    const closed = await client.query<{ id: string }>(
      `INSERT INTO auctions
         (product_id, seller_id, title, bid_fee_minor, min_bid_minor, max_bid_minor,
          max_bids_per_user, starts_at, ends_at, status, closed_at)
       VALUES ($1, $2, 'already decided', 500, 100, 50000, 10,
               now() - interval '2 hours', now() - interval '1 hour', 'calculating', now())
       RETURNING id`,
      [fx.productId, fx.sellerId],
    );
    const id = closed.rows[0]!.id;

    const onFee = await expectRejected(client, () =>
      client.query(`UPDATE auctions SET bid_fee_minor = 1 WHERE id = $1`, [id]),
    );
    expect(onFee.message).toMatch(/immutable/);

    const onDeadline = await expectRejected(client, () =>
      client.query(`UPDATE auctions SET ends_at = now() + interval '1 day' WHERE id = $1`, [id]),
    );
    expect(onDeadline.message).toMatch(/immutable/);

    // Completing a decided auction is a legitimate status move and must still
    // work. (Phase 4 renamed 'closed' to 'calculating' and 'settled' to
    // 'completed'; the guarantee is unchanged.)
    const settled = await client.query(`UPDATE auctions SET status = 'completed' WHERE id = $1`, [id]);
    expect(settled.rowCount).toBe(1);

    // But a completed auction cannot be reopened.
    const onReopen = await expectRejected(client, () =>
      client.query(`UPDATE auctions SET status = 'live' WHERE id = $1`, [id]),
    );
    expect(onReopen.message).toMatch(/completed and cannot change status/);
  });
});

describe('bids keep their terms', () => {
  it('refuses to change what was bid, by whom, or for how much', async () => {
    const bid = await client.query<{ id: string }>(
      `INSERT INTO bids (auction_id, user_id, amount_minor, fee_minor, channel)
       VALUES ($1, $2, 4200, 500, 'telegram') RETURNING id`,
      [fx.auctionId, fx.userId],
    );
    const id = bid.rows[0]!.id;

    const onAmount = await expectRejected(client, () =>
      client.query(`UPDATE bids SET amount_minor = 1 WHERE id = $1`, [id]),
    );
    expect(onAmount.message).toMatch(/immutable/);

    const onUser = await expectRejected(client, () =>
      client.query(`UPDATE bids SET user_id = $2 WHERE id = $1`, [id, fx.otherUserId]),
    );
    expect(onUser.message).toMatch(/immutable/);

    const onChannel = await expectRejected(client, () =>
      client.query(`UPDATE bids SET channel = 'web' WHERE id = $1`, [id]),
    );
    expect(onChannel.message).toMatch(/immutable/);

    // Voiding is a legitimate status change and must still work.
    const voided = await client.query(
      `UPDATE bids SET status = 'void', voided_at = now(), void_reason = 'test' WHERE id = $1`,
      [id],
    );
    expect(voided.rowCount).toBe(1);
  });
});

describe('payment_events is append-only', () => {
  it('records a provider callback once and refuses to alter it', async () => {
    await client.query(
      `INSERT INTO payment_events (provider, event_type, provider_event_id, payload)
       VALUES ('chapa', 'charge.success', 'evt_1', '{"ok":true}'::jsonb)`,
    );

    const duplicate = await expectRejected(client, () =>
      client.query(
        `INSERT INTO payment_events (provider, event_type, provider_event_id, payload)
         VALUES ('chapa', 'charge.success', 'evt_1', '{"ok":true}'::jsonb)`,
      ),
    );
    expect(duplicate.constraint).toBe('payment_events_provider_event_key');

    const onUpdate = await expectRejected(client, () =>
      client.query(`UPDATE payment_events SET event_type = 'tampered' WHERE provider_event_id = 'evt_1'`),
    );
    expect(onUpdate.message).toMatch(/append-only/);
  });
});
