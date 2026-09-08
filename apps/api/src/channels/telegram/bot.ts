import { Bot } from 'grammy';
import { loadConfig } from '../../config/index.js';
import { getLogger } from '../../shared/index.js';
import { registerHandlers } from './handlers/index.js';

/**
 * The Telegram channel adapter.
 *
 * It is a *client* of HOWLOW, exactly like the website. It owns no wallet, no
 * bidding logic and no auction state; every command it handles resolves to a
 * call into `modules/`. It may not import `db/` — the lint rules in
 * `eslint.config.js` enforce that mechanically.
 */
let bot: Bot | undefined;

export function getBot(): Bot {
  if (bot) return bot;
  const env = loadConfig();
  if (!env.TELEGRAM_ENABLED || !env.TELEGRAM_BOT_TOKEN) {
    throw new Error('Telegram channel is disabled; set TELEGRAM_ENABLED=true and TELEGRAM_BOT_TOKEN');
  }

  bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  registerHandlers(bot);

  bot.catch((error) => {
    getLogger().error({ err: error.error, updateId: error.ctx.update.update_id }, 'Telegram handler failed');
  });

  return bot;
}

export function isTelegramEnabled(): boolean {
  return loadConfig().TELEGRAM_ENABLED;
}
