import { useEffect, useState } from 'react';

/**
 * Minimal path routing.
 *
 * Still no router dependency: `pushState` keeps every view a real, linkable,
 * reloadable URL, which is what an auction page most needs — people share
 * them. Phase 7 builds the real website and can bring a router then, when
 * nested layouts and loaders start earning their keep.
 */
export type Route =
  | { readonly name: 'home' }
  | { readonly name: 'auctions' }
  | { readonly name: 'auction'; readonly reference: string }
  | { readonly name: 'wallet' }
  | { readonly name: 'seller' }
  | { readonly name: 'admin' };

export function parsePath(pathname: string): Route {
  const segments = pathname.replace(/^\/+|\/+$/g, '').split('/');

  if (segments[0] === 'auctions') {
    const reference = segments[1];
    return reference === undefined || reference === ''
      ? { name: 'auctions' }
      : { name: 'auction', reference: decodeURIComponent(reference) };
  }
  if (segments[0] === 'wallet') return { name: 'wallet' };
  if (segments[0] === 'seller') return { name: 'seller' };
  if (segments[0] === 'admin') return { name: 'admin' };
  return { name: 'home' };
}

export function pathOf(route: Route): string {
  switch (route.name) {
    case 'auctions':
      return '/auctions';
    case 'auction':
      return `/auctions/${encodeURIComponent(route.reference)}`;
    case 'wallet':
      return '/wallet';
    case 'seller':
      return '/seller';
    case 'admin':
      return '/admin';
    case 'home':
      return '/';
  }
}

export function useRoute(): [Route, (next: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parsePath(window.location.pathname));

  useEffect(() => {
    const onPopState = (): void => {
      setRoute(parsePath(window.location.pathname));
    };
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
    };
  }, []);

  return [
    route,
    (next: Route) => {
      window.history.pushState({}, '', pathOf(next));
      setRoute(next);
      // A new view starts at the top, as a fresh page would.
      window.scrollTo({ top: 0 });
    },
  ];
}
