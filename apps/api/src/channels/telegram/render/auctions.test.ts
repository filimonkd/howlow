import type { AuctionDetailDto, AuctionResultDto, MyAuctionOutcomeDto } from '@howlow/shared';
import { describe, expect, it } from 'vitest';
import {
  auctionDetailKeyboard,
  auctionListKeyboard,
  listCallback,
  MAX_CALLBACK_BYTES,
  resultCallback,
} from '../keyboards/auctions.js';
import {
  money,
  remaining,
  renderBiddingNotice,
  renderDetail,
  renderMyOutcome,
  renderResult,
  renderSummary,
} from './auctions.js';

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

describe('refusing to bid', () => {
  /**
   * Phase 4 showed a "bidding coming soon" notice here; Phase 5 implements
   * bidding, so this now only explains why an auction will not take one.
   */
  it('says why an auction is not taking bids', () => {
    expect(renderBiddingNotice({ ...DETAIL, status: 'scheduled' })).toMatch(/not opened yet/i);
    expect(renderBiddingNotice({ ...DETAIL, status: 'completed' })).toMatch(/no longer taking bids/i);
    expect(renderBiddingNotice({ ...DETAIL, status: 'cancelled' })).toMatch(/no longer taking bids/i);
  });

  it('never hints at anything about other bidders', () => {
    for (const status of ['scheduled', 'completed', 'cancelled', 'suspended'] as const) {
      const notice = renderBiddingNotice({ ...DETAIL, status });
      expect(notice).not.toMatch(/unique|taken|someone else/i);
    }
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
          expect(Buffer.byteLength(button.callback_data, 'utf8')).toBeLessThanOrEqual(MAX_CALLBACK_BYTES);
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

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

const WINNER_RESULT: AuctionResultDto = {
  auctionId: DETAIL.id,
  outcome: 'winner',
  algorithmVersion: 'LUB_V1',
  winningAmountMinor: '4700',
  currency: 'ETB',
  statistics: { totalBids: 221, totalValidBids: 218, participantCount: 37, uniqueAmountCount: 9 },
  checksum: 'a'.repeat(64),
  computedAt: '2026-09-02T00:00:05.000Z',
};

const WINNER = '99999999-9999-4999-8999-999999999999';
const LOSER = '88888888-8888-4888-8888-888888888888';

const MY_LOSS: MyAuctionOutcomeDto = {
  auctionId: DETAIL.id,
  outcome: 'winner',
  won: false,
  winningAmountMinor: '4700',
  currency: 'ETB',
  bidCount: 6,
  feesPaidMinor: '3000',
  refundedMinor: '0',
  order: null,
};

describe('the public result message', () => {
  const body = renderResult({ productTitle: 'iPhone 16 Pro', result: WINNER_RESULT });

  it('publishes the winning amount, the statistics and the checksum', () => {
    expect(body).toContain('47.00 ETB');
    expect(body).toContain('Bids placed: 218');
    expect(body).toContain('People bidding: 37');
    expect(body).toContain('Amounts nobody matched: 9');
    expect(body).toContain('LUB_V1');
    expect(body).toContain(WINNER_RESULT.checksum);
  });

  it('states the rule that produced it', () => {
    expect(body).toContain('lowest amount exactly one person bid');
  });

  /**
   * **The disclosure rule.** A result names the winning amount and nobody
   * else's. No participant list, no per-amount breakdown, no "you were close"
   * — published after the close, any of those is still advice about what to
   * avoid in the next auction, and the format only works while nobody has it.
   */
  it('names no bidder and no amount but the winning one', () => {
    expect(body).not.toContain(WINNER);
    expect(body).not.toContain(LOSER);
    for (const forbidden of [
      /\bsecond[- ]lowest\b/i,
      /\bbreakdown\b/i,
      /\bother bids?\b/i,
      /\byou were\b/i,
      /\bdistribution\b/i,
    ]) {
      expect(body).not.toMatch(forbidden);
    }
    // Exactly one money figure, and it is the winning amount.
    expect(body.match(/\d+\.\d{2} ETB/g)).toEqual(['47.00 ETB']);
  });

  it('explains a no-unique-bid auction and says the fees came back', () => {
    const body = renderResult({
      productTitle: 'iPhone 16 Pro',
      result: {
        ...WINNER_RESULT,
        outcome: 'no_unique_bid',
        winningAmountMinor: null,
        statistics: { ...WINNER_RESULT.statistics, uniqueAmountCount: 0 },
      },
    });
    expect(body).toContain('No winner');
    expect(body).toContain('two or more people');
    expect(body).toContain('returned');
    expect(body).not.toMatch(/\d+\.\d{2} ETB/);
  });

  it('says plainly when nobody bid', () => {
    const body = renderResult({
      productTitle: 'iPhone 16 Pro',
      result: {
        ...WINNER_RESULT,
        outcome: 'no_bids',
        winningAmountMinor: null,
        statistics: { totalBids: 0, totalValidBids: 0, participantCount: 0, uniqueAmountCount: 0 },
      },
    });
    expect(body).toContain('No bids');
    expect(body).toContain('without a single bid');
  });
});

describe("a bidder's own outcome", () => {
  it('tells the winner what they owe and by when', () => {
    const body = renderMyOutcome({
      ...MY_LOSS,
      won: true,
      order: {
        id: '77777777-7777-4777-8777-777777777777',
        orderNumber: 'HL-2026-000123',
        auctionId: DETAIL.id,
        status: 'pending_payment',
        currency: 'ETB',
        totalMinor: '4700',
        placedAt: '2026-09-02T00:00:05.000Z',
        paymentDueAt: '2026-09-04T00:00:05.000Z',
        paidAt: null,
      },
    });
    expect(body).toContain('You won');
    expect(body).toContain('47.00 ETB');
    expect(body).toContain('HL-2026-000123');
    expect(body).toContain('Pay by:');
  });

  /** A loser learns the winning amount and their own figures. Nothing else. */
  it('tells a loser the winning amount and their own spend, and nobody else', () => {
    const body = renderMyOutcome(MY_LOSS);
    expect(body).toContain('did not win');
    expect(body).toContain('47.00 ETB');
    expect(body).toContain('6 bids');
    expect(body).toContain('30.00 ETB');
    expect(body).not.toContain(WINNER);
    expect(body).not.toMatch(/\bwon by\b|\bwinner (is|was)\b/i);
  });

  it('reports the refund after a no-unique-bid auction', () => {
    const body = renderMyOutcome({
      ...MY_LOSS,
      outcome: 'no_unique_bid',
      winningAmountMinor: null,
      refundedMinor: '3000',
    });
    expect(body).toContain('Nobody won');
    expect(body).toContain('30.00 ETB has been returned');
  });

  /**
   * Somebody who did not take part gets no personal message at all. Inventing
   * a line would imply they had a stake in it.
   */
  it('says nothing personal to somebody who did not bid', () => {
    expect(renderMyOutcome({ ...MY_LOSS, bidCount: 0, feesPaidMinor: '0' })).toBeUndefined();
  });
});

describe('the result button', () => {
  /** A decided auction offers its result rather than a dead bid button. */
  it('replaces the bid button once a result exists', () => {
    const decided = auctionDetailKeyboard({
      auctionId: DETAIL.id,
      webUrl: 'https://howlow.example/a',
      acceptsBids: false,
      hasResult: true,
    });
    const flat = JSON.stringify(decided);
    expect(flat).toContain('See the result');
    expect(flat).toContain(`ar:${DETAIL.id}`);
    expect(flat).not.toContain('Not taking bids');
  });

  it('keeps the bid button while the auction has no result', () => {
    const live = auctionDetailKeyboard({
      auctionId: DETAIL.id,
      webUrl: 'https://howlow.example/a',
      acceptsBids: true,
    });
    const flat = JSON.stringify(live);
    expect(flat).toContain('Place a bid');
    expect(flat).not.toContain('See the result');
  });

  /** Telegram's hard limit. A uuid with a two-character prefix must fit. */
  it('fits Telegram callback budget', () => {
    expect(Buffer.byteLength(resultCallback(DETAIL.id), 'utf8')).toBeLessThanOrEqual(MAX_CALLBACK_BYTES);
  });
});
