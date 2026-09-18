import { Router, type RequestHandler } from 'express';
import * as results from '../controllers/result.controller.js';
import { authenticate } from '../middleware/authenticate.js';

const wrap =
  (handler: (...args: Parameters<RequestHandler>) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    void handler(req, res, next).catch(next);
  };

/**
 * Auction results, mounted under the public auction path.
 *
 * Its own router for the same reason bidding has one: the two routes here need
 * different authentication from each other and from the discovery routes
 * beside them. The public result is readable by anyone — it is the answer the
 * auction published — and the caller's own outcome is not.
 *
 * `authenticate` is attached per route and never with `use`, because a
 * router-level `use` would run for every path under the `/auctions` mount,
 * including the unauthenticated discovery routes that fall through this
 * router. That is not hypothetical: it is the defect a reading of the Phase 5
 * bid router caught before it shipped.
 *
 * Mount order matters. `/result` must be matched here before
 * `/auctions/:publicId` in the public catalog router can treat `result` as an
 * auction reference and answer 404 for the wrong reason.
 */
export const resultRoutes: Router = Router();

resultRoutes.get('/:publicId/result', wrap(results.getResult));
resultRoutes.get('/:publicId/result/me', authenticate, wrap(results.getMyResult));
