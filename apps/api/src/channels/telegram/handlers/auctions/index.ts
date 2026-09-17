import type { Bot, Context } from 'grammy';
import { acceptsBids, AppError } from '@howlow/shared';
import { loadConfig } from '../../../../config/index.js';
import * as auctions from '../../../../modules/auctions/index.js';
import { getLogger } from '../../../../shared/index.js';
import { auctionDetailKeyboard, auctionListKeyboard, CALLBACK } from '../../keyboards/auctions.js';
import { renderDetail, renderSummary } from '../../render/auctions.js';

/**
 * Telegram auction browsing.
 *
 * Every handler resolves data by calling the **same auction module the website
 * calls** — there is no SQL here, no transaction, and no visibility rule of its
 * own. `getPublicAuction` is what refuses a draft, so the bot cannot show one
 * even if a callback payload names it.
 *
 * Browsing only. The bid button on the detail keyboard is handled by
 * `handlers/bidding`, which sequences the confirmation flow and calls the
 * one bidding engine — there is no second path from a chat to a bid.
 */
const PAGE_SIZE = 5;

/** The public page for an auction, so a reader can move to the full experience. */
function webUrl(auction: { id: string; slug: string | null }): string {
  const base = loadConfig().WEB_ORIGIN.replace(/\/+$/, '');
  return `${base}/auctions/${auction.slug ?? auction.id}`;
}

async function replyWithError(ctx: Context, error: unknown): Promise<void> {
  if (AppError.is(error)) {
    await ctx.reply(error.publicMessage);
    return;
  }
  getLogger().error({ err: error }, 'Telegram auction handler failed');
  await ctx.reply('Something went wrong. Please try again in a moment.');
}

/** A page of live-and-upcoming auctions. */
async function sendAuctionList(ctx: Context, cursor: string | undefined): Promise<void> {
  const page = await auctions.listPublicAuctions({
    sort: 'ending_soon',
    limit: PAGE_SIZE,
    ...(cursor === undefined ? {} : { cursor }),
  });

  if (page.auctions.length === 0) {
    await ctx.reply(
      'There are no auctions open right now.\n\n' + 'New auctions are announced here as they are scheduled.',
    );
    return;
  }

  const summaries = await Promise.all(
    page.auctions.map(async (auction) =>
      auctions.toSummaryDto(auction, await auctions.imagesForAuction(auction)),
    ),
  );

  const body = ['🔥 *HOWLOW auctions*', '', ...summaries.map(renderSummary)].join('\n\n');
  const keyboard = auctionListKeyboard({
    auctions: summaries,
    nextCursor: page.nextCursor,
  });

  await ctx.reply(body, { parse_mode: 'Markdown', reply_markup: keyboard });
}

/** One auction in full. */
async function sendAuctionDetail(ctx: Context, auctionId: string): Promise<void> {
  // The public read, so a draft or suspended auction is refused even if its id
  // arrives in a callback payload.
  const auction = await auctions.getPublicAuction(auctionId);
  const images = await auctions.imagesForAuction(auction);
  const detail = auctions.toDetailDto(auction, images);
  const url = webUrl(auction);

  await ctx.reply(renderDetail(detail, url), {
    parse_mode: 'Markdown',
    link_preview_options: { is_disabled: true },
    reply_markup: auctionDetailKeyboard({
      auctionId: auction.id,
      webUrl: url,
      acceptsBids: acceptsBids(auction.status),
    }),
  });
}

export function registerAuctionHandlers(bot: Bot): void {
  bot.command('auctions', async (ctx) => {
    try {
      await sendAuctionList(ctx, undefined);
    } catch (error) {
      await replyWithError(ctx, error);
    }
  });

  /**
   * Open one auction from the list.
   *
   * The payload carries only an id. It is treated as a request, not a fact:
   * the module re-resolves the auction and applies the public visibility rule.
   */
  bot.callbackQuery(new RegExp(`^${CALLBACK.auction}:(.+)$`), async (ctx) => {
    const auctionId = ctx.match?.[1];
    if (auctionId === undefined) {
      await ctx.answerCallbackQuery({ text: 'That auction is no longer available.' });
      return;
    }
    try {
      await ctx.answerCallbackQuery();
      await sendAuctionDetail(ctx, auctionId);
    } catch (error) {
      await replyWithError(ctx, error);
    }
  });

  /** Another page, or back to the first one when the payload carries `0`. */
  bot.callbackQuery(new RegExp(`^${CALLBACK.auctionList}:(.+)$`), async (ctx) => {
    const cursor = ctx.match?.[1];
    try {
      await ctx.answerCallbackQuery();
      await sendAuctionList(ctx, cursor === '0' || cursor === undefined ? undefined : cursor);
    } catch (error) {
      await replyWithError(ctx, error);
    }
  });
}
