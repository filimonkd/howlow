import { useCallback, useEffect, useState } from 'react';
import type { AuctionSort, AuctionSummaryDto, CategoryTreeDto } from '@howlow/shared';
import * as api from '../../lib/catalog-api.js';
import { Button, Notice, Panel } from '../../components/AuthForms.js';
import { AuctionCard } from './AuctionCard.js';

/**
 * Public auction discovery.
 *
 * The three states are distinct on purpose: loading says so, a failure shows
 * the error with a retry, and an empty result says there are no auctions —
 * none of them renders as an empty grid a visitor would read as a broken page.
 */
type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly kind: 'ready';
      readonly auctions: readonly AuctionSummaryDto[];
      readonly nextCursor: string | null;
    };

const SORTS: readonly { value: AuctionSort; label: string }[] = [
  { value: 'ending_soon', label: 'Ending soon' },
  { value: 'starting_soon', label: 'Starting soon' },
  { value: 'newest', label: 'Newest' },
];

export function AuctionList({
  onOpenAuction,
}: {
  readonly onOpenAuction: (reference: string) => void;
}): React.JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [categories, setCategories] = useState<readonly CategoryTreeDto[]>([]);
  const [sort, setSort] = useState<AuctionSort>('ending_soon');
  const [categorySlug, setCategorySlug] = useState<string>('');
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const page = await api.fetchAuctions({
        sort,
        ...(categorySlug === '' ? {} : { categorySlug }),
      });
      setState({ kind: 'ready', auctions: page.auctions, nextCursor: page.nextCursor });
    } catch (cause) {
      setState({
        kind: 'error',
        message: cause instanceof Error ? cause.message : 'Auctions could not be loaded.',
      });
    }
  }, [sort, categorySlug]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    // A failed category load is not worth blocking discovery over: the filter
    // simply offers fewer options.
    void api
      .fetchCategories()
      .then(setCategories)
      .catch(() => setCategories([]));
  }, []);

  const loadMore = (cursor: string): void => {
    setLoadingMore(true);
    void api
      .fetchAuctions({ sort, cursor, ...(categorySlug === '' ? {} : { categorySlug }) })
      .then((page) => {
        setState((current) =>
          current.kind === 'ready'
            ? {
                ...current,
                auctions: [...current.auctions, ...page.auctions],
                nextCursor: page.nextCursor,
              }
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
    <div className="space-y-4">
      <Panel title="Auctions">
        <p className="mb-3 text-sm opacity-70">
          HOWLOW auctions are decided by the <strong>lowest unique bid</strong>: the smallest amount that
          exactly one person bid. Nobody can see anyone else’s bids while an auction is running.
        </p>

        <div className="flex flex-wrap gap-2">
          <label className="text-sm">
            <span className="mr-2 opacity-70">Sort</span>
            <select
              className="rounded-md border border-black/15 bg-transparent px-2 py-1 dark:border-white/20"
              value={sort}
              onChange={(event) => {
                setSort(event.target.value as AuctionSort);
              }}
            >
              {SORTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          {categories.length > 0 && (
            <label className="text-sm">
              <span className="mr-2 opacity-70">Category</span>
              <select
                className="rounded-md border border-black/15 bg-transparent px-2 py-1 dark:border-white/20"
                value={categorySlug}
                onChange={(event) => {
                  setCategorySlug(event.target.value);
                }}
              >
                <option value="">All</option>
                {categories.flatMap((category) => [
                  <option key={category.id} value={category.slug}>
                    {category.name}
                  </option>,
                  ...category.children.map((child) => (
                    <option key={child.id} value={child.slug}>
                      {`— ${child.name}`}
                    </option>
                  )),
                ])}
              </select>
            </label>
          )}
        </div>
      </Panel>

      {state.kind === 'loading' && (
        <Panel title="Loading">
          <p className="text-sm opacity-70">Loading auctions…</p>
        </Panel>
      )}

      {state.kind === 'error' && (
        <Panel title="Auctions">
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

      {state.kind === 'ready' && state.auctions.length === 0 && (
        <Panel title="Nothing open right now">
          <p className="text-sm opacity-70">
            There are no auctions open at the moment. New ones appear here as soon as they are scheduled.
          </p>
        </Panel>
      )}

      {state.kind === 'ready' && state.auctions.length > 0 && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            {state.auctions.map((auction) => (
              <AuctionCard
                key={auction.id}
                auction={auction}
                onOpen={() => {
                  onOpenAuction(auction.slug ?? auction.id);
                }}
              />
            ))}
          </div>
          {state.nextCursor !== null && (
            <Button
              variant="secondary"
              disabled={loadingMore}
              onClick={() => {
                if (state.nextCursor !== null) loadMore(state.nextCursor);
              }}
            >
              {loadingMore ? 'Loading…' : 'Show more'}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
