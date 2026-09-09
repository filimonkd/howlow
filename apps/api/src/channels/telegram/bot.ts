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

/**
 * Fetch the bot's own identity at startup.
 *
 * grammY does this lazily on the first update otherwise, which means a wrong or
 * unreachable token shows up as a webhook request that never completes — a
 * confusing failure that Telegram sees as a timeout and retries. Doing it at
 * boot turns the same problem into one clear log line.
 *
 * Failure is logged, not fatal: the website must keep working when Telegram is
 * unreachable, and the channel recovers on its own once the API responds.
 */
export async function initTelegram(timeoutMs = 10_000): Promise<boolean> {
  if (!isTelegramEnabled()) return false;

  const logger = getLogger();
  try {
    await Promise.race([
      getBot().init(),
      new Promise((_resolve, reject) =>
        setTimeout(() => {
          reject(new Error(`Telegram getMe did not respond within ${String(timeoutMs)}ms`));
        }, timeoutMs).unref(),
      ),
    ]);
    logger.info({ botUsername: getBot().botInfo.username }, 'Telegram channel ready');
    return true;
  } catch (error) {
    logger.error(
      { err: error },
      'Telegram channel could not reach the Bot API; webhook updates will retry initialisation',
    );
    return false;
  }
}
