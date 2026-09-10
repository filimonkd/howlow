import { useCallback, useEffect, useState } from 'react';
import {
  formatMoney,
  moneyFromMinorString,
  type WalletDto,
  type WalletEntryDto,
  type WalletEntryType,
} from '@howlow/shared';
import * as walletApi from '../lib/wallet-api.js';
import { Button, Notice, Panel } from '../components/AuthForms.js';

/**
 * The wallet page.
 *
 * Everything here comes from the API. No balance is computed in the browser and
 * no placeholder figure is ever shown: a balance that is not yet loaded renders
 * as "loading", and one that failed to load renders as an error — never as a
 * zero, which a person would read as "my money is gone".
 */
type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly kind: 'ready';
      readonly wallet: WalletDto;
      readonly entries: readonly WalletEntryDto[];
      readonly nextCursor: string | null;
    };

const ENTRY_LABELS: Record<WalletEntryType, string> = {
  deposit: 'Deposit',
  bid_fee_refund: 'Bid fee refunded',
  payment_refund: 'Payment refunded',
  admin_credit: 'Adjustment by HOWLOW',
  prize_payout: 'Prize',
  withdrawal: 'Withdrawal',
  bid_fee: 'Bid fee',
  auction_payment: 'Auction payment',
  admin_debit: 'Adjustment by HOWLOW',
  seller_payout: 'Seller payout',
  hold: 'Held for a bid',
  hold_release: 'Hold released',
};

/** Format a wire amount for display. Parsed as an exact integer, never a float. */
function amount(minor: string, currency: WalletDto['currency']): string {
  const value = formatMoney(moneyFromMinorString(minor, currency));
  return minor.startsWith('-') ? value : `+${value}`;
}

export function Wallet({ onBack }: { readonly onBack: () => void }): React.JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      // Both requests together: the page is not useful with only one of them.
      const [wallet, page] = await Promise.all([
        walletApi.fetchWallet(),
        walletApi.fetchTransactions({ limit: 20 }),
      ]);
      setState({ kind: 'ready', wallet, entries: page.entries, nextCursor: page.nextCursor });
    } catch (cause) {
      setState({
        kind: 'error',
        message: cause instanceof Error ? cause.message : 'Your wallet could not be loaded.',
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = (cursor: string): void => {
    setLoadingMore(true);
    void walletApi
      .fetchTransactions({ limit: 20, cursor })
      .then((page) => {
        setState((current) =>
          current.kind === 'ready'
            ? { ...current, entries: [...current.entries, ...page.entries], nextCursor: page.nextCursor }
            : current,
        );
      })
      .catch(() => {
        // The page already shows what loaded; a failed extra page must not
        // discard it.
        setState((current) => current);
      })
      .finally(() => {
        setLoadingMore(false);
      });
  };

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <Button variant="secondary" onClick={onBack}>
        ← Account
      </Button>

      {state.kind === 'loading' && (
        <Panel title="Wallet">
          <p className="text-sm opacity-70">Loading your wallet…</p>
        </Panel>
      )}

      {state.kind === 'error' && (
        <Panel title="Wallet">
          <Notice kind="error">{state.message}</Notice>
          <div className="mt-3">
            <Button
              onClick={() => {
                void load();
              }}
            >
              Try again
            </Button>
          </div>
        </Panel>
      )}

      {state.kind === 'ready' && (
        <>
          <Panel title="Wallet">
            <p className="text-3xl font-semibold tabular-nums">
              {formatMoney(moneyFromMinorString(state.wallet.availableMinor, state.wallet.currency))}
            </p>
            <p className="mt-1 text-sm opacity-70">Available balance · {state.wallet.currency}</p>
            {state.wallet.reservedMinor !== '0' && (
              <p className="mt-2 text-sm opacity-70">
                Held: {formatMoney(moneyFromMinorString(state.wallet.reservedMinor, state.wallet.currency))}
              </p>
            )}
            {state.wallet.frozen && (
              <div className="mt-3">
                <Notice kind="error">
                  This wallet is frozen, so money cannot leave it right now. You can still receive money and
                  read your history.
                  {state.wallet.frozenReason === null ? '' : ` Reason: ${state.wallet.frozenReason}`}
                </Notice>
              </div>
            )}
          </Panel>

          <Panel title="Transactions">
            {state.entries.length === 0 ? (
              <p className="text-sm opacity-70">
                No transactions yet. Money you add, spend or receive will appear here.
              </p>
            ) : (
              <>
                <ul className="divide-y divide-black/10 text-sm dark:divide-white/15">
                  {state.entries.map((entry) => (
                    <li key={entry.id} className="flex items-baseline justify-between gap-4 py-2">
                      <span>
                        <span className="block">{ENTRY_LABELS[entry.type]}</span>
                        <span className="block text-xs opacity-60">
                          {new Date(entry.createdAt).toLocaleString()}
                          {entry.memo === null ? '' : ` · ${entry.memo}`}
                        </span>
                      </span>
                      <span
                        className={`shrink-0 tabular-nums ${
                          entry.amountMinor.startsWith('-') ? '' : 'text-green-700 dark:text-green-400'
                        }`}
                      >
                        {amount(entry.amountMinor, entry.currency)}
                      </span>
                    </li>
                  ))}
                </ul>
                {state.nextCursor !== null && (
                  <div className="mt-3">
                    <Button
                      variant="secondary"
                      disabled={loadingMore}
                      onClick={() => {
                        if (state.nextCursor !== null) loadMore(state.nextCursor);
                      }}
                    >
                      {loadingMore ? 'Loading…' : 'Show older'}
                    </Button>
                  </div>
                )}
              </>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
