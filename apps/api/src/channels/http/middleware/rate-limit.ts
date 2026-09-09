import type { NextFunction, Request, Response } from 'express';
import { enforceRateLimit, type RateLimitName } from '../../../modules/auth/index.js';

/**
 * Per-IP rate limiting for unauthenticated routes. Limits keyed to the account
 * itself are applied inside the services, where the account is known.
 */
export function rateLimitByIp(name: RateLimitName) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    void enforceRateLimit(name, req.ip ?? 'unknown').then(
      () => {
        next();
      },
      (error: unknown) => {
        next(error);
      },
    );
  };
}
