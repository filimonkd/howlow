import { Router, type RequestHandler } from 'express';
import * as auctions from '../controllers/auction.controller.js';
import * as catalog from '../controllers/catalog.controller.js';
import * as wallet from '../controllers/wallet.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';

const wrap =
  (handler: (...args: Parameters<RequestHandler>) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    void handler(req, res, next).catch(next);
  };

/**
 * Finance and support operations.
 *
 * The role gate here is the outer of two: the wallet module asserts the
 * actor's role again for every operation, so a route added later without a
 * gate still cannot adjust someone's balance.
 */
export const adminRoutes: Router = Router();

adminRoutes.use(authenticate);

adminRoutes.post('/wallets/:publicId/credit', authorize('finance', 'admin'), wrap(wallet.adminCredit));
adminRoutes.post('/wallets/:publicId/debit', authorize('finance', 'admin'), wrap(wallet.adminDebit));
adminRoutes.post('/wallets/:publicId/freeze', authorize('finance', 'admin'), wrap(wallet.freeze));
adminRoutes.post('/wallets/:publicId/unfreeze', authorize('finance', 'admin'), wrap(wallet.unfreeze));

// Reading a reconciliation report changes nothing, so support agents may see
// one while investigating; only finance may act on it.
adminRoutes.get(
  '/wallets/:publicId/reconciliation',
  authorize('finance', 'support_agent', 'admin'),
  wrap(wallet.getReconciliation),
);

// ── Auction review ────────────────────────────────────────────────────────────
//
// Every operation is a named transition, never a status assignment: there is no
// request shape that can move an auction to an arbitrary state.
adminRoutes.get(
  '/auctions/pending',
  authorize('auction_manager', 'admin'),
  wrap(auctions.listPendingAuctions),
);
adminRoutes.get(
  '/auctions/:publicId',
  authorize('auction_manager', 'support_agent', 'admin'),
  wrap(auctions.getAuctionForStaff),
);
adminRoutes.post(
  '/auctions/:publicId/approve',
  authorize('auction_manager', 'admin'),
  wrap(auctions.approveAuction),
);
adminRoutes.post(
  '/auctions/:publicId/reject',
  authorize('auction_manager', 'admin'),
  wrap(auctions.rejectAuction),
);
adminRoutes.post(
  '/auctions/:publicId/suspend',
  authorize('auction_manager', 'admin'),
  wrap(auctions.suspendAuction),
);
adminRoutes.post(
  '/auctions/:publicId/resume',
  authorize('auction_manager', 'admin'),
  wrap(auctions.resumeAuction),
);
adminRoutes.post(
  '/auctions/:publicId/cancel',
  authorize('auction_manager', 'admin'),
  wrap(auctions.cancelAuction),
);

// ── Catalog administration ────────────────────────────────────────────────────
adminRoutes.get('/categories', authorize('auction_manager', 'admin'), wrap(catalog.listAllCategories));
adminRoutes.post('/categories', authorize('auction_manager', 'admin'), wrap(catalog.createCategory));
adminRoutes.patch(
  '/categories/:publicId',
  authorize('auction_manager', 'admin'),
  wrap(catalog.updateCategory),
);
adminRoutes.get(
  '/products',
  authorize('auction_manager', 'support_agent', 'admin'),
  wrap(catalog.listAllProducts),
);
adminRoutes.post(
  '/sellers/:publicId/status',
  authorize('auction_manager', 'admin'),
  wrap(catalog.setSellerStatus),
);
