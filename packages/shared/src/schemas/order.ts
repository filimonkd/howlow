import { z } from 'zod';
import { currencySchema, minorAmountSchema } from './common.js';

/**
 * Orders, over the wire.
 *
 * Phase 6 creates exactly one kind of order — the obligation a winner takes on
 * when their bid wins — and this is the shape a client reads it back in. The
 * fulfilment lifecycle is a later phase, so the statuses beyond
 * `pending_payment` are declared (the column can hold them) but nothing in
 * this phase writes one.
 */

export const ORDER_STATUSES = [
  'pending_payment',
  'paid',
  'preparing',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
] as const;

export const orderStatusSchema = z.enum(ORDER_STATUSES);
export type OrderStatusValue = (typeof ORDER_STATUSES)[number];

export const orderDtoSchema = z.object({
  id: z.uuid(),
  /** Human-quotable, e.g. `HL-2026-000123`. What support asks for. */
  orderNumber: z.string(),
  /** Null for a direct sale; set when the order came from winning an auction. */
  auctionId: z.uuid().nullable(),
  status: orderStatusSchema,
  currency: currencySchema,
  totalMinor: minorAmountSchema,
  placedAt: z.iso.datetime(),
  /**
   * When the winner must have paid by.
   *
   * Fixed when the order was created, from the auction's own
   * `winner_payment_hours`. Never re-derived on read: the deadline a winner
   * was told is the deadline that binds.
   */
  paymentDueAt: z.iso.datetime().nullable(),
  paidAt: z.iso.datetime().nullable(),
});

export type OrderDto = z.infer<typeof orderDtoSchema>;
