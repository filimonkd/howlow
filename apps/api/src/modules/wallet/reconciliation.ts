import type { ReconciliationReport } from '@howlow/shared';
import { withTransaction } from '../../db/index.js';
import { getLogger } from '../../shared/logger.js';
import { recordWalletEvent } from './ledger.js';
import { walletNotFound } from './errors.js';
import * as repo from './walletRepository.js';

/**
 * Reconciliation: prove the cached balance still equals the ledger.
 *
 * **This detects; it never repairs.** A wallet whose cache disagrees with its
 * ledger is evidence of a bug, and silently rewriting the balance would destroy
 * that evidence and could just as easily move the wallet further from the
 * truth — the code that produced the discrepancy is, by definition, code we do
 * not currently trust. Discrepancies are reported, audited and logged so a
 * human decides what the correcting entry should be.
 *
 * Two independent checks run, because they fail in different ways:
 *
 *  - **Drift**: `SUM(amount_minor)` against `available_minor + reserved_minor`.
 *    Catches a balance update that did not match its entry.
 *  - **Running-balance breaks**: each entry's recorded `balance_after_minor`
 *    against the total replayed from the start of the ledger. Catches a ledger
 *    that happens to sum correctly but recorded the wrong balance somewhere in
 *    the middle — which is what an unserialised write produces, and the
 *    corruption most worth catching.
 */

/**
 * Check one wallet.
 *
 * Read in a single REPEATABLE READ read-only snapshot: taken separately, the
 * sum and the cached balance could straddle a committed movement and report
 * drift on a perfectly healthy wallet. A false alarm on a live wallet would
 * make the whole report worthless, and this is cheaper than locking the wallet
 * and stalling real money movements behind an audit.
 */
export async function reconcileWallet(walletId: string): Promise<ReconciliationReport> {
  const report = await withTransaction(
    async (tx) => {
      const wallet = await repo.findWalletById(walletId, tx);
      if (!wallet) throw walletNotFound(walletId);

      const { ledgerTotalMinor, entryCount } = await repo.sumLedger(walletId, tx);
      const runningBalanceBreaks = await repo.countRunningBalanceBreaks(walletId, tx);
      const drift = ledgerTotalMinor - wallet.totalMinor;

      return {
        walletId,
        consistent: drift === 0n && runningBalanceBreaks === 0,
        cachedTotalMinor: wallet.totalMinor.toString(),
        ledgerTotalMinor: ledgerTotalMinor.toString(),
        driftMinor: drift.toString(),
        entryCount,
        runningBalanceBreaks,
        checkedAt: new Date().toISOString(),
      } satisfies ReconciliationReport;
    },
    { isolationLevel: 'REPEATABLE READ', readOnly: true, maxRetries: 1 },
  );

  if (!report.consistent) {
    // Audited outside the read-only snapshot, which cannot write. The audit row
    // is the durable record; the log line is what wakes someone up.
    await recordWalletEvent('wallet.reconciliation_failed', walletId, {
      cachedTotalMinor: report.cachedTotalMinor,
      ledgerTotalMinor: report.ledgerTotalMinor,
      driftMinor: report.driftMinor,
      entryCount: report.entryCount,
      runningBalanceBreaks: report.runningBalanceBreaks,
    });
  }

  return report;
}

export interface SweepResult {
  readonly walletsChecked: number;
  readonly inconsistent: readonly ReconciliationReport[];
  readonly startedAt: string;
  readonly finishedAt: string;
}

/**
 * Check every wallet, in id-ordered batches.
 *
 * Keyset paging over wallet ids rather than one enormous query: the sweep runs
 * nightly against a table that keeps growing, and each wallet is checked in its
 * own short snapshot so the job never holds a long-lived transaction open
 * against the live database.
 *
 * Only inconsistent wallets are returned. A sweep that reported every healthy
 * wallet would bury the one that matters.
 */
export async function reconcileAllWallets(
  options: { readonly batchSize?: number } = {},
): Promise<SweepResult> {
  const batchSize = options.batchSize ?? 200;
  const startedAt = new Date().toISOString();
  const inconsistent: ReconciliationReport[] = [];
  let walletsChecked = 0;
  let afterId: string | undefined;

  for (;;) {
    const ids = await repo.listWalletIds(batchSize, afterId);
    if (ids.length === 0) break;

    for (const id of ids) {
      const report = await reconcileWallet(id);
      walletsChecked += 1;
      if (!report.consistent) inconsistent.push(report);
    }

    afterId = ids[ids.length - 1];
    if (ids.length < batchSize) break;
  }

  const result: SweepResult = {
    walletsChecked,
    inconsistent,
    startedAt,
    finishedAt: new Date().toISOString(),
  };

  const logger = getLogger();
  if (inconsistent.length > 0) {
    logger.error(
      { walletsChecked, inconsistentCount: inconsistent.length, walletIds: inconsistent.map((r) => r.walletId) },
      'wallet.reconcile: ledger discrepancies found',
    );
  } else {
    logger.info({ walletsChecked }, 'wallet.reconcile: all wallets consistent');
  }

  return result;
}
