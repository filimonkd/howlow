import type { Bot } from 'grammy';

/**
 * Command handlers. Phase 8 fills these in; each one calls an application
 * service and formats the reply. No SQL, no transactions, no business rules
 * may appear in this directory.
 */
export function registerHandlers(bot: Bot): void {
  bot.command('start', async (ctx) => {
    await ctx.reply('HOWLOW is warming up. Bidding opens in a later phase.');
  });
}
