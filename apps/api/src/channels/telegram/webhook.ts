import { webhookCallback } from 'grammy';
import { Router } from 'express';
import { TELEGRAM_SECRET_HEADER, TELEGRAM_WEBHOOK_PATH } from '@howlow/shared';
import { loadConfig } from '../../config/index.js';
import { getLogger } from '../../shared/index.js';
import { getBot } from './bot.js';

/**
 * Webhook-mode delivery. Telegram authenticates itself with the secret token
 * header; unauthenticated deliveries are dropped before reaching grammY.
 */
export function createTelegramRouter(): Router {
  const router = Router();
  const env = loadConfig();

  if (!env.TELEGRAM_ENABLED) {
    getLogger().info('Telegram channel disabled; webhook route not mounted');
    return router;
  }

  const expectedSecret = env.TELEGRAM_WEBHOOK_SECRET;
  const handle = webhookCallback(getBot(), 'express');

  router.post(TELEGRAM_WEBHOOK_PATH, (req, res, next) => {
    if (req.header(TELEGRAM_SECRET_HEADER) !== expectedSecret) {
      res.status(401).end();
      return;
    }
    void Promise.resolve(handle(req, res)).catch(next);
  });

  return router;
}
