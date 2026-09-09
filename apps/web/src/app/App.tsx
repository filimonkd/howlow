import { useEffect, useState } from 'react';
import { AUCTION_ALGORITHM_VERSION, type PublicUser } from '@howlow/shared';
import * as api from '../lib/auth-api.js';
import { Auth } from './Auth.js';
import { Dashboard } from './Dashboard.js';

type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'authenticated'; readonly user: PublicUser };

export function App(): React.JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });

  // A stored refresh token means the session may still be good: rotate it once
  // on load rather than making the user sign in again after every reload.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const restored = await api.refresh();
      if (cancelled) return;
      if (!restored) {
        setState({ kind: 'anonymous' });
        return;
      }
      try {
        const user = await api.getMe();
        if (!cancelled) setState({ kind: 'authenticated', user });
      } catch {
        if (!cancelled) setState({ kind: 'anonymous' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-6 py-12">
      <header className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">HOWLOW</h1>
        <p className="text-sm opacity-70">One account for the website and the Telegram bot.</p>
      </header>

      {state.kind === 'loading' && <p className="text-sm opacity-70">Loading…</p>}

      {state.kind === 'anonymous' && (
        <Auth
          onAuthenticated={(user) => {
            setState({ kind: 'authenticated', user });
          }}
        />
      )}

      {state.kind === 'authenticated' && (
        <Dashboard
          user={state.user}
          onSignOut={() => {
            setState({ kind: 'anonymous' });
          }}
          onUserChanged={(user) => {
            setState({ kind: 'authenticated', user });
          }}
        />
      )}

      <footer className="mt-auto text-xs opacity-60">Auction algorithm: {AUCTION_ALGORITHM_VERSION}</footer>
    </main>
  );
}
