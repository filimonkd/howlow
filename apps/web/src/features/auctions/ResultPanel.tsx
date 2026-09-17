import { useEffect, useState } from 'react';
import type { AuctionResultDto, AuctionStatus, Currency, MyAuctionOutcomeDto } from '@howlow/shared';
import * as api from '../../lib/result-api.js';
import { Notice, Panel } from '../../components/AuthForms.js';
import { money } from './AuctionCard.js';

/**
 * What happened to a closed auction.
 *
 * ## It computes nothing
 *
 * Every figure on this panel was decided by the backend and is read back from
 * it — the outcome, the winning amount, whether the viewer won, what came
 * back. There is no arithmetic here that could reach a different answer from
 * the one the auction published.
 *
 * ## What it shows, and to whom
 *
 * The winning amount and the statistics are public: they are the answer the
 * auction was asking, and every bidder needs them to make sense of their own
 * outcome. Whether *you* won, what you paid and what was returned are yours,
 * and come from an authenticated endpoint.
 *
 * **Nothing here names another bidder or describes their bids.** A loser sees
 * that they lost and what the winning amount was — not who beat them, not by
 * how much, and not what anybody else tried. That is not politeness: a
 * frequency table of amounts, published after the close, is still advice about
 * what to avoid in the next auction.
 *
 * Before the close the panel renders nothing at all, because there is no
 * result to render.
 */
type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'ready'; readonly result: AuctionResultDto; readonly mine?: MyAuctionOutcomeDto }
  | { readonly kind: 'error'; readonly message: string };

/** Statuses at which a result may exist. Anything earlier has none to fetch. */
function mayHaveResult(status: AuctionStatus): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'calculating';
}

export function ResultPanel({
  reference,
  status,
  viewerId,
  sessionSettled = true,
}: {
  readonly reference: string;
  readonly status: AuctionStatus;
  /** The signed-in viewer, once the session has been restored. */
  readonly viewerId?: string | undefined;
  /**
   * False while the stored session is still being rotated.
   *
   * The caller's own outcome is fetched with a bearer token, so asking for it
   * before the session has settled sends an unauthenticated request and gets
   * nothing back. Phase 5's bid panel raced exactly this and showed a signed-in
   * bidder a signed-out view for a moment.
   */
  readonly sessionSettled?: boolean;
}): React.JSX.Element | null {
  const [state, setState] = useState<State>({ kind: 'idle' });

  useEffect(() => {
    if (!mayHaveResult(status) || !sessionSettled) return;
    let cancelled = false;

    void (async () => {
      try {
        const result = await api.fetchResult(reference);
        if (cancelled) return;
        if (!result) {
          // Still being calculated: there is genuinely nothing to show yet.
          setState({ kind: 'idle' });
          return;
        }
        const mine = viewerId === undefined ? undefined : await api.fetchMyOutcome(reference);
        if (cancelled) return;
        setState({ kind: 'ready', result, ...(mine === undefined ? {} : { mine }) });
      } catch (cause) {
        if (cancelled) return;
        setState({
          kind: 'error',
          message: cause instanceof Error ? cause.message : 'This result could not be loaded.',
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [reference, status, viewerId, sessionSettled]);

  if (state.kind === 'idle') return null;

  if (state.kind === 'error') {
    return (
      <Panel title="Result">
        <Notice kind="error">{state.message}</Notice>
      </Panel>
    );
  }

  const { result, mine } = state;
  const currency = result.currency;

  return (
    <Panel title="Result">
      {mine !== undefined && <MyOutcome mine={mine} currency={currency} />}

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="opacity-70">Outcome</dt>
        <dd>{OUTCOME_LABEL[result.outcome]}</dd>
        {result.winningAmountMinor !== null && (
          <>
            <dt className="opacity-70">Winning bid</dt>
            <dd className="tabular-nums font-medium">{money(result.winningAmountMinor, currency)}</dd>
          </>
        )}
        <dt className="opacity-70">Bids placed</dt>
        <dd className="tabular-nums">{result.statistics.totalValidBids}</dd>
        <dt className="opacity-70">People bidding</dt>
        <dd className="tabular-nums">{result.statistics.participantCount}</dd>
        <dt className="opacity-70">Amounts nobody matched</dt>
        <dd className="tabular-nums">{result.statistics.uniqueAmountCount}</dd>
        <dt className="opacity-70">Decided</dt>
        <dd>{new Date(result.computedAt).toLocaleString()}</dd>
      </dl>

      <p className="mt-3 text-xs opacity-60">
        Decided by {result.algorithmVersion}: the lowest amount exactly one person bid.
      </p>
      {/*
        The checksum is published on purpose. It fingerprints the exact set of
        bids the winner was chosen from, so the result can be re-verified later
        without anybody's bids being published — which is the whole point of a
        digest over a private set. `break-all` because it is 64 characters and
        must not push the panel sideways on a phone.
      */}
      <p className="mt-1 text-xs opacity-50">
        Bid-set checksum <code className="break-all">{result.checksum}</code>
      </p>
    </Panel>
  );
}

const OUTCOME_LABEL: Record<AuctionResultDto['outcome'], string> = {
  winner: 'Won',
  no_unique_bid: 'No winner — every amount was bid by more than one person',
  no_bids: 'No bids were placed',
  cancelled: 'Cancelled',
};

/**
 * The viewer's own standing, said plainly and first.
 *
 * Four messages for the four things that can have happened to them. Each says
 * what it means for *their* money, because that is the question somebody
 * opening a closed auction is actually asking.
 */
function MyOutcome({
  mine,
  currency,
}: {
  readonly mine: MyAuctionOutcomeDto;
  readonly currency: Currency;
}): React.JSX.Element | null {
  if (mine.bidCount === 0 && !mine.won) return null;

  if (mine.won) {
    return (
      <Notice kind="success">
        <strong>You won.</strong> Your bid of {money(mine.winningAmountMinor ?? '0', currency)} was the lowest
        amount nobody else matched.
        {mine.order !== null && (
          <>
            {' '}
            Order {mine.order.orderNumber} is awaiting payment of {money(mine.order.totalMinor, currency)}
            {mine.order.paymentDueAt !== null && (
              <> by {new Date(mine.order.paymentDueAt).toLocaleString()}</>
            )}
            .
          </>
        )}
      </Notice>
    );
  }

  if (mine.outcome === 'no_unique_bid') {
    return (
      <Notice kind="info">
        <strong>Nobody won this auction.</strong> Every amount was bid by two or more people, so there was no
        lowest unique bid.
        {mine.refundedMinor !== '0' && (
          <> Your {money(mine.refundedMinor, currency)} in fees has been returned to your wallet.</>
        )}
      </Notice>
    );
  }

  if (mine.outcome === 'cancelled') {
    return (
      <Notice kind="info">
        <strong>This auction was cancelled.</strong>
        {mine.refundedMinor !== '0' && (
          <> Your {money(mine.refundedMinor, currency)} in fees has been returned to your wallet.</>
        )}
      </Notice>
    );
  }

  return (
    <Notice kind="info">
      <strong>You did not win.</strong> The winning bid was {money(mine.winningAmountMinor ?? '0', currency)}.
      You placed {mine.bidCount} {mine.bidCount === 1 ? 'bid' : 'bids'}
      {mine.feesPaidMinor !== '0' && <> costing {money(mine.feesPaidMinor, currency)}</>}.
    </Notice>
  );
}
