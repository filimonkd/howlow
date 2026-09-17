import { Router, type RequestHandler } from 'express';
import * as bids from '../controllers/bid.controller.js';
import { authenticate } from '../middleware/authenticate.js';

const wrap =
  (handler: (...args: Parameters<RequestHandler>) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    void handler(req, res, next).catch(next);
  };

/**
 * Bidding, mounted under the public auction path.
 *
 * Its own router rather than a pair of lines in the public catalog routes,
 * because these two need `authenticate` and the discovery routes beside them
 * must not have it. Mounting it before the public router means
 * `/auctions/:publicId/bids` is matched here and never falls through to the
 * unauthenticated `/auctions/:publicId`.
 *
 * Rate limiting is applied inside the engine rather than as middleware here:
 * three of the four limits are keyed by the auction, which is not known until
 * the reference has been resolved, and applying them in the service means the
 * Telegram channel gets exactly the same limits without a second copy.
 */
export const bidRoutes: Router = Router();

// `authenticate` is attached per route, never with `use`. A router-level
// `use(authenticate)` would run for every path under the `/auctions` mount —
// including the unauthenticated discovery routes that fall through this
// router — and public auction browsing would start answering 401.
bidRoutes.post('/:publicId/bids', authenticate, wrap(bids.submitBids));
bidRoutes.get('/:publicId/bids', authenticate, wrap(bids.listMyBids));
