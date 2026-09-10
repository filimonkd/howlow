import { useEffect, useState } from 'react';

/**
 * Minimal path routing.
 *
 * The website has two views so far, and a router dependency would be more
 * machinery than they justify; Phase 7 builds the real website and can bring
 * one then. `pushState` keeps `/wallet` a real, linkable URL rather than a tab
 * that vanishes on reload.
 */
export type Route = '/' | '/wallet';

function currentRoute(): Route {
  return window.location.pathname === '/wallet' ? '/wallet' : '/';
}

export function useRoute(): [Route, (next: Route) => void] {
  const [route, setRoute] = useState<Route>(currentRoute);

  useEffect(() => {
    const onPopState = (): void => {
      setRoute(currentRoute());
    };
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
    };
  }, []);

  return [
    route,
    (next: Route) => {
      window.history.pushState({}, '', next);
      setRoute(next);
    },
  ];
}
