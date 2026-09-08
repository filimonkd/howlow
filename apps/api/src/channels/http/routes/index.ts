import { Router } from 'express';
import { AUCTION_ALGORITHM_VERSION } from '@howlow/shared';
import { healthRoutes } from './health.routes.js';

/**
 * The website's single API surface. Later phases mount module routers here
 * (auth, wallet, catalog, auctions, bids, orders); each one delegates straight
 * into the same application services the Telegram channel uses.
 */
export function createApiRouter(): Router {
  const router = Router();

  router.use('/health', healthRoutes);

  router.get('/meta', (_req, res) => {
    res.json({ auctionAlgorithm: AUCTION_ALGORITHM_VERSION });
  });

  return router;
}
