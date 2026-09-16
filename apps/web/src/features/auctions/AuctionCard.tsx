import { formatMoney, moneyFromMinorString, type AuctionSummaryDto } from '@howlow/shared';

/**
 * Shared auction presentation.
 *
 * Every figure comes from the API. Nothing is computed here, so a browser with
 * a wrong clock or a rounding bug cannot show a different auction from the one
 * the Telegram bot shows.
 */
export function money(minor: string, currency: AuctionSummaryDto['terms']['currency']): string {
  return formatMoney(moneyFromMinorString(minor, currency));
}

const STATUS_STYLES: Record<AuctionSummaryDto['status'], { label: string; className: string }> = {
  draft: { label: 'Draft', className: 'bg-black/10 dark:bg-white/15' },
  pending_approval: { label: 'Awaiting review', className: 'bg-amber-500/20 text-amber-800 dark:text-amber-300' },
  scheduled: { label: 'Starting soon', className: 'bg-sky-500/20 text-sky-800 dark:text-sky-300' },
  live: { label: 'Live', className: 'bg-green-600/20 text-green-800 dark:text-green-300' },
  closing: { label: 'Closing', className: 'bg-orange-500/20 text-orange-800 dark:text-orange-300' },
  calculating: { label: 'Being decided', className: 'bg-violet-500/20 text-violet-800 dark:text-violet-300' },
  completed: { label: 'Finished', className: 'bg-black/10 dark:bg-white/15' },
  cancelled: { label: 'Cancelled', className: 'bg-red-600/20 text-red-800 dark:text-red-300' },
  suspended: { label: 'Suspended', className: 'bg-red-600/20 text-red-800 dark:text-red-300' },
};

export function StatusBadge({
  status,
}: {
  readonly status: AuctionSummaryDto['status'];
}): React.JSX.Element {
  const style = STATUS_STYLES[status];
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${style.className}`}>
      {style.label}
    </span>
  );
}

/**
 * A countdown anchored to the server's figure.
 *
 * `secondsRemaining` is computed by the API against the database clock. It is
 * decremented locally only so the display ticks; the anchor is never the
 * browser's own idea of the time.
 */
export function formatRemaining(seconds: number): string {
  if (seconds <= 0) return 'Ended';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(secs).padStart(2, '0')}s`;
  return `${secs}s`;
}

export function AuctionCard({
  auction,
  onOpen,
}: {
  readonly auction: AuctionSummaryDto;
  readonly onOpen: () => void;
}): React.JSX.Element {
  const currency = auction.terms.currency;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col gap-2 rounded-lg border border-black/10 p-4 text-left hover:border-black/25 dark:border-white/15 dark:hover:border-white/30"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium">{auction.productTitle}</span>
        <StatusBadge status={auction.status} />
      </div>

      {auction.primaryImage === null ? (
        <div className="flex h-32 items-center justify-center rounded-md bg-black/5 text-xs opacity-60 dark:bg-white/10">
          No photograph yet
        </div>
      ) : (
        <img
          src={auction.primaryImage.url}
          alt={auction.primaryImage.altText ?? auction.productTitle}
          className="h-32 w-full rounded-md object-cover"
        />
      )}

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-sm">
        <dt className="opacity-70">Reference</dt>
        <dd className="tabular-nums">{money(auction.retailPriceMinor, currency)}</dd>
        <dt className="opacity-70">Bid range</dt>
        <dd className="tabular-nums">
          {money(auction.terms.minBidMinor, currency)} – {money(auction.terms.maxBidMinor, currency)}
        </dd>
        <dt className="opacity-70">{auction.status === 'scheduled' ? 'Starts' : 'Ends'}</dt>
        <dd className="tabular-nums">
          {auction.status === 'scheduled'
            ? new Date(auction.startsAt).toLocaleString()
            : formatRemaining(auction.secondsRemaining)}
        </dd>
      </dl>
      <span className="text-xs opacity-60">{auction.sellerName}</span>
    </button>
  );
}
