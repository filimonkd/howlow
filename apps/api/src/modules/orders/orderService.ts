import type { Currency, OrderDto } from '@howlow/shared';
import { type Tx } from '../../db/index.js';
import { writeAuditLog, type OperationContext } from '../../shared/index.js';
import * as repo from './orderRepository.js';
import type { OrderRecord } from './types.js';

/**
 * The orders service.
 *
 * Phase 6's share of orders is one operation: when an auction produces a
 * winner, the winner owes the amount they bid, and that obligation is an
 * order. Creating it is all this does.
 *
 * **What it deliberately does not do.** It does not charge the winner's
 * wallet, does not talk to a payment provider, does not cancel an order whose
 * deadline passed, does not reassign the item if the winner never pays and
 * does not touch shipping. Those are later phases. In particular, a winner who
 * fails to pay must never cause the winner to be recalculated: the order is
 * the consequence of the result, and the result is final.
 */

/**
 * Create the order a winning auction owes its winner.
 *
 * Runs in the closing transaction, which already holds the auction row lock,
 * so the order and the result commit together: there is no window in which an
 * auction has a winner and no order, or an order and no winner.
 *
 * Idempotent by the database, not by a check here — see `insertAuctionOrder`.
 * `created` tells the caller which of the two happened, which is what the
 * audit trail and the "exactly one order" test need to distinguish.
 */
export async function createWinnerOrder(
  input: {
    auctionId: string;
    winnerUserId: string;
    sellerId: string;
    productId: string;
    currency: Currency;
    winningAmountMinor: bigint;
    paymentWindowHours: number;
    context?: OperationContext | undefined;
  },
  tx: Tx,
): Promise<{ order: OrderRecord; created: boolean }> {
  const { order, inserted } = await repo.insertAuctionOrder(
    {
      auctionId: input.auctionId,
      userId: input.winnerUserId,
      sellerId: input.sellerId,
      productId: input.productId,
      currency: input.currency,
      amountMinor: input.winningAmountMinor,
      paymentWindowHours: input.paymentWindowHours,
    },
    tx,
  );

  // Only the call that created the order writes the audit row. A replay that
  // found one already there did not create anything, and an audit trail that
  // recorded it twice would make one order look like two.
  if (inserted) {
    await writeAuditLog(
      {
        action: 'order.created',
        entityType: 'order',
        entityId: order.id,
        actorUserId: input.context?.actorUserId,
        channel: input.context?.channel ?? 'system',
        requestId: input.context?.requestId,
        details: {
          orderNumber: order.orderNumber,
          auctionId: input.auctionId,
          winnerUserId: input.winnerUserId,
          totalMinor: order.totalMinor.toString(),
          currency: order.currency,
          paymentDueAt: order.paymentDueAt?.toISOString() ?? null,
          cause: 'auction_won',
        },
      },
      tx,
    );
  }

  return { order, created: inserted };
}

export async function getOrderForAuction(auctionId: string, tx?: Tx): Promise<OrderRecord | undefined> {
  return repo.findByAuction(auctionId, tx);
}

export async function getMyOrderForAuction(
  input: { userId: string; auctionId: string },
  tx?: Tx,
): Promise<OrderRecord | undefined> {
  return repo.findForUserAndAuction(input, tx);
}

/** The order as a client sees it. Amounts are decimal strings on the wire. */
export function toOrderDto(order: OrderRecord): OrderDto {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    auctionId: order.auctionId,
    status: order.status,
    currency: order.currency,
    totalMinor: order.totalMinor.toString(),
    placedAt: order.placedAt.toISOString(),
    paymentDueAt: order.paymentDueAt?.toISOString() ?? null,
    paidAt: order.paidAt?.toISOString() ?? null,
  };
}
