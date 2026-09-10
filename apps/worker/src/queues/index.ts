/**
 * Queue names are declared once and shared by producers (the API) and
 * consumers (this worker), so a typo cannot silently drop jobs.
 *
 * Processors arrive with the phase that owns them; a name declared here with
 * no processor yet is a placeholder for a later phase.
 */
export const QUEUE_NAMES = {
  /** Closes auctions whose deadline has passed, then runs LUB_V1. (Phase 6) */
  auctionClose: 'auction.close',
  /** Proves every wallet's cached balance still equals its ledger. Nightly. */
  walletReconcile: 'wallet.reconcile',
  /** Outbound notifications for both channels. (Phase 11) */
  notifications: 'notifications.dispatch',
  /** Payment provider reconciliation. (Phase 9) */
  payments: 'payments.reconcile',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export { closeQueueConnection, getQueueConnection } from './connection.js';
