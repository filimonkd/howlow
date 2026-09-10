/**
 * The wallet module's public surface.
 *
 * Every wallet mutation in HOWLOW goes through these functions. Nothing outside
 * this directory writes to `wallets` or `wallet_entries` — not a controller,
 * not a Telegram handler, not a payment adapter, not an admin tool — so the
 * rule "no balance changes without a ledger entry in the same transaction" is
 * enforced by there being exactly one place it could happen.
 */
export {
  adminCredit,
  adminDebit,
  assertMayAudit,
  credit,
  debit,
  decodeCursor,
  DEFAULT_CURRENCY,
  encodeCursor,
  freezeWallet,
  getBalance,
  getTransactions,
  getWallet,
  refund,
  resolveWalletForAdmin,
  toWalletDto,
  toWalletEntryDto,
  unfreezeWallet,
} from './walletService.js';
export type { AdminAdjustment, MovementRequest } from './walletService.js';

export { reconcileAllWallets, reconcileWallet } from './reconciliation.js';
export type { SweepResult } from './reconciliation.js';

export { applyMovement, lockWallet, postMovement, recordWalletEvent, WALLET_EVENTS } from './ledger.js';
export type { RequestContext, WalletEvent } from './ledger.js';

export { WALLET_ERRORS } from './errors.js';
export type { WalletErrorCode } from './errors.js';

export type { MovementInput, MovementResult, WalletEntryRecord, WalletRecord } from './types.js';
