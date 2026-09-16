import type { AuctionDetailDto } from '@howlow/shared';
import { describe, expect, it } from 'vitest';
import {
  auctionDetailKeyboard,
  auctionListKeyboard,
  listCallback,
  MAX_CALLBACK_BYTES,
} from '../keyboards/auctions.js';
import { money, remaining, renderBiddingNotice, renderDetail, renderSummary } from './auctions.js';

/**
 * Telegram rendering and callback payloads.
 *
 * Two things matter here beyond looking right: the payloads must fit Telegram's
 * 64-byte budget, and nothing the bot shows may hint at which bid amounts are
 * unique.
 */
const DETAIL: AuctionDetailDto = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'iphone-16-pro',
  title: 'iPhone 16 Pro Auction',
  status: 'live',
  startsAt: '2026-09-01T00:00:00.000Z',
  endsAt: '2026-09-02T00:00:00.000Z',
  secondsRemaining: 8100,
  sellerName: 'Addis Electronics',
  categorySlug: 'phones',
  productTitle: 'iPhone 16 Pro',
  productCondition: 'new',
  retailPriceMinor: '12000000',
  primaryImage: null,
  terms: {
    currency: 'ETB',
    minBidMinor: '100',
    maxBidMinor: '5000',
    bidIncrementMinor: '100',
    maxBidsPerUser: 25,
    bidFeeMinor: '500',
    winnerPaymentHours: 48,
  },
  description: 'A sealed handset, sold with a one-year warranty.',
  shippingNote: 'Delivered within Addis Ababa in two days.',
  productDescription: 'The 2026 model.',
  productBrand: 'Apple',
  productSpecs: { Storage: '256GB' },
  images: [],
  quantity: 1,
  algorithmVersion: 'LUB_V1',
  openedAt: '2026-09-01T00:00:00.000Z',
  closedAt: null,
};

describe('money', () => {
  it('formats minor units without touching a float', () => {
    expect(money('12000000', 'ETB')).toBe('120000.00 ETB');
    expect(money('0', 'ETB')).toBe('0.00 ETB');
  });

  /** A price beyond 2^53 must survive, which is why it stays a string. */
  it('formats an amount larger than a double can hold exactly', () => {
    expect(money('9007199254740993', 'ETB')).toBe('90071992547409.93 ETB');
  });
});

describe('countdown', () => {
  it('reads from the server figure, not the device clock', () => {
    expect(remaining(8100)).toBe('02h 15m');
    expect(remaining(90_000)).toBe('1d 01h');
    expect(remaining(120)).toBe('2m');
    expect(remaining(0)).toBe('ended');
    expect(remaining(-500)).toBe('ended');
  });
});

describe('the detail message', () => {
  const body = renderDetail(DETAIL, 'https://howlow.example/auctions/iphone-16-pro');

  it('shows the terms a bidder needs to decide', () => {
    expect(body).toContain('iPhone 16 Pro');
    expect(body).toContain('1.00 ETB');
    expect(body).toContain('50.00 ETB');
    expect(body).toContain('Up to 25 bids each');
    expect(body).toContain('5.00 ETB per bid');
    expect(body).toContain('The lowest bid nobody else matched wins');
    expect(body).toContain('48 hours to pay');
    expect(body).toContain('Ends in: 02h 15m');
    expect(body).toContain('https://howlow.example/auctions/iphone-16-pro');
  });

  /**
   * The thing that must never appear. A bid count, a bidder, or any signal
   * about which amounts are still unique would let someone work out the lowest
   * unique bid.
   */
  it('reveals nothing about who has bid or which amounts are unique', () => {
    for (const forbidden of [
      /\bbids so far\b/i,
      /\bbidders?\b/i,
      /\bunique\b/i,
      /\bwinning\b/i,
      /\bcurrent\s+(lowest|winner|leader)\b/i,
      /\bparticipants?\b/i,
    ]) {
      expect(body).not.toMatch(forbidden);
    }
  });

  it('says plainly when an auction is free to enter', () => {
    const free = renderDetail(
      { ...DETAIL, terms: { ...DETAIL.terms, bidFeeMinor: '0' } },
      'https://howlow.example/a',
    );
    expect(free).toContain('Free to enter');
    expect(free).not.toContain('0.00 ETB per bid');
  });

  it('shows a start time rather than a countdown before an auction opens', () => {
    const scheduled = renderDetail({ ...DETAIL, status: 'scheduled' }, 'https://howlow.example/a');
    expect(scheduled).toContain('Starts:');
    expect(scheduled).toContain('🕒 Starting soon');
  });
});

describe('the summary line', () => {
  it('shows status, timing and the reference price', () => {
    const line = renderSummary(DETAIL);
    expect(line).toContain('🔥 Live');
    expect(line).toContain('iPhone 16 Pro');
    expect(line).toContain('Ends in:');
    expect(line).toContain('Reference: 120000.00 ETB');
  });
});

describe('the bidding placeholder', () => {
  it('explains itself rather than doing nothing quietly', () => {
    expect(renderBiddingNotice(DETAIL)).toMatch(/coming soon/i);
    expect(renderBiddingNotice({ ...DETAIL, status: 'scheduled' })).toMatch(/not opened yet/i);
    expect(renderBiddingNotice({ ...DETAIL, status: 'completed' })).toMatch(/no longer taking bids/i);
  });
});

describe('callback payloads', () => {
  /**
   * Telegram caps callback data at 64 bytes and delivers whatever the client
   * sends, so payloads carry a compact identifier and nothing else.
   */
  it('fits Telegram’s budget', () => {
    const keyboard = auctionDetailKeyboard({
      auctionId: DETAIL.id,
      webUrl: 'https://howlow.example/a',
      acceptsBids: true,
    });
    for (const row of keyboard.inline_keyboard) {
      for (const button of row) {
        if ('callback_data' in button && button.callback_data !== undefined) {
          expect(Buffer.byteLength(button.callback_data, 'utf8')).toBeLessThanOrEqual(
            MAX_CALLBACK_BYTES,
          );
        }
      }
    }
  });

  it('carries no status, price or permission', () => {
    const keyboard = auctionListKeyboard({
      auctions: [
        {
          ...DETAIL,
          id: '22222222-2222-4222-8222-222222222222',
        },
      ],
      nextCursor: null,
    });
    const payload = keyboard.inline_keyboard[0]?.[0];
    expect(payload && 'callback_data' in payload ? payload.callback_data : '').toBe(
      'a:22222222-2222-4222-8222-222222222222',
    );
  });

  it('offers another page only when one exists', () => {
    const last = auctionListKeyboard({ auctions: [DETAIL], nextCursor: null });
    expect(last.inline_keyboard.some((row) => row[0]?.text.includes('Show more'))).toBe(false);

    const more = auctionListKeyboard({ auctions: [DETAIL], nextCursor: 'abc123' });
    expect(more.inline_keyboard.some((row) => row[0]?.text.includes('Show more'))).toBe(true);
  });

  /** A payload that would not fit is dropped, never truncated to the wrong page. */
  it('drops an oversized cursor rather than truncating it', () => {
    expect(listCallback('x'.repeat(200))).toBeUndefined();
    expect(listCallback(null)).toBeUndefined();
    expect(listCallback('abc')).toBe('al:abc');
  });
});
