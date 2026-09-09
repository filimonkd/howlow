import type { NextFunction, Request, Response } from 'express';
import { AppError, type Role } from '@howlow/shared';
import { isSessionActive, verifyAccessToken } from '../../../modules/auth/index.js';

/**
 * Resolve the caller from a Bearer access token.
 *
 * The token's signature is not enough on its own: the session it names must
 * still be live, so logout, a password change and refresh-token reuse take
 * effect immediately rather than waiting for the access token to expire.
 */
declare module 'express-serve-static-core' {
  interface Request {
    auth?: {
      userId: string;
      sessionId: string;
      roles: readonly Role[];
    };
  }
}

function bearerToken(req: Request): string | undefined {
  const header = req.header('authorization');
  if (header === undefined) return undefined;
  const [scheme, value] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || value === undefined || value === '') return undefined;
  return value;
}

export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const token = bearerToken(req);
  if (token === undefined) {
    next(
      new AppError({
        code: 'UNAUTHENTICATED',
        message: 'Missing bearer token',
        publicMessage: 'Please sign in.',
      }),
    );
    return;
  }

  void (async () => {
    const claims = await verifyAccessToken(token);
    if (!(await isSessionActive(claims.sid))) {
      throw new AppError({
        code: 'UNAUTHENTICATED',
        message: 'Session is revoked or expired',
        publicMessage: 'Your session has ended. Please sign in again.',
      });
    }
    req.auth = {
      userId: claims.sub,
      sessionId: claims.sid,
      roles: (claims.roles ?? []) as readonly Role[],
    };
  })().then(
    () => {
      next();
    },
    (error: unknown) => {
      next(error);
    },
  );
}

/** The authenticated caller, or a 401 if the route was not protected. */
export function requireAuth(req: Request): { userId: string; sessionId: string; roles: readonly Role[] } {
  if (!req.auth) {
    throw new AppError({ code: 'UNAUTHENTICATED', message: 'Route is missing authenticate()' });
  }
  return req.auth;
}
