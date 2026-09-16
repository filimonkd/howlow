import { Router } from 'express';
import { AUCTION_ALGORITHM_VERSION } from '@howlow/shared';
import { adminRoutes } from './admin.routes.js';
import { authRoutes } from './auth.routes.js';
import { publicCatalogRoutes } from './catalog.routes.js';
import { sellerRoutes } from './seller.routes.js';
import { healthRoutes } from './health.routes.js';
import { meRoutes } from './me.routes.js';

/**
 * The website's single API surface. Each router delegates straight into the
 * same application services the Telegram channel uses; later phases add bids
 * and orders alongside these.
 */
export function createApiRouter(): Router {
  const router = Router();

  router.use('/health', healthRoutes);
  router.use('/auth', authRoutes);
  router.use('/me', meRoutes);
  router.use('/seller', sellerRoutes);
  router.use('/admin', adminRoutes);
  // Public discovery is mounted last so a named route above always wins.
  router.use('/', publicCatalogRoutes);

  router.get('/meta', (_req, res) => {
    res.json({ auctionAlgorithm: AUCTION_ALGORITHM_VERSION });
  });

  return router;
}
