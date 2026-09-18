import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuctionDetailDto } from '@howlow/shared';
import * as api from '../../lib/catalog-api.js';
import { Button, Notice, Panel } from '../../components/AuthForms.js';
import { BidPanel } from '../bids/BidPanel.js';
import { ResultPanel } from './ResultPanel.js';
import { formatRemaining, money, StatusBadge } from './AuctionCard.js';

/**
 * One auction in full.
 *
 * Shows the product and every term a bidder is committing to, and deliberately
 * shows **nothing about anyone else's bids**: no count, no bidders, no hint of
 * which amounts are still unique. The API does not return those, and it must
 * not, because any of them would let a bidder work out the lowest unique bid.
 *
 * The bidding controls live in `BidPanel`, which shows the caller their own
 * position and nothing about anyone else's.
 */
type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly auction: AuctionDetailDto };

/**
 * A ticking countdown anchored to the server's figure.
 *
 * The API computes `secondsRemaining` against the database clock; this only
 * decrements it so the display moves. A viewer whose device clock is wrong
 * still sees the right remaining time.
 */
function useCountdown(initialSeconds: number | undefined): number | undefined {
  const [seconds, setSeconds] = useState(initialSeconds);
  const anchor = useRef(initialSeconds);

  useEffect(() => {
    if (initialSeconds !== anchor.current) {
      anchor.current = initialSeconds;
      setSeconds(initialSeconds);
    }
  }, [initialSeconds]);

  useEffect(() => {
    if (initialSeconds === undefined) return undefined;
    const timer = setInterval(() => {
      setSeconds((current) => (current === undefined ? undefined : Math.max(0, current - 1)));
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [initialSeconds]);

  return seconds;
}

export function AuctionDetail({
  reference,
  onBack,
  viewerId,
  sessionSettled = true,
}: {
  readonly reference: string;
  readonly onBack: () => void;
  /** The signed-in viewer, once the session has been restored. */
  readonly viewerId?: string | undefined;
  /** False while the stored session is still being rotated. */
  readonly sessionSettled?: boolean;
}): React.JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [imageIndex, setImageIndex] = useState(0);

  /**
   * Fetch the auction.
   *
   * `soft` keeps whatever is already on screen while the new copy is fetched.
   * That matters after a bid: dropping to the loading state unmounts the bid
   * panel, and the panel is what was showing the "your bids were submitted"
   * confirmation — so the bidder pressed Confirm and saw nothing at all. A
   * browser drive of the real UI is what caught it.
   */
  const load = useCallback(
    async (options: { soft?: boolean } = {}): Promise<void> => {
      if (options.soft !== true) setState({ kind: 'loading' });
      try {
        setState({ kind: 'ready', auction: await api.fetchAuction(reference) });
      } catch (cause) {
        // A failed soft refresh leaves the page as it was rather than
        // replacing a working view with an error.
        if (options.soft === true) return;
        setState({
          kind: 'error',
          message: cause instanceof Error ? cause.message : 'This auction could not be loaded.',
        });
      }
    },
    [reference],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const remaining = useCountdown(state.kind === 'ready' ? state.auction.secondsRemaining : undefined);

  if (state.kind === 'loading') {
    return (
      <Panel title="Auction">
        <p className="text-sm opacity-70">Loading this auction…</p>
      </Panel>
    );
  }

  if (state.kind === 'error') {
    return (
      <Panel title="Auction">
        <Notice kind="error">{state.message}</Notice>
        <div className="mt-3 flex gap-2">
          <Button
            onClick={() => {
              void load();
            }}
          >
            Try again
          </Button>
          <Button variant="secondary" onClick={onBack}>
            Back to auctions
          </Button>
        </div>
      </Panel>
    );
  }

  const { auction } = state;
  const currency = auction.terms.currency;
  const image = auction.images[imageIndex] ?? auction.primaryImage;
  const live = auction.status === 'live' || auction.status === 'closing';

  return (
    <div className="space-y-4">
      <Button variant="secondary" onClick={onBack}>
        ← All auctions
      </Button>

      <Panel title={auction.productTitle}>
        <div className="mb-3 flex items-center gap-2">
          <StatusBadge status={auction.status} />
          <span className="text-sm opacity-70">{auction.sellerName}</span>
        </div>

        {image == null ? (
          <div className="flex h-56 items-center justify-center rounded-md bg-black/5 text-sm opacity-60 dark:bg-white/10">
            No photograph yet
          </div>
        ) : (
          <>
            <img
              src={image.url}
              alt={image.altText ?? auction.productTitle}
              className="h-56 w-full rounded-md object-cover"
            />
            {auction.images.length > 1 && (
              <div className="mt-2 flex gap-2 overflow-x-auto">
                {auction.images.map((thumb, index) => (
                  <button
                    key={thumb.id}
                    type="button"
                    onClick={() => {
                      setImageIndex(index);
                    }}
                    className={`h-14 w-14 shrink-0 overflow-hidden rounded border ${
                      index === imageIndex
                        ? 'border-black/50 dark:border-white/60'
                        : 'border-black/10 dark:border-white/15'
                    }`}
                  >
                    <img
                      src={thumb.url}
                      alt={thumb.altText ?? `${auction.productTitle} ${index + 1}`}
                      className="h-full w-full object-cover"
                    />
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="opacity-70">Reference price</dt>
          <dd className="tabular-nums">{money(auction.retailPriceMinor, currency)}</dd>
          <dt className="opacity-70">Condition</dt>
          <dd>{auction.productCondition.replace(/_/g, ' ')}</dd>
          {auction.productBrand !== null && (
            <>
              <dt className="opacity-70">Brand</dt>
              <dd>{auction.productBrand}</dd>
            </>
          )}
          <dt className="opacity-70">Starts</dt>
          <dd>{new Date(auction.startsAt).toLocaleString()}</dd>
          <dt className="opacity-70">Ends</dt>
          <dd>{new Date(auction.endsAt).toLocaleString()}</dd>
          <dt className="opacity-70">{live ? 'Time left' : 'Countdown'}</dt>
          <dd className="tabular-nums">{formatRemaining(remaining ?? auction.secondsRemaining)}</dd>
        </dl>

        {auction.description !== null && <p className="mt-4 text-sm">{auction.description}</p>}
        {auction.shippingNote !== null && (
          <p className="mt-2 text-sm opacity-70">Shipping: {auction.shippingNote}</p>
        )}
      </Panel>

      <Panel title="Auction terms">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="opacity-70">Minimum bid</dt>
          <dd className="tabular-nums">{money(auction.terms.minBidMinor, currency)}</dd>
          <dt className="opacity-70">Maximum bid</dt>
          <dd className="tabular-nums">{money(auction.terms.maxBidMinor, currency)}</dd>
          <dt className="opacity-70">Increment</dt>
          <dd className="tabular-nums">{money(auction.terms.bidIncrementMinor, currency)}</dd>
          <dt className="opacity-70">Bids per person</dt>
          <dd className="tabular-nums">{auction.terms.maxBidsPerUser}</dd>
          <dt className="opacity-70">Participation fee</dt>
          <dd className="tabular-nums">
            {auction.terms.bidFeeMinor === '0'
              ? 'Free to enter'
              : `${money(auction.terms.bidFeeMinor, currency)} per bid`}
          </dd>
          <dt className="opacity-70">Winner pays within</dt>
          <dd>{auction.terms.winnerPaymentHours} hours</dd>
        </dl>
      </Panel>

      <Panel title="How this auction works">
        <ol className="list-inside list-decimal space-y-1 text-sm">
          <li>
            Bid any amount from {money(auction.terms.minBidMinor, currency)} to{' '}
            {money(auction.terms.maxBidMinor, currency)}, in steps of{' '}
            {money(auction.terms.bidIncrementMinor, currency)}.
          </li>
          <li>
            You may place up to {auction.terms.maxBidsPerUser} bids
            {auction.terms.bidFeeMinor === '0'
              ? '.'
              : `, each costing ${money(auction.terms.bidFeeMinor, currency)}.`}
          </li>
          <li>Nobody — including you — can see anyone else’s bids while the auction runs.</li>
          <li>
            When it closes, the winner is whoever placed the{' '}
            <strong>lowest amount that exactly one person bid</strong>. If every amount was bid by two or more
            people, there is no winner.
          </li>
          <li>The winner has {auction.terms.winnerPaymentHours} hours to pay.</li>
        </ol>
      </Panel>

      {/*
        Above the bidding controls, because on a closed auction the result is
        what the page is *for* — and `ResultPanel` renders nothing at all until
        an auction has one, so a running auction is unaffected.
      */}
      <ResultPanel
        reference={reference}
        status={auction.status}
        viewerId={viewerId}
        sessionSettled={sessionSettled}
      />

      <BidPanel
        auction={auction}
        viewerId={viewerId}
        sessionSettled={sessionSettled}
        onPlaced={() => {
          // Reload the auction so its public figures — the countdown, and the
          // aggregate counts when they are shown — come from the server rather
          // than being guessed at locally. Soft, so the panel keeps its
          // confirmation instead of being remounted out from under the bidder.
          void load({ soft: true });
        }}
      />
    </div>
  );
}
