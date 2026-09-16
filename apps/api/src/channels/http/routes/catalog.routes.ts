import { Router, type RequestHandler } from 'express';
import * as catalog from '../controllers/catalog.controller.js';
import * as auctions from '../controllers/auction.controller.js';

const wrap =
  (handler: (...args: Parameters<RequestHandler>) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    void handler(req, res, next).catch(next);
  };

/**
 * Public catalog and auction discovery. No authentication: these are the pages
 * a visitor sees before signing in.
 *
 * Only publicly visible auctions are reachable here — the module narrows the
 * status filter within the public set rather than trusting the query — so a
 * crafted request cannot surface a draft or a suspended listing.
 */
export const publicCatalogRoutes: Router = Router();

publicCatalogRoutes.get('/categories', wrap(catalog.listCategories));
publicCatalogRoutes.get('/categories/:slug', wrap(catalog.getCategory));
publicCatalogRoutes.get('/auctions', wrap(auctions.listAuctions));
publicCatalogRoutes.get('/auctions/:publicId', wrap(auctions.getAuction));
