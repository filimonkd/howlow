import type { AuctionDetailDto, AuctionSummaryDto, WalletEntryType } from '@howlow/shared';
import { formatMoney, moneyFromMinorString } from '@howlow/shared';

/**
 * Rendering auctions for a chat.
 *
 * Presentation only: nothing here decides anything, and nothing here reads the
 * database. The numbers come from the same module the website calls, so a chat
 * and a browser cannot disagree about an auction — only about how it looks.
 */

/** Money for a person to read. Parsed as an exact integer, never a float. */
export function money(minor: string, currency: AuctionSummaryDto['terms']['currency']): string {
  return formatMoney(moneyFromMinorString(minor, currency));
}

/**
 * A countdown from the server's own figure.
 *
 * `secondsRemaining` is computed by the API against the database clock, so a
 * viewer's device being wrong cannot change what the bot tells them.
 */
export function remaining(seconds: number): string {
  if (seconds <= 0) return 'ended';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${String(hours).padStart(2, '0')}h`;
  if (hours > 0) return `${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m`;
}

const STATUS_LABELS: Record<AuctionSummaryDto['status'], string> = {
  draft: 'Draft',
  pending_approval: 'Awaiting review',
  scheduled: '🕒 Starting soon',
  live: '🔥 Live',
  closing: '⌛ Closing',
  calculating: '🧮 Being decided',
  completed: '✅ Finished',
  cancelled: '✖ Cancelled',
  suspended: '⏸ Suspended',
};

export const statusLabel = (status: AuctionSummaryDto['status']): string => STATUS_LABELS[status];

const CONDITION_LABELS: Record<AuctionDetailDto['productCondition'], string> = {
  new: 'New',
  refurbished: 'Refurbished',
  used_like_new: 'Used — like new',
  used_good: 'Used — good',
  used_fair: 'Used — fair',
};

/** One line per auction in a list. */
export function renderSummary(auction: AuctionSummaryDto): string {
  const currency = auction.terms.currency;
  const timing =
    auction.status === 'scheduled'
      ? `Starts in: ${remaining(Math.trunc((Date.parse(auction.startsAt) - Date.now()) / 1000))}`
      : `Ends in: ${remaining(auction.secondsRemaining)}`;
  return [
    `${statusLabel(auction.status)}  ${auction.productTitle}`,
    timing,
    `Reference: ${money(auction.retailPriceMinor, currency)}`,
  ].join('\n');
}

/**
 * The detail a bidder needs to decide.
 *
 * Deliberately carries no bid count, no bidder and no hint of which amounts
 * are currently unique: any of those would let someone reverse-engineer the
 * lowest unique bid, which is the one thing the format depends on keeping
 * private. The payload the API returns does not contain them either.
 */
export function renderDetail(auction: AuctionDetailDto, webUrl: string): string {
  const currency = auction.terms.currency;
  const lines = [
    `${statusLabel(auction.status)}`,
    '',
    `*${auction.productTitle}*`,
    `Condition: ${CONDITION_LABELS[auction.productCondition]}`,
    auction.productBrand === null ? '' : `Brand: ${auction.productBrand}`,
    `Reference price: ${money(auction.retailPriceMinor, currency)}`,
    '',
    auction.status === 'scheduled'
      ? `Starts: ${new Date(auction.startsAt).toUTCString()}`
      : `Ends in: ${remaining(auction.secondsRemaining)}`,
    `Closes: ${new Date(auction.endsAt).toUTCString()}`,
    '',
    'How this auction works',
    `• Bid anywhere from ${money(auction.terms.minBidMinor, currency)} to ${money(
      auction.terms.maxBidMinor,
      currency,
    )}`,
    `• In steps of ${money(auction.terms.bidIncrementMinor, currency)}`,
    `• Up to ${auction.terms.maxBidsPerUser} bids each`,
    `• ${
      auction.terms.bidFeeMinor === '0'
        ? 'Free to enter'
        : `${money(auction.terms.bidFeeMinor, currency)} per bid`
    }`,
    '• The lowest bid nobody else matched wins',
    `• The winner has ${auction.terms.winnerPaymentHours} hours to pay`,
  ];

  if (auction.description !== null) lines.push('', auction.description);
  if (auction.shippingNote !== null) lines.push('', `Shipping: ${auction.shippingNote}`);

  const specs = Object.entries(auction.productSpecs);
  if (specs.length > 0) {
    lines.push('', ...specs.map(([key, value]) => `${key}: ${value}`));
  }

  lines.push('', webUrl);
  return lines.filter((line, index) => line !== '' || lines[index - 1] !== '').join('\n');
}

/** Bidding is Phase 5. Until then the bot says plainly what it cannot do yet. */
export function renderBiddingNotice(auction: AuctionDetailDto): string {
  if (auction.status === 'live' || auction.status === 'closing') {
    return 'Bidding from Telegram is coming soon. Open the auction on the website to take part.';
  }
  if (auction.status === 'scheduled') return 'This auction has not opened yet.';
  return 'This auction is no longer taking bids.';
}

/** Unused here; kept so the render module owns every label the bot shows. */
export const WALLET_ENTRY_LABELS: Partial<Record<WalletEntryType, string>> = {
  bid_fee: 'bid fee',
  bid_fee_refund: 'bid fee refunded',
};
