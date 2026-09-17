import type { Currency, OrderStatusValue } from '@howlow/shared';

/** An order as it was written. */
export interface OrderRecord {
  readonly id: string;
  readonly orderNumber: string;
  readonly userId: string;
  readonly sellerId: string;
  readonly productId: string;
  readonly auctionId: string | null;
  readonly status: OrderStatus;
  readonly currency: Currency;
  readonly subtotalMinor: bigint;
  readonly shippingMinor: bigint;
  readonly taxMinor: bigint;
  readonly discountMinor: bigint;
  readonly totalMinor: bigint;
  readonly placedAt: Date;
  readonly paymentDueAt: Date | null;
  readonly paidAt: Date | null;
  readonly cancelledAt: Date | null;
}

/**
 * The `order_status` enum as Phase 1 declared it.
 *
 * Aliased from the shared contract rather than restated, so the database
 * enum, the wire schema and this record cannot drift into three slightly
 * different lists. Phase 6 only ever writes `pending_payment`; the rest are
 * the fulfilment lifecycle later phases own.
 */
export type OrderStatus = OrderStatusValue;
