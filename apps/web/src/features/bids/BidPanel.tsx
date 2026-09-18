import { useCallback, useEffect, useState } from 'react';
import {
  duplicateAmounts,
  parseAmountList,
  type AuctionDetailDto,
  type BidDto,
  type MyBidsDto,
} from '@howlow/shared';
import * as bids from '../../lib/bid-api.js';
import * as wallet from '../../lib/wallet-api.js';
import { Button, Notice, Panel } from '../../components/AuthForms.js';
import { money } from '../auctions/AuctionCard.js';

/**
 * Placing bids from the website.
 *
 * ## What this shows
 *
 * The bidder's own position and the auction's published terms: what they have
 * bid, how many bids they have left, what the fee will be, and what their
 * wallet holds.
 *
 * ## What it must never show
 *
 * Anything about anyone else. No count of rival bids, no hint of which amounts
 * are taken, no "this looks unique" — the API returns none of it and this
 * component asks for none of it. HOWLOW awards the lowest amount nobody else
 * matched, so a bidder who could see the board would simply be handed the
 * answer. The caller's own bids read `submitted` until the auction closes and
 * Phase 6 decides what they were worth.
 *
 * ## Validation
 *
 * Checked here only so a mistake is caught before the confirmation, never as
 * the rule. The engine re-checks every amount against the auction row it holds
 * locked, so a browser with stale terms produces a refusal rather than a bad
 * bid.
 */

type Stage =
  | { readonly kind: 'entry' }
  | { readonly kind: 'confirming'; readonly amountsMinor: readonly string[]; readonly key: string }
  | { readonly kind: 'submitting'; readonly amountsMinor: readonly string[]; readonly key: string }
  | { readonly kind: 'done'; readonly replayed: boolean; readonly count: number };

export function BidPanel({
  auction,
  onPlaced,
  viewerId,
  sessionSettled = true,
}: {
  readonly auction: AuctionDetailDto;
  readonly onPlaced?: () => void;
  /**
   * The signed-in viewer, or undefined.
   *
   * Not decoration: the auction page is public, so this panel mounts for
   * visitors too, and a read of the caller's own bids issued before the stored
   * session has been rotated comes back 401. Without knowing when that has
   * settled the panel showed a signed-in bidder an empty, signed-out-looking
   * page — which a browser drive of the real UI is what caught.
   */
  readonly viewerId?: string | undefined;
  readonly sessionSettled?: boolean;
}): React.JSX.Element {
  const currency = auction.terms.currency;
  const [mine, setMine] = useState<MyBidsDto | undefined>(undefined);
  const [balanceMinor, setBalanceMinor] = useState<string | undefined>(undefined);
  const [input, setInput] = useState('');
  const [stage, setStage] = useState<Stage>({ kind: 'entry' });
  const [problem, setProblem] = useState<string | undefined>(undefined);

  /**
   * The caller's standing, reloaded after every submission.
   *
   * Both figures come from the server: the bid count from the participant row
   * the engine maintains, the balance from the wallet. Nothing is inferred
   * locally, so a page left open does not drift into telling the user they
   * have bids they have already spent.
   */
  const refresh = useCallback(async (): Promise<void> => {
    if (viewerId === undefined) {
      setMine(undefined);
      setBalanceMinor(undefined);
      return;
    }
    try {
      const [own, account] = await Promise.all([
        bids.fetchMyBids(auction.id),
        wallet.fetchWallet().catch(() => undefined),
      ]);
      setMine(own);
      if (account) setBalanceMinor(account.availableMinor);
    } catch {
      // A read that fails here is not worth a banner on a public page: the
      // panel simply shows nothing of the caller's own, and submitting says
      // what is wrong if it still is.
      setMine(undefined);
    }
    // Re-runs when the session settles, which is the whole point of the prop.
  }, [auction.id, viewerId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const remaining = mine?.bidsRemaining ?? auction.terms.maxBidsPerUser;
  const feePerBid = BigInt(auction.terms.bidFeeMinor);
  const live = auction.status === 'live';

  /** Turn what the user typed into amounts, or say what is wrong with it. */
  const review = (): void => {
    setProblem(undefined);
    const parsed = parseAmountList(input);
    if ('error' in parsed) {
      setProblem(parsed.error);
      return;
    }
    const repeats = duplicateAmounts(parsed.amounts);
    if (repeats.length > 0) {
      setProblem(`You have listed ${repeats.join(', ')} more than once.`);
      return;
    }
    if (parsed.amounts.length > remaining) {
      setProblem(`That is ${String(parsed.amounts.length)} bids and you have ${String(remaining)} left.`);
      return;
    }
    // Range and step are checked against the published terms so the mistake is
    // named before the user commits; the engine checks them again.
    const min = BigInt(auction.terms.minBidMinor);
    const max = BigInt(auction.terms.maxBidMinor);
    const step = BigInt(auction.terms.bidIncrementMinor);
    for (const amount of parsed.amounts) {
      const value = BigInt(amount);
      if (value < min || value > max) {
        setProblem(
          `${money(amount, currency)} is outside ${money(auction.terms.minBidMinor, currency)}–${money(
            auction.terms.maxBidMinor,
            currency,
          )}.`,
        );
        return;
      }
      if ((value - min) % step !== 0n) {
        setProblem(
          `${money(amount, currency)} is not a step of ${money(auction.terms.bidIncrementMinor, currency)}.`,
        );
        return;
      }
    }

    // The key is minted here, with the confirmation the user is about to see,
    // and reused for every retry of this exact submission.
    setStage({ kind: 'confirming', amountsMinor: parsed.amounts, key: bids.newIdempotencyKey() });
  };

  const submit = async (amountsMinor: readonly string[], key: string): Promise<void> => {
    setStage({ kind: 'submitting', amountsMinor, key });
    setProblem(undefined);
    try {
      const result = await bids.submitBids({ reference: auction.id, amountsMinor, idempotencyKey: key });
      setStage({ kind: 'done', replayed: result.replayed, count: result.bids.length });
      setInput('');
      setBalanceMinor(result.walletBalanceMinor);
      await refresh();
      onPlaced?.();
    } catch (cause) {
      setProblem(bids.bidErrorMessage(cause));
      // Back to the confirmation **with the same key**, so pressing Submit
      // again retries the same intention rather than creating a second one.
      setStage(bids.isRetryable(cause) ? { kind: 'confirming', amountsMinor, key } : { kind: 'entry' });
    }
  };

  if (!live) {
    return (
      <Panel title="Bidding">
        <p className="text-sm opacity-70">
          {auction.status === 'scheduled'
            ? 'This auction has not opened yet. Bidding opens at the start time above.'
            : 'This auction is no longer taking bids.'}
        </p>
        {mine !== undefined && mine.bids.length > 0 && (
          <MyBids bids={mine.bids} currency={currency} decided={auction.status === 'completed'} />
        )}
      </Panel>
    );
  }

  if (sessionSettled && viewerId === undefined) {
    return (
      <Panel title="Place your bids">
        <p className="text-sm opacity-70">
          Sign in to bid on this auction. One account covers the website and the Telegram bot, with one wallet
          and one shared bid limit.
        </p>
      </Panel>
    );
  }

  return (
    <Panel title="Place your bids">
      <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="opacity-70">Your bids so far</dt>
        <dd className="tabular-nums">
          {mine?.bidCount ?? 0} of {auction.terms.maxBidsPerUser}
        </dd>
        <dt className="opacity-70">Bids you have left</dt>
        <dd className="tabular-nums">{remaining}</dd>
        <dt className="opacity-70">Fee per bid</dt>
        <dd className="tabular-nums">
          {feePerBid === 0n ? 'Free to enter' : money(auction.terms.bidFeeMinor, currency)}
        </dd>
        {balanceMinor !== undefined && (
          <>
            <dt className="opacity-70">Your wallet</dt>
            <dd className="tabular-nums">{money(balanceMinor, currency)}</dd>
          </>
        )}
      </dl>

      {problem !== undefined && <Notice kind="error">{problem}</Notice>}

      {stage.kind === 'done' && (
        <Notice kind="success">
          {stage.replayed
            ? 'That submission had already been received, so nothing was charged again.'
            : `${String(stage.count)} bid${stage.count === 1 ? '' : 's'} submitted.`}
        </Notice>
      )}

      {(stage.kind === 'entry' || stage.kind === 'done') && remaining > 0 && (
        <div className="mt-3 space-y-2">
          <label className="block text-sm" htmlFor="bid-amounts">
            Amounts, separated by spaces
          </label>
          <input
            id="bid-amounts"
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
            }}
            placeholder={`${auction.terms.minBidMinor} ${String(
              BigInt(auction.terms.minBidMinor) + BigInt(auction.terms.bidIncrementMinor),
            )}`}
            inputMode="numeric"
            className="w-full rounded-md border border-black/15 bg-white px-3 py-2 text-sm tabular-nums dark:border-white/20 dark:bg-black/30"
          />
          <p className="text-xs opacity-60">
            One bid or many. Whole numbers from {money(auction.terms.minBidMinor, currency)} to{' '}
            {money(auction.terms.maxBidMinor, currency)}, in steps of{' '}
            {money(auction.terms.bidIncrementMinor, currency)}.
          </p>
          <Button onClick={review} disabled={input.trim() === ''}>
            Review these bids
          </Button>
        </div>
      )}

      {remaining === 0 && (
        <p className="mt-3 text-sm opacity-70">
          You have used all {auction.terms.maxBidsPerUser} of your bids on this auction.
        </p>
      )}

      {(stage.kind === 'confirming' || stage.kind === 'submitting') && (
        <div className="mt-3 rounded-md border border-black/15 p-3 dark:border-white/20">
          <p className="mb-2 text-sm font-medium">You are submitting:</p>
          <ul className="mb-2 space-y-0.5 text-sm tabular-nums">
            {stage.amountsMinor.map((amount) => (
              <li key={amount}>{money(amount, currency)}</li>
            ))}
          </ul>
          <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="opacity-70">Number of bids</dt>
            <dd className="tabular-nums">{stage.amountsMinor.length}</dd>
            <dt className="opacity-70">Participation fee</dt>
            <dd className="tabular-nums">
              {money((feePerBid * BigInt(stage.amountsMinor.length)).toString(), currency)}
            </dd>
            {balanceMinor !== undefined && (
              <>
                <dt className="opacity-70">Wallet</dt>
                <dd className="tabular-nums">{money(balanceMinor, currency)}</dd>
              </>
            )}
          </dl>
          <div className="flex gap-2">
            <Button
              onClick={() => {
                void submit(stage.amountsMinor, stage.key);
              }}
              disabled={stage.kind === 'submitting'}
            >
              {stage.kind === 'submitting' ? 'Submitting…' : 'Confirm and submit'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setStage({ kind: 'entry' });
                setProblem(undefined);
              }}
              disabled={stage.kind === 'submitting'}
            >
              Cancel
            </Button>
          </div>
          <p className="mt-2 text-xs opacity-60">
            Nothing is charged until you confirm. Once submitted, a bid cannot be changed or withdrawn.
          </p>
        </div>
      )}

      {mine !== undefined && mine.bids.length > 0 && (
        <MyBids bids={mine.bids} currency={currency} decided={auction.status === 'completed'} />
      )}
    </Panel>
  );
}

/**
 * The caller's own bids.
 *
 * Every one reads `submitted` and nothing more. There is no column here for
 * "unique" and there must never be: until the auction closes, not even the
 * bidder is told whether an amount stands alone.
 */
function MyBids({
  bids: own,
  currency,
  decided,
}: {
  readonly bids: readonly BidDto[];
  readonly currency: AuctionDetailDto['terms']['currency'];
  /** True once the auction has been decided, so the promise below is kept. */
  readonly decided: boolean;
}): React.JSX.Element {
  return (
    <div className="mt-4">
      <h3 className="mb-1 text-sm font-medium">Your bids</h3>
      <ul className="space-y-0.5 text-sm">
        {[...own]
          .sort((a, b) => (BigInt(a.amountMinor) < BigInt(b.amountMinor) ? -1 : 1))
          .map((bid) => (
            <li key={bid.id} className="flex justify-between gap-4">
              <span className="tabular-nums">{money(bid.amountMinor, currency)}</span>
              <span className="opacity-60">
                {bid.status === 'submitted' ? 'submitted' : bid.status}
                {bid.channel === 'telegram' && ' · from Telegram'}
              </span>
            </li>
          ))}
      </ul>
      {/*
        Dropped once the auction is decided. Promising to tell somebody the
        result *underneath* the panel that has just told them reads as though
        the page does not know its own state — seen in a browser drive of a
        completed auction, where both were on screen together.
      */}
      {!decided && (
        <p className="mt-1 text-xs opacity-60">You will be told the result when the auction closes.</p>
      )}
    </div>
  );
}
