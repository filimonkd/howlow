/**
 * Queue names are declared once and shared by producers (the API) and
 * consumers (this worker), so a typo cannot silently drop jobs.
 *
 * Processors arrive with the phase that owns them; a name declared here with
 * no processor yet is a placeholder for a later phase.
 */
export const QUEUE_NAMES = {
  /** Opens auctions at their start time and closes them at their deadline. */
  auctionLifecycle: 'auction.lifecycle',
  /** Repairs lifecycle transitions the scheduled jobs missed. Every 30s. */
  auctionSweeper: 'auction.sweeper',
  /** Runs LUB_V1 on a closed auction and writes its result. (Phase 6) */
  auctionResults: 'auction.results',
  /** Proves every wallet's cached balance still equals its ledger. Nightly. */
  walletReconcile: 'wallet.reconcile',
  /** Outbound notifications for both channels. (Phase 11) */
  notifications: 'notifications.dispatch',
  /** Payment provider reconciliation. (Phase 9) */
  payments: 'payments.reconcile',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export { closeQueueConnection, getQueueConnection } from './connection.js';
