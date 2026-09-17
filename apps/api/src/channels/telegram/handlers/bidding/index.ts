import { randomUUID } from 'node:crypto';
import type { Bot, Context } from 'grammy';
import { AppError, acceptsBids, parseAmountList } from '@howlow/shared';
import * as auctions from '../../../../modules/auctions/index.js';
import * as auth from '../../../../modules/auth/index.js';
import * as bidding from '../../../../modules/bidding/index.js';
import * as wallet from '../../../../modules/wallet/index.js';
import { dropDraft, getDraft, getLogger, putDraft } from '../../../../shared/index.js';
import { bidConfirmKeyboard, bidResultKeyboard, CALLBACK } from '../../keyboards/auctions.js';
import { renderBidConfirmation, renderBidPrompt, renderBidResult } from '../../render/auctions.js';

/**
 * Telegram bidding.
 *
 * Three updates from Telegram make one submission: the button that starts it,
 * the message carrying the amounts, and the button that confirms. This file
 * sequences those three and **nothing else**. It writes no SQL, touches no
 * wallet, counts no bids and enforces no auction rule; every one of those
 * belongs to `bidService.submitBids()`, which is the same function the website
 * calls. If the two channels ever disagreed about whether a bid was valid, one
 * of them would be wrong about someone's money.
 *
 * ## What the handler is allowed to know
 *
 * The figures it renders — the ladder, the fee, the balance, the bids
 * remaining — are read for display only. None of them is checked here: the
 * engine re-reads all of it under the auction lock, so a draft built from
 * stale numbers produces a request that is refused on its merits rather than a
 * bid accepted on bad ones.
 *
 * ## Identity
 *
 * Always the numeric Telegram user id, resolved to a HOWLOW account through
 * the auth module. A callback payload is never treated as proof of who is
 * asking — Telegram delivers whatever the client sends.
 */

const DRAFT_NAMESPACE = 'bid';

/**
 * A pending submission.
 *
 * The idempotency key is minted when the confirmation is *shown*, not when
 * Confirm is pressed. Tapping Confirm twice — which people do — then replays
 * the first submission instead of paying for a second one.
 */
interface BidDraft {
  readonly auctionId: string;
  readonly amountsMinor: readonly string[];
  readonly idempotencyKey: string;
}

function telegramUserId(ctx: Context): string | undefined {
  const from = ctx.from;
  if (!from || from.is_bot) return undefined;
  return String(from.id);
}

/** The HOWLOW account behind this chat, or a message explaining there is none. */
async function requireAccount(ctx: Context): Promise<{ userId: string; subject: string } | undefined> {
  const subject = telegramUserId(ctx);
  if (subject === undefined) {
    await ctx.reply('HOWLOW cannot be used by bot accounts.');
    return undefined;
  }
  const user = await auth.resolveTelegramUser(subject);
  if (!user) {
    await ctx.reply(
      'This Telegram account is not connected to HOWLOW yet.\n\n' +
        'Use /start to connect it, then you can bid from here.',
    );
    return undefined;
  }
  return { userId: user.id, subject };
}

/**
 * Show a refusal in the bidder's own terms.
 *
 * Every engine refusal carries a stable `bidError`, so the wording lives here
 * and the rule lives in the module. A failure without one is logged and
 * answered generically: a chat message must never carry a constraint name or a
 * stack trace.
 */
async function replyWithError(ctx: Context, error: unknown): Promise<void> {
  if (AppError.is(error)) {
    await ctx.reply(error.publicMessage);
    return;
  }
  getLogger().error({ err: error }, 'Telegram bidding handler failed');
  await ctx.reply('Something went wrong. Your bids were not submitted. Please try again.');
}

// ---------------------------------------------------------------------------
// Step 1 — the prompt
// ---------------------------------------------------------------------------

/**
 * "Place a bid" pressed.
 *
 * Re-resolves the auction rather than trusting the payload, and re-checks that
 * it is taking bids: the message the button came from may have been sent
 * before the auction closed.
 */
async function beginBid(ctx: Context, auctionId: string): Promise<void> {
  const account = await requireAccount(ctx);
  if (!account) return;

  const auction = await auctions.getPublicAuction(auctionId);
  if (!acceptsBids(auction.status)) {
    await ctx.reply('This auction is not taking bids.');
    return;
  }

  const [allowance, account_] = await Promise.all([
    bidding.getAllowance({ userId: account.userId, auctionId: auction.id }),
    wallet.getWallet(account.userId, auction.currency),
  ]);

  if (allowance.bidsRemaining === 0) {
    await ctx.reply(`You have used all ${String(allowance.maxBidsPerUser)} of your bids on this auction.`);
    return;
  }

  // The draft holds only the auction until the amounts arrive. Stored now so
  // the next plain message in this chat can be read as an answer to it.
  await putDraft(DRAFT_NAMESPACE, account.subject, {
    auctionId: auction.id,
    amountsMinor: [],
    idempotencyKey: '',
  } satisfies BidDraft);

  const detail = auctions.toDetailDto(auction, []);
  await ctx.reply(
    renderBidPrompt({
      auction: detail,
      bidsRemaining: allowance.bidsRemaining,
      walletBalanceMinor: account_.availableMinor.toString(),
    }),
    { parse_mode: 'Markdown' },
  );
}

// ---------------------------------------------------------------------------
// Step 2 — the amounts
// ---------------------------------------------------------------------------

/**
 * A plain message while a draft is open.
 *
 * Returns false when there is no draft, so the message is not this handler's
 * business and the bot's other handlers see it untouched.
 *
 * Formatting is checked here — "3.5" is not a whole number of anything — but
 * the *rules* are not: whether an amount is on the ladder is the engine's
 * decision, applied against the locked auction row. What this does is turn a
 * typo into a sentence the user can act on instead of a refusal after the
 * confirmation.
 */
async function collectAmounts(ctx: Context, text: string): Promise<boolean> {
  const subject = telegramUserId(ctx);
  if (subject === undefined) return false;

  const draft = await getDraft<BidDraft>(DRAFT_NAMESPACE, subject);
  if (!draft) return false;

  const parsed = parseAmountList(text);
  if ('error' in parsed) {
    await ctx.reply(`${parsed.error}\n\nSend your amounts as whole numbers, like \`1 3 7 11\`.`, {
      parse_mode: 'Markdown',
    });
    return true;
  }

  const account = await requireAccount(ctx);
  if (!account) return true;

  const auction = await auctions.getPublicAuction(draft.auctionId);
  if (!acceptsBids(auction.status)) {
    await dropDraft(DRAFT_NAMESPACE, subject);
    await ctx.reply('This auction stopped taking bids while you were typing.');
    return true;
  }

  // Validated for shape only, so an obviously wrong ladder is caught before
  // the user is asked to confirm it. The engine checks all of this again.
  try {
    const amounts = bidding.parseAmounts(parsed.amounts);
    bidding.assertNoRepeats(amounts);
    bidding.assertAmountsAllowed(amounts, auction);
  } catch (error) {
    await replyWithError(ctx, error);
    return true;
  }

  const [allowance, walletAccount] = await Promise.all([
    bidding.getAllowance({ userId: account.userId, auctionId: auction.id }),
    wallet.getWallet(account.userId, auction.currency),
  ]);

  if (parsed.amounts.length > allowance.bidsRemaining) {
    await ctx.reply(
      `That is ${String(parsed.amounts.length)} bids, and you have ` +
        `${String(allowance.bidsRemaining)} left on this auction.`,
    );
    return true;
  }

  const totalFee = auction.bidFeeMinor * BigInt(parsed.amounts.length);

  // The key is minted here, with the confirmation the user is about to see.
  await putDraft(DRAFT_NAMESPACE, subject, {
    auctionId: auction.id,
    amountsMinor: parsed.amounts,
    idempotencyKey: randomUUID(),
  } satisfies BidDraft);

  const detail = auctions.toDetailDto(auction, []);
  await ctx.reply(
    renderBidConfirmation({
      auction: detail,
      amountsMinor: parsed.amounts,
      totalFeeMinor: totalFee.toString(),
      walletBalanceMinor: walletAccount.availableMinor.toString(),
    }),
    { parse_mode: 'Markdown', reply_markup: bidConfirmKeyboard() },
  );
  return true;
}

// ---------------------------------------------------------------------------
// Step 3 — the submission
// ---------------------------------------------------------------------------

/**
 * Confirm pressed: the one call that places bids.
 *
 * The payload is the bare verb `bc`. The auction, the amounts and the key come
 * from the server's own draft, so a crafted callback cannot submit amounts the
 * user never saw, and a replayed one cannot aim at a different auction.
 *
 * The draft is dropped **after** the engine answers, not before. If the call
 * fails for a reason the user can fix — not enough in the wallet, say — the
 * draft is gone and they retype; what must not happen is the draft surviving a
 * success and a later tap re-submitting under a fresh key.
 */
async function confirmBid(ctx: Context): Promise<void> {
  const account = await requireAccount(ctx);
  if (!account) return;

  const draft = await getDraft<BidDraft>(DRAFT_NAMESPACE, account.subject);
  if (!draft || draft.amountsMinor.length === 0 || draft.idempotencyKey === '') {
    await ctx.reply('That bid has expired. Open the auction and start again.');
    return;
  }

  const outcome = await bidding.submitBids(
    {
      userId: account.userId,
      auctionReference: draft.auctionId,
      amountsMinor: draft.amountsMinor,
      idempotencyKey: draft.idempotencyKey,
      // Provenance only. Nothing in the engine reads it.
      channel: 'telegram',
      deviceHash: `tg-${account.subject}`.padEnd(16, '0'),
    },
    { channel: 'telegram', userAgent: `telegram:${account.subject}` },
  );

  await dropDraft(DRAFT_NAMESPACE, account.subject);

  const auction = await auctions.getPublicAuction(outcome.auctionId);
  await ctx.reply(
    renderBidResult({
      productTitle: auction.productTitle,
      amountsMinor: outcome.bids.map((bid) => bid.amountMinor.toString()),
      currency: outcome.currency,
      totalFeeMinor: outcome.totalFeeMinor.toString(),
      walletBalanceMinor: outcome.walletBalanceMinor.toString(),
      bidsRemaining: outcome.bidsRemaining,
      replayed: outcome.replayed,
    }),
    { parse_mode: 'Markdown', reply_markup: bidResultKeyboard(outcome.auctionId) },
  );
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerBiddingHandlers(bot: Bot): void {
  /** "Place a bid" on the auction detail keyboard. */
  bot.callbackQuery(new RegExp(`^${CALLBACK.auctionBid}:(.+)$`), async (ctx) => {
    const auctionId = ctx.match?.[1];
    if (auctionId === undefined) {
      await ctx.answerCallbackQuery({ text: 'That auction is no longer available.' });
      return;
    }
    try {
      await ctx.answerCallbackQuery();
      await beginBid(ctx, auctionId);
    } catch (error) {
      await replyWithError(ctx, error);
    }
  });

  bot.callbackQuery(CALLBACK.bidConfirm, async (ctx) => {
    try {
      await ctx.answerCallbackQuery();
      await confirmBid(ctx);
    } catch (error) {
      await replyWithError(ctx, error);
    }
  });

  bot.callbackQuery(CALLBACK.bidCancel, async (ctx) => {
    const subject = telegramUserId(ctx);
    if (subject !== undefined) await dropDraft(DRAFT_NAMESPACE, subject);
    await ctx.answerCallbackQuery({ text: 'Cancelled.' });
    await ctx.reply('Cancelled. Nothing was submitted and nothing was charged.');
  });

  /**
   * Amounts arrive as an ordinary message, so this listens to text and hands
   * back anything that is not an answer to an open draft.
   *
   * Registered on `message:text` and explicitly skipping commands: a user who
   * types /wallet mid-draft means /wallet, not a bid.
   */
  bot.on('message:text', async (ctx, next) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) {
      await next();
      return;
    }
    try {
      const handled = await collectAmounts(ctx, text);
      if (!handled) await next();
    } catch (error) {
      await replyWithError(ctx, error);
    }
  });
}
