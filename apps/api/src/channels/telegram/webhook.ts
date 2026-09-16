import { webhookCallback } from 'grammy';
import express, { Router } from 'express';
import { TELEGRAM_SECRET_HEADER, TELEGRAM_WEBHOOK_PATH } from '@howlow/shared';
import { loadConfig } from '../../config/index.js';
import { getLogger } from '../../shared/index.js';
import { getBot } from './bot.js';

/**
 * Webhook-mode delivery. Telegram authenticates itself with the secret token
 * header; unauthenticated deliveries are dropped before reaching grammY.
 *
 * ## The body parser
 *
 * grammY's express adapter reads the update from `req.body`, so a JSON parser
 * must have run before it. The router is mounted ahead of the app's global
 * `express.json()` (Telegram posts before any other route should be
 * considered), so it carries its own parser here — scoped to this one path,
 * which keeps the ordering explicit and independent of where the router ends
 * up being mounted.
 *
 * Without it every real delivery threw "Cannot read properties of undefined
 * (reading 'update_id')", which Telegram sees as a failure and retries. It
 * went unnoticed until a smoke test posted a real update at the real route.
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

  router.post(TELEGRAM_WEBHOOK_PATH, express.json({ limit: '1mb' }), (req, res, next) => {
    if (req.header(TELEGRAM_SECRET_HEADER) !== expectedSecret) {
      res.status(401).end();
      return;
    }
    void Promise.resolve(handle(req, res)).catch(next);
  });

  return router;
}
