import type { AuctionSummaryDto } from '@howlow/shared';
import type { InlineKeyboardMarkup } from 'grammy/types';

/**
 * Inline keyboards for auction browsing.
 *
 * ## Callback data
 *
 * Callback payloads carry a **compact identifier and nothing else** — no
 * status, no price, no permission, no user id. Telegram delivers whatever the
 * client sends, so a payload is a request, never a fact: every handler
 * re-resolves the auction and re-checks the caller server-side. Putting state
 * in the payload would be trusting the client with it.
 *
 * Telegram caps callback data at 64 bytes, and a uuid with a short prefix fits
 * comfortably inside that.
 */
export const CALLBACK = {
  /** Open one auction: `a:<uuid>`. */
  auction: 'a',
  /** A page of the listing: `al:<cursor or 0>`. */
  auctionList: 'al',
  /** The bidding placeholder: `ab:<uuid>`. */
  auctionBid: 'ab',
} as const;

/** Telegram's hard limit on callback data. */
export const MAX_CALLBACK_BYTES = 64;

export function auctionCallback(auctionId: string): string {
  return `${CALLBACK.auction}:${auctionId}`;
}

export function bidCallback(auctionId: string): string {
  return `${CALLBACK.auctionBid}:${auctionId}`;
}

/**
 * A cursor is already base64url, so it fits the 64-byte budget for any
 * realistic value; a cursor that somehow would not is dropped rather than
 * truncated, which would send the reader to the wrong page.
 */
export function listCallback(cursor: string | null): string | undefined {
  if (cursor === null) return undefined;
  const data = `${CALLBACK.auctionList}:${cursor}`;
  return Buffer.byteLength(data, 'utf8') <= MAX_CALLBACK_BYTES ? data : undefined;
}

/** One button per auction, then a "more" button when another page exists. */
export function auctionListKeyboard(input: {
  auctions: readonly AuctionSummaryDto[];
  nextCursor: string | null;
}): InlineKeyboardMarkup {
  const rows = input.auctions.map((auction) => [
    {
      // Truncated so a long product name cannot push the button off the row.
      text: `${auction.productTitle.slice(0, 40)}`,
      callback_data: auctionCallback(auction.id),
    },
  ]);

  const more = listCallback(input.nextCursor);
  if (more !== undefined) rows.push([{ text: 'Show more ▸', callback_data: more }]);
  return { inline_keyboard: rows };
}

/**
 * The detail keyboard.
 *
 * The bidding button is present but says what it is: Phase 5 implements
 * bidding, and a button that silently did nothing would be worse than one that
 * explains itself.
 */
export function auctionDetailKeyboard(input: {
  auctionId: string;
  webUrl: string;
  acceptsBids: boolean;
}): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: 'Open on the website', url: input.webUrl }],
      [
        {
          text: input.acceptsBids ? 'Bidding — coming soon' : 'Not taking bids',
          callback_data: bidCallback(input.auctionId),
        },
      ],
      [{ text: '◂ Back to auctions', callback_data: `${CALLBACK.auctionList}:0` }],
    ],
  };
}
