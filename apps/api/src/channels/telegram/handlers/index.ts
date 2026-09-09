import type { Bot, Context } from 'grammy';
import { AppError } from '@howlow/shared';
import * as auth from '../../../modules/auth/index.js';
import { getLogger } from '../../../shared/index.js';

/**
 * Telegram command handlers.
 *
 * Every one of these resolves identity and performs work by calling the auth
 * module — the same services the website calls. There is no SQL here, no
 * transaction, and no authentication rule: a bug fixed in the module is fixed
 * for both channels at once.
 *
 * Identity is always the numeric Telegram user id. The username is shown to
 * people and never used to decide who someone is.
 */
function telegramIdentity(ctx: Context): auth.TelegramIdentity | undefined {
  const from = ctx.from;
  if (!from || from.is_bot) return undefined;
  return {
    telegramUserId: String(from.id),
    username: from.username,
    firstName: from.first_name,
    lastName: from.last_name,
    languageCode: from.language_code,
  };
}

function auditContext(identity: auth.TelegramIdentity): auth.AuditContext {
  return { channel: 'telegram', userAgent: `telegram:${identity.telegramUserId}` };
}

/** Show a user-safe message; never leak internal detail into a chat. */
async function replyWithError(ctx: Context, error: unknown): Promise<void> {
  if (AppError.is(error)) {
    await ctx.reply(error.publicMessage);
    return;
  }
  getLogger().error({ err: error }, 'Telegram handler failed');
  await ctx.reply('Something went wrong. Please try again in a moment.');
}

export function registerHandlers(bot: Bot): void {
  bot.command('start', async (ctx) => {
    const identity = telegramIdentity(ctx);
    if (!identity) {
      await ctx.reply('HOWLOW cannot be used by bot accounts.');
      return;
    }

    try {
      await auth.enforceRateLimit('telegramStart', identity.telegramUserId);

      // Deep-link payload from the website: /start link_<token>
      const payload = ctx.match;
      if (typeof payload === 'string' && payload.startsWith('link_')) {
        await beginLinkConfirmation(ctx, payload.slice('link_'.length));
        return;
      }

      const existing = await auth.resolveTelegramUser(identity.telegramUserId);
      if (existing) {
        await ctx.reply(
          `Welcome back, ${existing.displayName}.\n\n` +
            'Your Telegram account is connected to HOWLOW. Use /profile to see your account.',
        );
        return;
      }

      await ctx.reply(
        'Welcome to HOWLOW.\n\n' +
          'This Telegram account is not connected to a HOWLOW account yet.\n\n' +
          'Sign in on the website and choose "Connect Telegram" — you will get a link that ' +
          'brings you back here to confirm.\n\n' +
          'Your phone number is verified once, by HOWLOW, and both the website and this bot ' +
          'then use the same account.',
      );
    } catch (error) {
      await replyWithError(ctx, error);
    }
  });

  /**
   * Confirmation step for a website-initiated link. The token is carried in the
   * callback data, never re-typed by the user.
   */
  bot.callbackQuery(/^link:confirm:(.+)$/, async (ctx) => {
    const identity = telegramIdentity(ctx);
    const token = ctx.match?.[1];
    if (!identity || token === undefined) {
      await ctx.answerCallbackQuery({ text: 'That confirmation is no longer valid.' });
      return;
    }

    try {
      const user = await auth.confirmLink({ token, identity }, auditContext(identity));
      await ctx.answerCallbackQuery({ text: 'Connected.' });
      await ctx.editMessageText(
        `Connected to HOWLOW as ${user.displayName}.\n\n` +
          'This Telegram account and the website now share one HOWLOW account, ' +
          'one wallet and one bidding history.',
      );
    } catch (error) {
      await ctx.answerCallbackQuery({ text: 'Could not connect.' });
      await replyWithError(ctx, error);
    }
  });

  bot.callbackQuery('link:cancel', async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Cancelled.' });
    await ctx.editMessageText('Cancelled. Nothing was connected.');
  });

  bot.command('profile', async (ctx) => {
    const identity = telegramIdentity(ctx);
    if (!identity) return;

    try {
      const user = await auth.resolveTelegramUser(identity.telegramUserId);
      if (!user) {
        await ctx.reply('This Telegram account is not connected to HOWLOW yet. Use /start to begin.');
        return;
      }
      await ctx.reply(
        `${user.displayName}\n` +
          `Phone: ${user.phone ?? 'not set'}\n` +
          `Status: ${user.status}\n` +
          `Roles: ${user.roles.join(', ')}`,
      );
    } catch (error) {
      await replyWithError(ctx, error);
    }
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      'HOWLOW commands:\n' +
        '/start — connect or recognise your account\n' +
        '/profile — your HOWLOW account\n' +
        '/help — this message',
    );
  });
}

/** Ask the user to confirm before anything is linked. */
async function beginLinkConfirmation(ctx: Context, token: string): Promise<void> {
  await ctx.reply('Connect this Telegram account to your HOWLOW account?', {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Confirm', callback_data: `link:confirm:${token}` },
          { text: 'Cancel', callback_data: 'link:cancel' },
        ],
      ],
    },
  });
}
