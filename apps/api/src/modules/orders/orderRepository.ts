import type { Currency } from '@howlow/shared';
import { getPool, type Tx } from '../../db/index.js';
import type { OrderRecord, OrderStatus } from './types.js';

/**
 * Every statement that touches `orders`.
 *
 * Nothing outside `modules/orders` reaches the table, for the reason every
 * other boundary in HOWLOW exists: an order is a claim on a product unit and a
 * demand for money, and two code paths that could create one would eventually
 * create two for the same auction.
 *
 * What is here is deliberately small. Phase 6 needs to create the winner's
 * order and read it back; payment, cancellation on a missed deadline,
 * fulfilment and refunds are later phases and have no statements here yet.
 */

const runner = (tx?: Tx) => tx ?? getPool();

interface OrderRow {
  id: string;
  order_number: string;
  user_id: string;
  seller_id: string;
  product_id: string;
  auction_id: string | null;
  status: OrderStatus;
  currency: Currency;
  subtotal_minor: string;
  shipping_minor: string;
  tax_minor: string;
  discount_minor: string;
  total_minor: string;
  placed_at: Date;
  payment_due_at: Date | null;
  paid_at: Date | null;
  cancelled_at: Date | null;
}

const ORDER_COLUMNS = `id, order_number, user_id, seller_id, product_id, auction_id,
  status, currency, subtotal_minor, shipping_minor, tax_minor, discount_minor,
  total_minor, placed_at, payment_due_at, paid_at, cancelled_at`;

const toOrder = (row: OrderRow): OrderRecord => ({
  id: row.id,
  orderNumber: row.order_number,
  userId: row.user_id,
  sellerId: row.seller_id,
  productId: row.product_id,
  auctionId: row.auction_id,
  status: row.status,
  currency: row.currency,
  subtotalMinor: BigInt(row.subtotal_minor),
  shippingMinor: BigInt(row.shipping_minor),
  taxMinor: BigInt(row.tax_minor),
  discountMinor: BigInt(row.discount_minor),
  totalMinor: BigInt(row.total_minor),
  placedAt: row.placed_at,
  paymentDueAt: row.payment_due_at,
  paidAt: row.paid_at,
  cancelledAt: row.cancelled_at,
});

export interface InsertAuctionOrderInput {
  readonly auctionId: string;
  readonly userId: string;
  readonly sellerId: string;
  readonly productId: string;
  readonly currency: Currency;
  /** The winning bid amount. The winner owes what they bid, and nothing else. */
  readonly amountMinor: bigint;
  /** Hours from now, from the auction's own `winner_payment_hours`. */
  readonly paymentWindowHours: number;
}

/**
 * Create the winner's order, or return the one that already exists.
 *
 * **This is where "a won auction creates exactly one order" is decided** —
 * `orders_auction_id_key`, a partial unique index on `auction_id`. Not an
 * application check, not the worker's job uniqueness: a second closing attempt
 * that reached this statement still cannot insert a second order, and the
 * first order is returned so the caller reports the one that exists.
 *
 * `payment_due_at` is computed here, from the database clock, as
 * `clock_timestamp() + winner_payment_hours`. `clock_timestamp()` rather than
 * `now()` because `now()` is the *transaction's* start time, and a closing
 * transaction that spent thirty seconds counting a large auction would
 * otherwise quietly shorten the winner's window by thirty seconds. Stored
 * rather than derived on read, because the deadline the winner was told is the
 * deadline that binds.
 *
 * The amounts: `subtotal = total = the winning bid`, with shipping, tax and
 * discount at zero. `orders_total_is_sum_of_parts` checks the arithmetic, so
 * the row cannot drift. The winner's wallet is **not** charged here and no
 * payment is initiated — the order is a demand for payment, and collecting it
 * is Phase 7.
 */
export async function insertAuctionOrder(
  input: InsertAuctionOrderInput,
  tx: Tx,
): Promise<{ order: OrderRecord; inserted: boolean }> {
  const { rows } = await tx.query<OrderRow>(
    `INSERT INTO orders (
       order_number, user_id, seller_id, product_id, auction_id, status, currency,
       subtotal_minor, shipping_minor, tax_minor, discount_minor, total_minor,
       placed_at, payment_due_at
     )
     VALUES (
       next_order_number(), $1, $2, $3, $4, 'pending_payment', $5,
       $6, 0, 0, 0, $6,
       clock_timestamp(), clock_timestamp() + make_interval(hours => $7::int)
     )
     ON CONFLICT (auction_id) WHERE auction_id IS NOT NULL DO NOTHING
     RETURNING ${ORDER_COLUMNS}`,
    [
      input.userId,
      input.sellerId,
      input.productId,
      input.auctionId,
      input.currency,
      input.amountMinor,
      input.paymentWindowHours,
    ],
  );

  const inserted = rows[0];
  if (inserted) return { order: toOrder(inserted), inserted: true };

  const existing = await findByAuction(input.auctionId, tx);
  if (!existing) {
    throw new Error(`orders conflict on auction ${input.auctionId} but no row could be read back`);
  }
  return { order: existing, inserted: false };
}

export async function findByAuction(auctionId: string, tx?: Tx): Promise<OrderRecord | undefined> {
  const { rows } = await runner(tx).query<OrderRow>(
    `SELECT ${ORDER_COLUMNS} FROM orders WHERE auction_id = $1`,
    [auctionId],
  );
  return rows[0] ? toOrder(rows[0]) : undefined;
}

export async function findById(orderId: string, tx?: Tx): Promise<OrderRecord | undefined> {
  const { rows } = await runner(tx).query<OrderRow>(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1`, [
    orderId,
  ]);
  return rows[0] ? toOrder(rows[0]) : undefined;
}

/** A user's own order for one auction, for their result view. */
export async function findForUserAndAuction(
  input: { userId: string; auctionId: string },
  tx?: Tx,
): Promise<OrderRecord | undefined> {
  const { rows } = await runner(tx).query<OrderRow>(
    `SELECT ${ORDER_COLUMNS} FROM orders WHERE auction_id = $1 AND user_id = $2`,
    [input.auctionId, input.userId],
  );
  return rows[0] ? toOrder(rows[0]) : undefined;
}
