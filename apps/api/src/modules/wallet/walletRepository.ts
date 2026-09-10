import type { Channel, Currency, WalletEntryType } from '@howlow/shared';
import { moneyFromMinorString } from '@howlow/shared';
import { getPool, type Tx } from '../../db/index.js';
import type { WalletEntryRecord, WalletRecord } from './types.js';

/**
 * Every wallet SQL statement. Nothing outside this file writes wallet SQL, so
 * the queries that move money can be reviewed in one place.
 *
 * BIGINT columns arrive as strings (the driver's parsers were replaced in
 * Phase 0 precisely so they cannot silently become lossy numbers), and are
 * widened to `bigint` here.
 */
type Runner = Pick<Tx, 'query'>;
const runner = (tx?: Tx): Runner => tx ?? getPool();

interface WalletRow {
  id: string;
  user_id: string;
  currency: Currency;
  available_minor: string;
  reserved_minor: string;
  version: string;
  frozen_at: Date | null;
  frozen_reason: string | null;
  updated_at: Date;
}

function toWallet(row: WalletRow): WalletRecord {
  const available = BigInt(row.available_minor);
  const reserved = BigInt(row.reserved_minor);
  return {
    id: row.id,
    userId: row.user_id,
    currency: row.currency,
    availableMinor: available,
    reservedMinor: reserved,
    totalMinor: available + reserved,
    version: BigInt(row.version),
    frozenAt: row.frozen_at,
    frozenReason: row.frozen_reason,
    updatedAt: row.updated_at,
  };
}

const WALLET_COLUMNS = `id, user_id, currency, available_minor, reserved_minor,
  version, frozen_at, frozen_reason, updated_at`;

/**
 * Create the wallet if the user has none.
 *
 * `ON CONFLICT DO NOTHING` against the unique (user_id, currency) index makes
 * this safe to call from anywhere and as often as anyone likes: two concurrent
 * callers cannot produce two wallets, because the database decides.
 */
export async function ensureWallet(
  userId: string,
  currency: Currency,
  tx?: Tx,
): Promise<{ wallet: WalletRecord; created: boolean }> {
  const inserted = await runner(tx).query<WalletRow>(
    `INSERT INTO wallets (user_id, currency) VALUES ($1, $2)
     ON CONFLICT (user_id, currency) DO NOTHING
     RETURNING ${WALLET_COLUMNS}`,
    [userId, currency],
  );
  if (inserted.rows[0]) return { wallet: toWallet(inserted.rows[0]), created: true };

  const existing = await runner(tx).query<WalletRow>(
    `SELECT ${WALLET_COLUMNS} FROM wallets WHERE user_id = $1 AND currency = $2`,
    [userId, currency],
  );
  return { wallet: toWallet(existing.rows[0]!), created: false };
}

export async function findWalletByUserId(
  userId: string,
  currency: Currency,
  tx?: Tx,
): Promise<WalletRecord | undefined> {
  const { rows } = await runner(tx).query<WalletRow>(
    `SELECT ${WALLET_COLUMNS} FROM wallets WHERE user_id = $1 AND currency = $2`,
    [userId, currency],
  );
  return rows[0] ? toWallet(rows[0]) : undefined;
}

export async function findWalletById(id: string, tx?: Tx): Promise<WalletRecord | undefined> {
  const { rows } = await runner(tx).query<WalletRow>(`SELECT ${WALLET_COLUMNS} FROM wallets WHERE id = $1`, [
    id,
  ]);
  return rows[0] ? toWallet(rows[0]) : undefined;
}

/**
 * Read the wallet under a row lock. **This is the serialisation point for every
 * money movement.**
 *
 * `FOR UPDATE` makes concurrent movements against one wallet queue here rather
 * than racing: the balance each of them then reads is the balance after every
 * earlier movement committed. Without it, two debits could both read the same
 * balance, both pass their own sufficiency check, and together overdraw the
 * wallet — the non-negative constraint would catch the overdraw, but as a
 * database error rather than a clean INSUFFICIENT_FUNDS.
 *
 * Only ever called inside a transaction, because a lock outside one is
 * released immediately and protects nothing.
 */
export async function lockWalletById(id: string, tx: Tx): Promise<WalletRecord | undefined> {
  const { rows } = await tx.query<WalletRow>(
    `SELECT ${WALLET_COLUMNS} FROM wallets WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return rows[0] ? toWallet(rows[0]) : undefined;
}

export async function lockWalletByUserId(
  userId: string,
  currency: Currency,
  tx: Tx,
): Promise<WalletRecord | undefined> {
  const { rows } = await tx.query<WalletRow>(
    `SELECT ${WALLET_COLUMNS} FROM wallets WHERE user_id = $1 AND currency = $2 FOR UPDATE`,
    [userId, currency],
  );
  return rows[0] ? toWallet(rows[0]) : undefined;
}

/**
 * Apply the new balance. The `version` bump lets a reader detect that the
 * wallet moved; the non-negative CHECK is the database's own last word on
 * overdrafts, behind the lock and the service's check.
 */
export async function updateWalletBalance(walletId: string, availableMinor: bigint, tx: Tx): Promise<void> {
  await tx.query(`UPDATE wallets SET available_minor = $2, version = version + 1 WHERE id = $1`, [
    walletId,
    availableMinor.toString(),
  ]);
}

interface EntryRow {
  id: string;
  wallet_id: string;
  seq: string;
  entry_type: WalletEntryType;
  currency: Currency;
  amount_minor: string;
  balance_after_minor: string;
  reference_type: string | null;
  reference_id: string | null;
  memo: string | null;
  created_at: Date;
}

function toEntry(row: EntryRow): WalletEntryRecord {
  return {
    id: row.id,
    walletId: row.wallet_id,
    seq: BigInt(row.seq),
    type: row.entry_type,
    currency: row.currency,
    amountMinor: BigInt(row.amount_minor),
    balanceAfterMinor: BigInt(row.balance_after_minor),
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    memo: row.memo,
    createdAt: row.created_at,
  };
}

const ENTRY_COLUMNS = `id, wallet_id, seq, entry_type, currency, amount_minor,
  balance_after_minor, reference_type, reference_id, memo, created_at`;

/** Append one ledger entry. Only ever called with the wallet already locked. */
export async function insertEntry(
  input: {
    walletId: string;
    userId: string;
    /** The wallet's movement number, assigned under the lock. */
    seq: bigint;
    type: WalletEntryType;
    currency: Currency;
    /** Already signed by the service, derived from the entry type. */
    amountMinor: bigint;
    balanceAfterMinor: bigint;
    referenceType?: string | undefined;
    referenceId?: string | undefined;
    memo?: string | undefined;
    idempotencyKey?: string | undefined;
    createdBy?: string | undefined;
    channel: Channel;
  },
  tx: Tx,
): Promise<WalletEntryRecord> {
  const { rows } = await tx.query<EntryRow>(
    `INSERT INTO wallet_entries
       (wallet_id, user_id, seq, entry_type, currency, amount_minor, balance_after_minor,
        reference_type, reference_id, memo, idempotency_key, created_by, created_channel)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING ${ENTRY_COLUMNS}`,
    [
      input.walletId,
      input.userId,
      input.seq.toString(),
      input.type,
      input.currency,
      input.amountMinor.toString(),
      input.balanceAfterMinor.toString(),
      input.referenceType ?? null,
      input.referenceId ?? null,
      input.memo ?? null,
      input.idempotencyKey ?? null,
      input.createdBy ?? null,
      input.channel,
    ],
  );
  return toEntry(rows[0]!);
}

export async function findEntryByIdempotencyKey(
  walletId: string,
  idempotencyKey: string,
  tx?: Tx,
): Promise<WalletEntryRecord | undefined> {
  const { rows } = await runner(tx).query<EntryRow>(
    `SELECT ${ENTRY_COLUMNS} FROM wallet_entries
     WHERE wallet_id = $1 AND idempotency_key = $2`,
    [walletId, idempotencyKey],
  );
  return rows[0] ? toEntry(rows[0]) : undefined;
}

/**
 * A page of ledger history, newest first.
 *
 * Keyset pagination on `seq` rather than OFFSET: the ledger only grows at the
 * head, so an offset would shift under a reader and show the same entry twice
 * or skip one. `seq` rather than a timestamp because it is the ledger's
 * authoritative order — see the note on the column in migration 0011.
 */
export async function listEntries(
  walletId: string,
  limit: number,
  beforeSeq?: bigint,
  tx?: Tx,
): Promise<WalletEntryRecord[]> {
  const { rows } = await runner(tx).query<EntryRow>(
    `SELECT ${ENTRY_COLUMNS} FROM wallet_entries
     WHERE wallet_id = $1 AND ($2::bigint IS NULL OR seq < $2::bigint)
     ORDER BY seq DESC
     LIMIT $3`,
    [walletId, beforeSeq?.toString() ?? null, limit],
  );
  return rows.map(toEntry);
}

// ---------------------------------------------------------------------------
// Freeze
// ---------------------------------------------------------------------------

export async function setFrozen(
  input: { walletId: string; reason: string; actorUserId: string },
  tx: Tx,
): Promise<void> {
  await tx.query(
    `UPDATE wallets SET frozen_at = now(), frozen_reason = $2, frozen_by = $3
     WHERE id = $1 AND frozen_at IS NULL`,
    [input.walletId, input.reason, input.actorUserId],
  );
}

export async function clearFrozen(walletId: string, tx: Tx): Promise<void> {
  await tx.query(
    `UPDATE wallets SET frozen_at = NULL, frozen_reason = NULL, frozen_by = NULL
     WHERE id = $1`,
    [walletId],
  );
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export interface LedgerTotals {
  readonly ledgerTotalMinor: bigint;
  readonly entryCount: number;
}

/** Sum the ledger. This is the authoritative balance; wallets holds a cache. */
export async function sumLedger(walletId: string, tx?: Tx): Promise<LedgerTotals> {
  const { rows } = await runner(tx).query<{ total: string; count: string }>(
    `SELECT COALESCE(SUM(amount_minor), 0)::text AS total, COUNT(*)::text AS count
     FROM wallet_entries WHERE wallet_id = $1`,
    [walletId],
  );
  return {
    ledgerTotalMinor: BigInt(rows[0]?.total ?? '0'),
    entryCount: Number(rows[0]?.count ?? '0'),
  };
}

/**
 * Count entries whose recorded `balance_after_minor` disagrees with the running
 * total replayed from the start of the ledger.
 *
 * A drift check alone would miss a ledger that sums correctly but records the
 * wrong balance at some point in the middle — which is exactly what a
 * non-serialised write would produce, and exactly the corruption worth
 * catching.
 *
 * Ordered by `seq`, the order the balances were computed in. Ordering by
 * `created_at` would report healthy wallets as broken, because now() is the
 * transaction's start time and concurrent movements can start out of order.
 */
export async function countRunningBalanceBreaks(walletId: string, tx?: Tx): Promise<number> {
  const { rows } = await runner(tx).query<{ breaks: string }>(
    `WITH replayed AS (
       SELECT id,
              balance_after_minor,
              SUM(amount_minor) OVER (ORDER BY seq
                                      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running
       FROM wallet_entries
       WHERE wallet_id = $1
     )
     SELECT COUNT(*)::text AS breaks FROM replayed WHERE balance_after_minor <> running`,
    [walletId],
  );
  return Number(rows[0]?.breaks ?? '0');
}

/**
 * Count missing positions in the wallet's movement sequence.
 *
 * `seq` is gap-free by construction — it is `version + 1` assigned under the
 * wallet lock — so a gap means a movement was recorded and then removed, or
 * a balance was changed without one. Neither is supposed to be possible, which
 * is why it is worth checking.
 */
export async function countSequenceGaps(walletId: string, tx?: Tx): Promise<number> {
  const { rows } = await runner(tx).query<{ gaps: string }>(
    `SELECT COALESCE(MAX(seq) - COUNT(*), 0)::text AS gaps
     FROM wallet_entries WHERE wallet_id = $1`,
    [walletId],
  );
  return Number(rows[0]?.gaps ?? '0');
}

/** Every wallet id, oldest first, for the nightly sweep. */
export async function listWalletIds(limit: number, afterId?: string, tx?: Tx): Promise<string[]> {
  const { rows } = await runner(tx).query<{ id: string }>(
    `SELECT id FROM wallets
     WHERE ($2::uuid IS NULL OR id > $2::uuid)
     ORDER BY id LIMIT $1`,
    [limit, afterId ?? null],
  );
  return rows.map((row) => row.id);
}

/** Used only by tests, to prove the money helpers round-trip through SQL. */
export const parseMinor = moneyFromMinorString;
