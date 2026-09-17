/**
 * The orders module's public surface.
 *
 * `orders` is written from here and nowhere else, so "a won auction produces
 * exactly one order" has exactly one code path that could break it — and that
 * path leans on a unique index rather than on a check it could forget.
 *
 * Phase 6 uses only `createWinnerOrder`. Payment, fulfilment and the
 * consequences of a missed deadline belong to later phases and have no
 * functions here yet; when they arrive they join this module rather than
 * reaching for the table.
 */
export { createWinnerOrder, getMyOrderForAuction, getOrderForAuction, toOrderDto } from './orderService.js';

export type { OrderRecord, OrderStatus } from './types.js';
