import { Router, type RequestHandler } from 'express';
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

adminRoutes.post(
  '/wallets/:publicId/credit',
  authorize('finance', 'admin'),
  wrap(wallet.adminCredit),
);
adminRoutes.post(
  '/wallets/:publicId/debit',
  authorize('finance', 'admin'),
  wrap(wallet.adminDebit),
);
adminRoutes.post('/wallets/:publicId/freeze', authorize('finance', 'admin'), wrap(wallet.freeze));
adminRoutes.post(
  '/wallets/:publicId/unfreeze',
  authorize('finance', 'admin'),
  wrap(wallet.unfreeze),
);

// Reading a reconciliation report changes nothing, so support agents may see
// one while investigating; only finance may act on it.
adminRoutes.get(
  '/wallets/:publicId/reconciliation',
  authorize('finance', 'support_agent', 'admin'),
  wrap(wallet.getReconciliation),
);
