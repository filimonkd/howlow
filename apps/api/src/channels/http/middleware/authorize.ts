import type { NextFunction, Request, Response } from 'express';
import type { Role } from '@howlow/shared';
import { assertRole } from '../../../modules/auth/index.js';
import { requireAuth } from './authenticate.js';

/**
 * Role gate. The decision itself lives in the auth module, so the website and
 * the Telegram bot reach the same answer for the same HOWLOW user; this only
 * adapts it to Express.
 */
export function authorize(...allowed: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      assertRole(requireAuth(req).roles, allowed);
      next();
    } catch (error) {
      next(error);
    }
  };
}
