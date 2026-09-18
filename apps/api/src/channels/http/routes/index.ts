import { Router } from 'express';
import { AUCTION_ALGORITHM_VERSION } from '@howlow/shared';
import { adminRoutes } from './admin.routes.js';
import { authRoutes } from './auth.routes.js';
import { bidRoutes } from './bid.routes.js';
import { publicCatalogRoutes } from './catalog.routes.js';
import { sellerRoutes } from './seller.routes.js';
import { healthRoutes } from './health.routes.js';
import { meRoutes } from './me.routes.js';
import { resultRoutes } from './result.routes.js';

/**
 * The website's single API surface. Each router delegates straight into the
 * same application services the Telegram channel uses; later phases add orders
 * alongside these.
 */
export function createApiRouter(): Router {
  const router = Router();

  router.use('/health', healthRoutes);
  router.use('/auth', authRoutes);
  router.use('/me', meRoutes);
  router.use('/seller', sellerRoutes);
  router.use('/admin', adminRoutes);
  // Bidding is mounted before public discovery so `/auctions/:publicId/bids`
  // is matched by the authenticated router and never falls through to the
  // unauthenticated `/auctions/:publicId`.
  router.use('/auctions', bidRoutes);
  // Results likewise: `/auctions/:publicId/result` has to be matched here
  // before public discovery can read `result` as an auction reference.
  router.use('/auctions', resultRoutes);
  // Public discovery is mounted last so a named route above always wins.
  router.use('/', publicCatalogRoutes);

  router.get('/meta', (_req, res) => {
    res.json({ auctionAlgorithm: AUCTION_ALGORITHM_VERSION });
  });

  return router;
}
