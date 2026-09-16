import { Router, type RequestHandler } from 'express';
import * as catalog from '../controllers/catalog.controller.js';
import * as auctions from '../controllers/auction.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';

const wrap =
  (handler: (...args: Parameters<RequestHandler>) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    void handler(req, res, next).catch(next);
  };

/**
 * A seller's own catalog and auctions.
 *
 * The role gate here is the outer of two: every module function resolves the
 * seller from the authenticated user and asserts ownership itself, so a route
 * added later without a gate still cannot reach another seller's product.
 *
 * There is deliberately no route that sets an auction status. Submitting is its
 * own endpoint, and everything past that belongs to staff or the worker.
 */
export const sellerRoutes: Router = Router();

sellerRoutes.use(authenticate, authorize('seller'));

sellerRoutes.get('/products', wrap(catalog.listMyProducts));
sellerRoutes.post('/products', wrap(catalog.createProduct));
sellerRoutes.get('/products/:publicId', wrap(catalog.getMyProduct));
sellerRoutes.patch('/products/:publicId', wrap(catalog.updateProduct));
sellerRoutes.post('/products/:publicId/archive', wrap(catalog.archiveProduct));

sellerRoutes.post('/products/:publicId/images', wrap(catalog.createImageUploadSlot));
sellerRoutes.patch('/products/:publicId/images', wrap(catalog.reorderImages));
sellerRoutes.delete('/products/:publicId/images/:imageId', wrap(catalog.deleteImage));

sellerRoutes.get('/auctions', wrap(auctions.listMyAuctions));
sellerRoutes.post('/auctions', wrap(auctions.createAuction));
sellerRoutes.get('/auctions/:publicId', wrap(auctions.getMyAuction));
sellerRoutes.patch('/auctions/:publicId', wrap(auctions.updateAuction));
sellerRoutes.post('/auctions/:publicId/submit', wrap(auctions.submitAuction));
sellerRoutes.post('/auctions/:publicId/cancel', wrap(auctions.cancelMyAuction));
