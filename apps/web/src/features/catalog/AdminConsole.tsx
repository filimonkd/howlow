import { useCallback, useEffect, useState } from 'react';
import type { AuctionSummaryDto, CategoryTreeDto } from '@howlow/shared';
import * as api from '../../lib/catalog-api.js';
import { Button, Field, Notice, Panel, useForm } from '../../components/AuthForms.js';
import { StatusBadge, money } from '../auctions/AuctionCard.js';

/**
 * Auction review and category management.
 *
 * Every action is a named transition, never a status assignment: there is no
 * control here that could put an auction into an arbitrary state, because the
 * API exposes no such endpoint.
 *
 * Reject, suspend and cancel each require a reason, which the API enforces —
 * an unexplained decision against a seller's listing is not something to
 * leave behind.
 */
type Feedback = { readonly kind: 'error' | 'info'; readonly message: string } | undefined;

export function AdminConsole(): React.JSX.Element {
  const [pending, setPending] = useState<readonly AuctionSummaryDto[]>();
  const [categories, setCategories] = useState<readonly CategoryTreeDto[]>();
  const [feedback, setFeedback] = useState<Feedback>();
  const [loadError, setLoadError] = useState<string>();
  const categoryForm = useForm({ name: '', parentId: '' });

  const reload = useCallback(async (): Promise<void> => {
    setLoadError(undefined);
    try {
      const [queue, tree] = await Promise.all([api.fetchPendingAuctions(), api.fetchAllCategories()]);
      setPending(queue.auctions);
      setCategories(tree);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : 'The review queue could not be loaded.');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = (action: () => Promise<void>): void => {
    setFeedback(undefined);
    void action().catch((cause: unknown) => {
      setFeedback({
        kind: 'error',
        message: cause instanceof Error ? cause.message : 'That did not work.',
      });
    });
  };

  return (
    <div className="space-y-4">
      {loadError !== undefined && <Notice kind="error">{loadError}</Notice>}
      {feedback !== undefined && <Notice kind={feedback.kind}>{feedback.message}</Notice>}

      <Panel title="Auctions awaiting review">
        {pending === undefined ? (
          <p className="text-sm opacity-70">Loading…</p>
        ) : pending.length === 0 ? (
          <p className="text-sm opacity-70">Nothing is waiting for review. Submitted auctions appear here.</p>
        ) : (
          <ul className="divide-y divide-black/10 dark:divide-white/15">
            {pending.map((auction) => (
              <li key={auction.id} className="py-3">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="font-medium">{auction.title}</span>
                  <StatusBadge status={auction.status} />
                </div>
                <dl className="mb-2 grid grid-cols-[auto_1fr] gap-x-3 text-xs opacity-70">
                  <dt>Product</dt>
                  <dd>{auction.productTitle}</dd>
                  <dt>Seller</dt>
                  <dd>{auction.sellerName}</dd>
                  <dt>Reference</dt>
                  <dd>{money(auction.retailPriceMinor, auction.terms.currency)}</dd>
                  <dt>Bid range</dt>
                  <dd>
                    {money(auction.terms.minBidMinor, auction.terms.currency)} –{' '}
                    {money(auction.terms.maxBidMinor, auction.terms.currency)} in steps of{' '}
                    {money(auction.terms.bidIncrementMinor, auction.terms.currency)}
                  </dd>
                  <dt>Fee</dt>
                  <dd>
                    {auction.terms.bidFeeMinor === '0'
                      ? 'free to enter'
                      : `${money(auction.terms.bidFeeMinor, auction.terms.currency)} per bid`}
                  </dd>
                  <dt>Runs</dt>
                  <dd>
                    {new Date(auction.startsAt).toLocaleString()} →{' '}
                    {new Date(auction.endsAt).toLocaleString()}
                  </dd>
                </dl>
                <ReviewActions
                  auctionId={auction.id}
                  onDone={(message) => {
                    setFeedback(message);
                    void reload();
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Categories">
        {categories === undefined ? (
          <p className="text-sm opacity-70">Loading…</p>
        ) : (
          <ul className="mb-4 space-y-1 text-sm">
            {categories.map((category) => (
              <li key={category.id}>
                <span className={category.isActive ? '' : 'opacity-50'}>
                  {category.name}
                  {category.isActive ? '' : ' (inactive)'}
                </span>
                {category.children.length > 0 && (
                  <ul className="ml-4 list-inside list-disc opacity-80">
                    {category.children.map((child) => (
                      <li key={child.id} className={child.isActive ? '' : 'opacity-50'}>
                        {child.name}
                        {child.isActive ? '' : ' (inactive)'}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}

        <form
          onSubmit={categoryForm.onSubmit(() => {
            run(async () => {
              await api.createCategory({
                name: categoryForm.values.name,
                ...(categoryForm.values.parentId === '' ? {} : { parentId: categoryForm.values.parentId }),
              });
              categoryForm.reset();
              setFeedback({ kind: 'info', message: 'Category created.' });
              await reload();
            });
          })}
        >
          <Field
            label="New category name"
            value={categoryForm.values.name}
            onChange={categoryForm.set('name')}
          />
          <label className="mb-3 block text-sm">
            <span className="mb-1 block opacity-70">Parent (optional)</span>
            <select
              className="w-full rounded-md border border-black/15 bg-transparent px-3 py-2 dark:border-white/20"
              value={categoryForm.values.parentId}
              onChange={(event) => {
                categoryForm.set('parentId')(event.target.value);
              }}
            >
              <option value="">Top level</option>
              {(categories ?? []).map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>
          <Button>Create category</Button>
        </form>
      </Panel>
    </div>
  );
}

/** Approve, or refuse with a reason the seller will read. */
function ReviewActions({
  auctionId,
  onDone,
}: {
  readonly auctionId: string;
  readonly onDone: (feedback: Feedback) => void;
}): React.JSX.Element {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const act = (action: () => Promise<unknown>, success: string): void => {
    setBusy(true);
    void action()
      .then(() => {
        onDone({ kind: 'info', message: success });
        setReason('');
      })
      .catch((cause: unknown) => {
        onDone({
          kind: 'error',
          message: cause instanceof Error ? cause.message : 'That did not work.',
        });
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <div className="space-y-2">
      <Field
        label="Reason (required to reject, suspend or cancel — at least 8 characters)"
        value={reason}
        onChange={setReason}
        placeholder="The photographs do not show the item described"
      />
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy}
          onClick={() => {
            act(() => api.approveAuction(auctionId), 'Approved and scheduled.');
          }}
        >
          Approve
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => {
            act(() => api.rejectAuction(auctionId, reason), 'Returned to the seller.');
          }}
        >
          Reject
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => {
            act(() => api.suspendAuction(auctionId, reason), 'Suspended.');
          }}
        >
          Suspend
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => {
            act(() => api.resumeAuction(auctionId), 'Resumed.');
          }}
        >
          Resume
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => {
            act(() => api.cancelAuction(auctionId, reason), 'Cancelled.');
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
