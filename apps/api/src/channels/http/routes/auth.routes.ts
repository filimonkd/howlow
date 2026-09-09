import { Router, type RequestHandler } from 'express';
import * as controller from '../controllers/auth.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { rateLimitByIp } from '../middleware/rate-limit.js';

/** Adapt an async controller to Express's error channel. */
const wrap =
  (handler: (...args: Parameters<RequestHandler>) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    void handler(req, res, next).catch(next);
  };

export const authRoutes: Router = Router();

authRoutes.post('/register', rateLimitByIp('register'), wrap(controller.register));
authRoutes.post('/verify-phone', rateLimitByIp('otpVerify'), wrap(controller.verifyPhone));
authRoutes.post('/login', rateLimitByIp('login'), wrap(controller.login));
authRoutes.post('/refresh', rateLimitByIp('refresh'), wrap(controller.refresh));
authRoutes.post('/logout', wrap(controller.logout));
authRoutes.post(
  '/request-password-reset',
  rateLimitByIp('passwordReset'),
  wrap(controller.requestPasswordReset),
);
authRoutes.post('/reset-password', rateLimitByIp('otpVerify'), wrap(controller.resetPassword));
authRoutes.post('/change-password', authenticate, wrap(controller.changePassword));
