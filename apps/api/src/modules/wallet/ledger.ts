import type { Channel, Currency } from '@howlow/shared';
import { money, walletEntryDirection } from '@howlow/shared';
import type { Tx } from '../../db/index.js';
import { getPool, withTransaction } from '../../db/index.js';
import { getLogger } from '../../shared/logger.js';
import {
  currencyMismatch,
  idempotencyConflict,
  insufficientFunds,
  invalidAmount,
  walletFrozen,
  walletNotFound,
} from './errors.js';
import type { MovementInput, MovementResult, WalletRecord } from './types.js';
import {
  findEntryByIdempotencyKey,
  insertEntry,
  lockWalletById,
  updateWalletBalance,
} from './walletRepository.js';

/**
 * The ledger core: the single code path through which money moves.
 *
 * ## Locking strategy
 *
 * Every movement takes exactly one lock — `SELECT ... FOR UPDATE` on the
 * wallet row, by primary key — and holds it for the rest of the transaction.
 * That single lock is what makes the arithmetic safe: the balance read under it
 * already reflects every movement that committed earlier, so two concurrent
 * debits cannot both read the same balance, both pass their own sufficiency
 * check, and together overdraw the wallet. The second one queues on the lock
 * and reads the balance the first one left behind.
 *
 * An advisory lock (`withAdvisoryLock`) is deliberately *not* used here. The
 * wallet row is the subject being serialised, so locking the row itself cannot
 * be forgotten or misnamed, and holding both kinds of lock for one subject
 * would give the same wallet two lock namespaces that no reviewer could keep
 * straight.
 *
 * ### Why this cannot deadlock against Phase 5
 *
 * No wallet operation acquires any further lock while holding a wallet row
 * lock: the wallet lock is always the *last* lock a transaction takes. A
 * bidding transaction that locks the auction and then the bidder's wallet
 * therefore has a strictly ordered pair, and no path exists that could take
 * them the other way round. Callers that must move money for two wallets in
 * one transaction have to lock them in ascending wallet-id order; that is the
 * one rule this module asks of its callers.
 *
 * ## Why the ledger is the truth
 *
 * `wallet_entries` is append-only and each row records the balance it produced.
 * `wallets.available_minor` is a cache maintained in the same transaction as
 * the entry that changed it — never in a separate one — so the two cannot
 * diverge without a bug, which is exactly what reconciliation looks for.
 */

/** Wallet events, for audit rows and structured logs alike. */
export const WALLET_EVENTS = [
  'wallet.created',
  'wallet.credited',
  'wallet.debited',
  'wallet.refunded',
  'wallet.admin_credited',
  'wallet.admin_debited',
  'wallet.frozen',
  'wallet.unfrozen',
  'wallet.reconciliation_failed',
] as const;

export type WalletEvent = (typeof WALLET_EVENTS)[number];

export interface RequestContext {
  readonly ipAddress?: string | undefined;
  readonly userAgent?: string | undefined;
  readonly requestId?: string | undefined;
}

/**
 * Record a wallet event in `audit_logs` and the structured log.
 *
 * `details` is always assembled by this module from wallet facts — ids,
 * amounts, entry types — and never forwarded from a caller's request body, so
 * no secret can reach an audit row by being passed in under an unexpected key.
 */
export async function recordWalletEvent(
  event: WalletEvent,
  walletId: string,
  details: Record<string, unknown>,
  options: {
    readonly actorUserId?: string | undefined;
    readonly channel?: Channel | undefined;
    readonly context?: RequestContext | undefined;
    readonly tx?: Tx | undefined;
  } = {},
): Promise<void> {
  const runner = options.tx ?? getPool();
  await runner.query(
    `INSERT INTO audit_logs
       (actor_user_id, actor_channel, action, entity_type, entity_id,
        after_data, ip_address, user_agent, request_id)
     VALUES ($1, $2, $3, 'wallet', $4, $5::jsonb, $6, $7, $8)`,
    [
      options.actorUserId ?? null,
      options.channel ?? 'system',
      event,
      walletId,
      JSON.stringify(details),
      options.context?.ipAddress ?? null,
      options.context?.userAgent ?? null,
      options.context?.requestId ?? null,
    ],
  );
  getLogger().info({ event, walletId, ...details }, event);
}

/**
 * Reject amounts that must never reach the ledger.
 *
 * Callers pass a positive magnitude and the entry type decides the direction,
 * so a negative amount here means the caller is trying to flip a credit into a
 * debit (or vice versa) by sign — which is a bug, not an input to honour.
 */
function assertPositiveMagnitude(amountMinor: bigint): void {
  if (amountMinor <= 0n) {
    throw invalidAmount(
      amountMinor === 0n
        ? 'amount must be greater than zero'
        : 'amount must be a positive magnitude; the direction comes from the entry type',
    );
  }
}

function assertMovableType(input: MovementInput): void {
  if (input.type === 'hold' || input.type === 'hold_release') {
    throw invalidAmount(
      `entry type ${input.type} moves money between available and reserved and is not implemented until Phase 5`,
    );
  }
}

/**
 * A stored entry found by idempotency key must describe the *same* movement the
 * caller is now asking for. If it does not, the caller has reused a key for a
 * different operation: replaying the stored result would report the earlier
 * movement's outcome for this one, so the only safe answer is to refuse.
 */
function assertSameMovement(
  stored: { type: string; currency: Currency; amountMinor: bigint },
  requested: { type: string; currency: Currency; signedMinor: bigint },
  idempotencyKey: string,
): void {
  if (
    stored.type !== requested.type ||
    stored.currency !== requested.currency ||
    stored.amountMinor !== requested.signedMinor
  ) {
    throw idempotencyConflict(idempotencyKey);
  }
}

/**
 * Apply one movement to an already-resolved wallet, inside the caller's
 * transaction.
 *
 * The wallet must already exist: creation is a separate, idempotent step so
 * that this function takes exactly one lock and takes it by primary key. The
 * balance update and the ledger entry are written here, together, or not at
 * all — there is no ordering of the two in which a crash leaves one without
 * the other, because both live in the caller's transaction.
 */
export async function applyMovement(
  input: MovementInput,
  tx: Tx,
  options: { readonly context?: RequestContext | undefined } = {},
): Promise<MovementResult> {
  assertMovableType(input);
  assertPositiveMagnitude(input.amountMinor);

  // 1. Lock. Everything after this point sees a balance nobody else can move.
  const wallet = await lockWalletById(input.walletId, tx);
  if (!wallet) throw walletNotFound(input.walletId);

  if (input.currency !== undefined && input.currency !== wallet.currency) {
    throw currencyMismatch(wallet.currency, input.currency);
  }

  const direction = walletEntryDirection(input.type);
  const signedMinor = BigInt(direction) * input.amountMinor;

  // 2. Replay, before any state changes. Under the lock a concurrent duplicate
  //    cannot get past this check: it waits, then finds the committed entry.
  if (input.idempotencyKey !== undefined) {
    const existing = await findEntryByIdempotencyKey(input.walletId, input.idempotencyKey, tx);
    if (existing) {
      assertSameMovement(
        existing,
        { type: input.type, currency: wallet.currency, signedMinor },
        input.idempotencyKey,
      );
      return {
        walletId: wallet.id,
        entryId: existing.id,
        amountMinor: existing.amountMinor,
        balanceAfterMinor: existing.balanceAfterMinor,
        currency: existing.currency,
        replayed: true,
      };
    }
  }

  // 3. A frozen wallet still accepts money and can still be read; what a
  //    freeze stops is money leaving.
  if (direction === -1 && wallet.frozenAt !== null) {
    throw walletFrozen(wallet.id, wallet.frozenReason);
  }

  // 4. Compute. Integer arithmetic on bigint only: no float ever touches this.
  const balanceAfterMinor = wallet.availableMinor + signedMinor;
  if (balanceAfterMinor < 0n) {
    throw insufficientFunds(
      money(input.amountMinor, wallet.currency),
      money(wallet.availableMinor, wallet.currency),
    );
  }

  // 5. Write the cache and the truth together. The non-negative CHECK on both
  //    tables is the database's own last word behind this check.
  await updateWalletBalance(wallet.id, balanceAfterMinor, tx);
  const entry = await insertEntry(
    {
      walletId: wallet.id,
      userId: wallet.userId,
      type: input.type,
      currency: wallet.currency,
      amountMinor: signedMinor,
      balanceAfterMinor,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      memo: input.memo,
      idempotencyKey: input.idempotencyKey,
      createdBy: input.actorUserId,
      channel: input.channel,
    },
    tx,
  );

  // 6. Audit, in the same transaction: an audit row for a movement that rolled
  //    back would be a record of something that never happened.
  await recordWalletEvent(
    walletEventFor(input.type, direction),
    wallet.id,
    {
      entryId: entry.id,
      entryType: input.type,
      currency: wallet.currency,
      amountMinor: signedMinor.toString(),
      balanceBeforeMinor: wallet.availableMinor.toString(),
      balanceAfterMinor: balanceAfterMinor.toString(),
      ...(input.referenceType !== undefined ? { referenceType: input.referenceType } : {}),
      ...(input.referenceId !== undefined ? { referenceId: input.referenceId } : {}),
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
    },
    {
      actorUserId: input.actorUserId,
      channel: input.channel,
      context: options.context,
      tx,
    },
  );

  return {
    walletId: wallet.id,
    entryId: entry.id,
    amountMinor: signedMinor,
    balanceAfterMinor,
    currency: wallet.currency,
    replayed: false,
  };
}

/** The event a movement should be audited under. */
function walletEventFor(type: MovementInput['type'], direction: -1 | 1): WalletEvent {
  if (type === 'admin_credit') return 'wallet.admin_credited';
  if (type === 'admin_debit') return 'wallet.admin_debited';
  if (type === 'bid_fee_refund' || type === 'payment_refund') return 'wallet.refunded';
  return direction === 1 ? 'wallet.credited' : 'wallet.debited';
}

/**
 * Apply one movement in a transaction of its own.
 *
 * `maxRetries` is 1 because the only failure this retries is PostgreSQL
 * reporting that nothing was committed (40001 / 40P01) — never a failure that
 * might have applied the movement — so a retry cannot double-book. With row
 * locking rather than optimistic retry these are rare; the retry exists for
 * deadlocks against transactions outside this module.
 */
export async function postMovement(
  input: MovementInput,
  options: { readonly context?: RequestContext | undefined } = {},
): Promise<MovementResult> {
  return withTransaction((tx) => applyMovement(input, tx, options), { maxRetries: 1 });
}

/** Read a wallet under lock, for callers composing several movements. */
export async function lockWallet(walletId: string, tx: Tx): Promise<WalletRecord> {
  const wallet = await lockWalletById(walletId, tx);
  if (!wallet) throw walletNotFound(walletId);
  return wallet;
}
