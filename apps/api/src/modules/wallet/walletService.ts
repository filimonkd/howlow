import type {
  Channel,
  Currency,
  Money,
  Role,
  WalletDto,
  WalletEntryDto,
} from '@howlow/shared';
import { AppError, money } from '@howlow/shared';
import type { Tx } from '../../db/index.js';
import { withTransaction } from '../../db/index.js';
import { hasAnyRole, loadRoles } from '../auth/rbac.js';
import {
  applyMovement,
  postMovement,
  recordWalletEvent,
  type RequestContext,
} from './ledger.js';
import { invalidAmount, unauthorizedWalletOperation, walletNotFound } from './errors.js';
import type { MovementResult, WalletEntryRecord, WalletRecord } from './types.js';
import * as repo from './walletRepository.js';

/**
 * The wallet module's operations.
 *
 * **Only this module mutates wallets.** No controller, Telegram handler,
 * payment adapter or admin tool writes to `wallets` or `wallet_entries`; they
 * call the functions here. That is what makes "every balance change has a
 * ledger entry" a property of the system rather than a habit — there is exactly
 * one place where a balance can change, and it always writes the entry in the
 * same transaction.
 */

/** Ethiopia-first: one wallet currency for the MVP. */
export const DEFAULT_CURRENCY: Currency = 'ETB';

/** Roles that may adjust or freeze someone else's wallet. */
const FINANCE_ROLES: readonly Role[] = ['finance', 'admin'];
/** Roles that may read a reconciliation report. */
const AUDIT_ROLES: readonly Role[] = ['finance', 'support_agent', 'admin'];

/**
 * Authorization is asserted here, in the module, and not only by the HTTP
 * middleware in front of it. The middleware protects one route; this protects
 * the operation, whichever channel or worker reaches it.
 */
async function assertActorRole(
  actorUserId: string,
  allowed: readonly Role[],
  operation: string,
): Promise<void> {
  const roles = await loadRoles(actorUserId);
  if (!hasAnyRole(roles, allowed)) {
    throw unauthorizedWalletOperation(`${actorUserId} may not ${operation}`);
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The user's wallet, created on first read if they have none.
 *
 * Creation is idempotent and settled by the database's unique
 * `(user_id, currency)` index, so concurrent first reads cannot produce two
 * wallets and this is safe to call from any channel at any time.
 */
export async function getWallet(
  userId: string,
  currency: Currency = DEFAULT_CURRENCY,
  tx?: Tx,
): Promise<WalletRecord> {
  const { wallet, created } = await repo.ensureWallet(userId, currency, tx);
  if (created) {
    await recordWalletEvent(
      'wallet.created',
      wallet.id,
      { userId, currency },
      { actorUserId: userId, ...(tx ? { tx } : {}) },
    );
  }
  return wallet;
}

export async function getBalance(
  userId: string,
  currency: Currency = DEFAULT_CURRENCY,
): Promise<Money> {
  const wallet = await getWallet(userId, currency);
  return money(wallet.availableMinor, wallet.currency);
}

/** Ledger history, newest first, one page at a time. */
export async function getTransactions(
  userId: string,
  input: { limit: number; beforeSeq?: bigint | undefined },
  currency: Currency = DEFAULT_CURRENCY,
): Promise<{ entries: WalletEntryRecord[]; nextSeq: bigint | null }> {
  const wallet = await getWallet(userId, currency);
  // One extra row tells us whether another page exists without a second query.
  const rows = await repo.listEntries(wallet.id, input.limit + 1, input.beforeSeq);
  const entries = rows.slice(0, input.limit);
  const last = entries[entries.length - 1];
  return { entries, nextSeq: rows.length > input.limit && last ? last.seq : null };
}

// ---------------------------------------------------------------------------
// Movements
// ---------------------------------------------------------------------------

/** What a caller outside the module supplies to move money. */
export interface MovementRequest {
  readonly userId: string;
  /** Positive magnitude in minor units. The type decides the direction. */
  readonly amountMinor: bigint;
  readonly currency?: Currency | undefined;
  readonly referenceType?: string | undefined;
  readonly referenceId?: string | undefined;
  readonly memo?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly actorUserId?: string | undefined;
  readonly channel: Channel;
  readonly context?: RequestContext | undefined;
}

type CreditType = 'deposit' | 'bid_fee_refund' | 'payment_refund' | 'prize_payout';
type DebitType = 'withdrawal' | 'bid_fee' | 'auction_payment' | 'seller_payout';
type RefundType = 'bid_fee_refund' | 'payment_refund';

/**
 * Add money to a wallet.
 *
 * `tx` is accepted so that a caller who is already in a transaction — a payment
 * confirmation writing its own rows, say — books the credit in that same
 * transaction. Money must not be moved in a transaction that can commit while
 * the operation that caused it rolls back.
 */
export async function credit(
  type: CreditType,
  request: MovementRequest,
  tx?: Tx,
): Promise<MovementResult> {
  return move(type, request, tx);
}

export async function debit(
  type: DebitType,
  request: MovementRequest,
  tx?: Tx,
): Promise<MovementResult> {
  return move(type, request, tx);
}

/**
 * Return money that was taken.
 *
 * A refund is a credit with its own entry type and a mandatory reference to
 * what is being refunded, so the ledger shows the pair. The original debit is
 * never edited: the ledger is append-only and a correction is a new entry.
 */
export async function refund(
  type: RefundType,
  request: MovementRequest & { referenceType: string; referenceId: string },
  tx?: Tx,
): Promise<MovementResult> {
  return move(type, request, tx);
}

async function move(
  type: CreditType | DebitType | 'admin_credit' | 'admin_debit',
  request: MovementRequest,
  tx?: Tx,
): Promise<MovementResult> {
  // Resolving (and if needed creating) the wallet happens before the movement
  // so the movement itself takes exactly one lock, by primary key. See the
  // locking strategy in ledger.ts.
  const wallet = await getWallet(request.userId, request.currency ?? DEFAULT_CURRENCY, tx);
  const input = {
    walletId: wallet.id,
    amountMinor: request.amountMinor,
    currency: request.currency,
    type,
    referenceType: request.referenceType,
    referenceId: request.referenceId,
    memo: request.memo,
    idempotencyKey: request.idempotencyKey,
    actorUserId: request.actorUserId,
    channel: request.channel,
  };
  const options = { context: request.context };
  return tx ? applyMovement(input, tx, options) : postMovement(input, options);
}

// ---------------------------------------------------------------------------
// Finance operations
// ---------------------------------------------------------------------------

export interface AdminAdjustment {
  readonly walletId: string;
  readonly amountMinor: bigint;
  readonly currency?: Currency | undefined;
  /** Mandatory. An unexplained adjustment to someone's money is not acceptable. */
  readonly reason: string;
  readonly referenceType?: string | undefined;
  readonly referenceId?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly actorUserId: string;
  readonly channel: Channel;
  readonly context?: RequestContext | undefined;
}

/**
 * A finance operator adds money to a wallet.
 *
 * The reason becomes the entry's memo, and the operator becomes its
 * `created_by`, so the ledger answers "who did this and why" without a join to
 * the audit log — and the audit log records it too.
 */
export async function adminCredit(input: AdminAdjustment): Promise<MovementResult> {
  return adminAdjust('admin_credit', input);
}

export async function adminDebit(input: AdminAdjustment): Promise<MovementResult> {
  return adminAdjust('admin_debit', input);
}

async function adminAdjust(
  type: 'admin_credit' | 'admin_debit',
  input: AdminAdjustment,
): Promise<MovementResult> {
  await assertActorRole(input.actorUserId, FINANCE_ROLES, `perform an ${type}`);
  if (input.reason.trim().length === 0) {
    throw invalidAmount('an adjustment requires a reason');
  }

  const wallet = await repo.findWalletById(input.walletId);
  if (!wallet) throw walletNotFound(input.walletId);

  return postMovement(
    {
      walletId: wallet.id,
      amountMinor: input.amountMinor,
      currency: input.currency,
      type,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      memo: input.reason,
      idempotencyKey: input.idempotencyKey,
      actorUserId: input.actorUserId,
      channel: input.channel,
    },
    { context: input.context },
  );
}

/**
 * Stop money leaving this wallet.
 *
 * A freeze is a **financial control**, not an account suspension. The owner
 * keeps their sign-in, their history and their ability to receive money;
 * what stops is debits. Suspending the account (`users.status`) is an
 * authentication decision and belongs to the auth module — conflating the two
 * would mean fraud review had to lock people out of reading their own ledger.
 */
export async function freezeWallet(input: {
  walletId: string;
  reason: string;
  actorUserId: string;
  channel: Channel;
  context?: RequestContext | undefined;
}): Promise<WalletRecord> {
  await assertActorRole(input.actorUserId, FINANCE_ROLES, 'freeze a wallet');

  return withTransaction(async (tx) => {
    // Under the same lock every movement takes, so a freeze cannot land
    // half-way through a debit that already passed its frozen check.
    const wallet = await repo.lockWalletById(input.walletId, tx);
    if (!wallet) throw walletNotFound(input.walletId);
    if (wallet.frozenAt !== null) return wallet;

    await repo.setFrozen(
      { walletId: wallet.id, reason: input.reason, actorUserId: input.actorUserId },
      tx,
    );
    await recordWalletEvent(
      'wallet.frozen',
      wallet.id,
      { reason: input.reason, availableMinor: wallet.availableMinor.toString() },
      { actorUserId: input.actorUserId, channel: input.channel, context: input.context, tx },
    );
    const frozen = await repo.findWalletById(wallet.id, tx);
    return frozen ?? wallet;
  });
}

export async function unfreezeWallet(input: {
  walletId: string;
  reason: string;
  actorUserId: string;
  channel: Channel;
  context?: RequestContext | undefined;
}): Promise<WalletRecord> {
  await assertActorRole(input.actorUserId, FINANCE_ROLES, 'unfreeze a wallet');

  return withTransaction(async (tx) => {
    const wallet = await repo.lockWalletById(input.walletId, tx);
    if (!wallet) throw walletNotFound(input.walletId);
    if (wallet.frozenAt === null) return wallet;

    await repo.clearFrozen(wallet.id, tx);
    await recordWalletEvent(
      'wallet.unfrozen',
      wallet.id,
      { reason: input.reason, previousReason: wallet.frozenReason },
      { actorUserId: input.actorUserId, channel: input.channel, context: input.context, tx },
    );
    const thawed = await repo.findWalletById(wallet.id, tx);
    return thawed ?? wallet;
  });
}

/**
 * Resolve the `:publicId` a finance route was given.
 *
 * A wallet id is tried first, then a user id. Both are `gen_random_uuid()`
 * values from disjoint tables, so one identifier cannot mean two wallets, and
 * accepting either spares an operator who has looked someone up by phone from
 * having to find the wallet's own id first.
 */
export async function resolveWalletForAdmin(
  publicId: string,
  actorUserId: string,
  currency: Currency = DEFAULT_CURRENCY,
): Promise<WalletRecord> {
  await assertActorRole(actorUserId, AUDIT_ROLES, 'read another wallet');
  const byWalletId = await repo.findWalletById(publicId);
  if (byWalletId) return byWalletId;
  const byUserId = await repo.findWalletByUserId(publicId, currency);
  if (byUserId) return byUserId;
  throw walletNotFound(publicId);
}

/** Assert the reader may see a reconciliation report for someone else's wallet. */
export async function assertMayAudit(actorUserId: string): Promise<void> {
  await assertActorRole(actorUserId, AUDIT_ROLES, 'read a reconciliation report');
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/**
 * Map a wallet to its DTO. Lives in the module, not in a channel, so the
 * website and the Telegram bot are formatting the same numbers from the same
 * source rather than each doing their own arithmetic.
 *
 * Every amount becomes a decimal string here. That is the last point at which
 * a `bigint` could be turned into a lossy `number`, and it is not.
 */
export function toWalletDto(wallet: WalletRecord): WalletDto {
  return {
    id: wallet.id,
    currency: wallet.currency,
    availableMinor: wallet.availableMinor.toString(),
    reservedMinor: wallet.reservedMinor.toString(),
    totalMinor: wallet.totalMinor.toString(),
    frozen: wallet.frozenAt !== null,
    frozenReason: wallet.frozenReason,
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

export function toWalletEntryDto(entry: WalletEntryRecord): WalletEntryDto {
  return {
    id: entry.id,
    seq: entry.seq.toString(),
    type: entry.type,
    currency: entry.currency,
    amountMinor: entry.amountMinor.toString(),
    balanceAfterMinor: entry.balanceAfterMinor.toString(),
    referenceType: entry.referenceType,
    referenceId: entry.referenceId,
    memo: entry.memo,
    createdAt: entry.createdAt.toISOString(),
  };
}

/**
 * Pagination cursors are opaque to clients: an encoded ledger position, not an
 * offset. The ledger only grows at the head, so an offset would shift under a
 * reader between pages and show one entry twice or skip another.
 *
 * Encoded rather than the bare number so a client cannot come to depend on its
 * meaning — the position is the ledger's business, and the next page is
 * whatever the server says it is.
 */
export function encodeCursor(seq: bigint): string {
  return Buffer.from(`seq:${seq.toString()}`, 'utf8').toString('base64url');
}

export function decodeCursor(value: string): bigint {
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  const match = /^seq:(\d{1,19})$/.exec(decoded);
  if (!match?.[1]) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'Malformed wallet pagination cursor',
      publicMessage: 'That page cursor is not valid.',
    });
  }
  return BigInt(match[1]);
}
