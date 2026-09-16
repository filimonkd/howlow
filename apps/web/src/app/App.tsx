import { useEffect, useState } from 'react';
import { AUCTION_ALGORITHM_VERSION, type PublicUser } from '@howlow/shared';
import * as api from '../lib/auth-api.js';
import { useRoute, type Route } from '../lib/route.js';
import { AdminConsole } from '../features/catalog/AdminConsole.js';
import { AuctionDetail } from '../features/auctions/AuctionDetail.js';
import { AuctionList } from '../features/auctions/AuctionList.js';
import { SellerConsole } from '../features/catalog/SellerConsole.js';
import { Auth } from './Auth.js';
import { Dashboard } from './Dashboard.js';
import { Wallet } from './Wallet.js';

type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'authenticated'; readonly user: PublicUser };

/**
 * Auction discovery is public: a visitor browses before signing in, which is
 * how anyone arriving from a shared link first sees HOWLOW. Only the seller
 * console, the admin console and the wallet need an account.
 */
export function App(): React.JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [route, navigate] = useRoute();

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

  const user = state.kind === 'authenticated' ? state.user : undefined;
  const has = (role: string): boolean => user?.roles.includes(role as never) ?? false;

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-6 py-12">
      <header className="space-y-2">
        <button
          type="button"
          className="text-left text-3xl font-semibold tracking-tight"
          onClick={() => {
            navigate({ name: 'home' });
          }}
        >
          HOWLOW
        </button>
        <p className="text-sm opacity-70">
          Lowest unique bid auctions. One account for the website and the Telegram bot.
        </p>
        <nav className="flex flex-wrap gap-3 text-sm">
          <NavLink label="Auctions" to={{ name: 'auctions' }} route={route} navigate={navigate} />
          {user !== undefined && (
            <NavLink label="Account" to={{ name: 'home' }} route={route} navigate={navigate} />
          )}
          {user !== undefined && (
            <NavLink label="Wallet" to={{ name: 'wallet' }} route={route} navigate={navigate} />
          )}
          {has('seller') && (
            <NavLink label="Selling" to={{ name: 'seller' }} route={route} navigate={navigate} />
          )}
          {(has('auction_manager') || has('admin') || has('super_admin')) && (
            <NavLink label="Review" to={{ name: 'admin' }} route={route} navigate={navigate} />
          )}
        </nav>
      </header>

      {/* Public views render whether or not anyone is signed in. */}
      {route.name === 'auctions' && (
        <AuctionList
          onOpenAuction={(reference) => {
            navigate({ name: 'auction', reference });
          }}
        />
      )}

      {route.name === 'auction' && (
        <AuctionDetail
          reference={route.reference}
          onBack={() => {
            navigate({ name: 'auctions' });
          }}
        />
      )}

      {state.kind === 'loading' && route.name === 'home' && (
        <p className="text-sm opacity-70">Loading…</p>
      )}

      {state.kind === 'anonymous' && route.name === 'home' && (
        <Auth
          onAuthenticated={(authenticated) => {
            setState({ kind: 'authenticated', user: authenticated });
          }}
        />
      )}

      {/* Signing in is what the home view offers when nobody is. */}
      {state.kind === 'anonymous' &&
        (route.name === 'wallet' || route.name === 'seller' || route.name === 'admin') && (
          <Auth
            onAuthenticated={(authenticated) => {
              setState({ kind: 'authenticated', user: authenticated });
            }}
          />
        )}

      {state.kind === 'authenticated' && route.name === 'home' && (
        <Dashboard
          user={state.user}
          onOpenWallet={() => {
            navigate({ name: 'wallet' });
          }}
          onSignOut={() => {
            navigate({ name: 'home' });
            setState({ kind: 'anonymous' });
          }}
          onUserChanged={(changed) => {
            setState({ kind: 'authenticated', user: changed });
          }}
        />
      )}

      {state.kind === 'authenticated' && route.name === 'wallet' && (
        <Wallet
          onBack={() => {
            navigate({ name: 'home' });
          }}
        />
      )}

      {state.kind === 'authenticated' && route.name === 'seller' && <SellerConsole />}
      {state.kind === 'authenticated' && route.name === 'admin' && <AdminConsole />}

      <footer className="mt-auto text-xs opacity-60">
        Auction algorithm: {AUCTION_ALGORITHM_VERSION}
      </footer>
    </main>
  );
}

function NavLink({
  label,
  to,
  route,
  navigate,
}: {
  readonly label: string;
  readonly to: Route;
  readonly route: Route;
  readonly navigate: (next: Route) => void;
}): React.JSX.Element {
  const active = route.name === to.name;
  return (
    <button
      type="button"
      className={active ? 'font-medium underline' : 'opacity-70 hover:opacity-100'}
      onClick={() => {
        navigate(to);
      }}
    >
      {label}
    </button>
  );
}
