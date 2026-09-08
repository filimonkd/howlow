import { useEffect, useState } from 'react';
import { AUCTION_ALGORITHM_VERSION, type HealthResponse } from '@howlow/shared';
import { fetchHealth } from '../lib/api.js';
import { StatusPanel } from '../components/StatusPanel.js';

type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly health: HealthResponse }
  | { readonly kind: 'error'; readonly message: string };

export function App(): React.JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetchHealth()
      .then((health) => {
        if (!cancelled) setState({ kind: 'ready', health });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ kind: 'error', message: error instanceof Error ? error.message : 'Unknown error' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-6 py-12">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">HOWLOW</h1>
        <p className="text-sm opacity-70">
          One backend, one wallet, one auction engine — reachable from the website and from Telegram.
        </p>
      </header>

      <StatusPanel state={state} />

      <footer className="text-xs opacity-60">Auction algorithm: {AUCTION_ALGORITHM_VERSION}</footer>
    </main>
  );
}
