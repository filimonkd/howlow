import { Router, type RequestHandler } from 'express';
import * as controller from '../controllers/me.controller.js';
import { authenticate } from '../middleware/authenticate.js';

const wrap =
  (handler: (...args: Parameters<RequestHandler>) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    void handler(req, res, next).catch(next);
  };

export const meRoutes: Router = Router();

// Everything under /me requires an authenticated caller.
meRoutes.use(authenticate);

meRoutes.get('/', wrap(controller.getMe));
meRoutes.post('/telegram/link', wrap(controller.createTelegramLink));
meRoutes.get('/telegram/status', wrap(controller.getTelegramStatus));
meRoutes.delete('/telegram', wrap(controller.unlinkTelegram));
