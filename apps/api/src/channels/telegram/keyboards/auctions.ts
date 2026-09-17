import type { AuctionSummaryDto } from '@howlow/shared';
import type { InlineKeyboardButton, InlineKeyboardMarkup } from 'grammy/types';

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
  /** Begin bidding on one auction: `ab:<uuid>`. */
  auctionBid: 'ab',
  /**
   * Submit the draft the user has already confirmed on screen: `bc`.
   *
   * No auction id and no amounts in the payload. Both live in the draft the
   * server minted when it showed the confirmation, keyed by the Telegram user
   * — so a crafted payload cannot submit amounts the user never saw, and a
   * replayed one cannot submit to a different auction. This is what "use
   * compact identifiers, never state" means in practice.
   */
  bidConfirm: 'bc',
  /** Discard the draft: `bx`. */
  bidCancel: 'bx',
  /** Show the result of a decided auction: `ar:<uuid>`. */
  auctionResult: 'ar',
} as const;

/** Telegram's hard limit on callback data. */
export const MAX_CALLBACK_BYTES = 64;

export function auctionCallback(auctionId: string): string {
  return `${CALLBACK.auction}:${auctionId}`;
}

export function bidCallback(auctionId: string): string {
  return `${CALLBACK.auctionBid}:${auctionId}`;
}

export function resultCallback(auctionId: string): string {
  return `${CALLBACK.auctionResult}:${auctionId}`;
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
 * The bid button offers to bid only when the auction is actually taking bids.
 * Whether it does is re-decided server-side when the button is pressed: this
 * is a rendering of the state a moment ago, and an auction can close between
 * the message being sent and the button being tapped.
 */
export function auctionDetailKeyboard(input: {
  auctionId: string;
  webUrl: string;
  acceptsBids: boolean;
  /** True once the auction has been decided, so a result exists to read. */
  hasResult?: boolean;
}): InlineKeyboardMarkup {
  // Typed explicitly: inferred from its first row this would be a list of
  // URL buttons, and the callback rows below would not fit it.
  const rows: InlineKeyboardButton[][] = [[{ text: 'Open on the website', url: input.webUrl }]];

  // A decided auction offers its result instead of a dead bid button. The two
  // are mutually exclusive by the lifecycle itself — an auction taking bids
  // has no result, and one with a result takes none — so this is a choice
  // about what the reader wants, not a pair of states that could overlap.
  if (input.hasResult === true) {
    rows.push([{ text: '🏆 See the result', callback_data: resultCallback(input.auctionId) }]);
  } else {
    rows.push([
      {
        text: input.acceptsBids ? '💸 Place a bid' : 'Not taking bids',
        callback_data: bidCallback(input.auctionId),
      },
    ]);
  }

  rows.push([{ text: '◂ Back to auctions', callback_data: `${CALLBACK.auctionList}:0` }]);
  return { inline_keyboard: rows };
}

/** After a result: back to the auction, or on to the rest of the list. */
export function resultKeyboard(auctionId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: 'Back to the auction', callback_data: auctionCallback(auctionId) }],
      [{ text: '◂ All auctions', callback_data: `${CALLBACK.auctionList}:0` }],
    ],
  };
}

/**
 * Confirm or discard a bid draft.
 *
 * Both payloads are bare verbs. Everything the submission needs — the auction,
 * the amounts, and the idempotency key that makes a double-tap harmless — is
 * in the server-side draft.
 */
export function bidConfirmKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '✅ Confirm', callback_data: CALLBACK.bidConfirm },
        { text: '✖ Cancel', callback_data: CALLBACK.bidCancel },
      ],
    ],
  };
}

/** After a submission: straight back to the auction the user just bid on. */
export function bidResultKeyboard(auctionId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: 'Back to the auction', callback_data: auctionCallback(auctionId) }],
      [{ text: '◂ All auctions', callback_data: `${CALLBACK.auctionList}:0` }],
    ],
  };
}
