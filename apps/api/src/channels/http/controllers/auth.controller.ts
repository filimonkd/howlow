import type { Request, Response } from 'express';
import {
  changePasswordSchema,
  loginRequestSchema,
  logoutRequestSchema,
  refreshRequestSchema,
  registerRequestSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
  verifyPhoneRequestSchema,
  AppError,
  REQUEST_ID_HEADER,
} from '@howlow/shared';
import * as auth from '../../../modules/auth/index.js';
import { requireAuth } from '../middleware/authenticate.js';

/**
 * Controllers translate HTTP into a service call and back. No business rules,
 * no SQL, no transactions — the Telegram channel calls the same services with
 * the same arguments.
 */
function auditContext(req: Request): auth.AuditContext {
  const requestId = req.res?.getHeader(REQUEST_ID_HEADER);
  return {
    channel: 'web',
    ipAddress: req.ip,
    userAgent: req.header('user-agent'),
    requestId: typeof requestId === 'string' ? requestId : undefined,
  };
}

/** Reject a malformed body with the shared validation error, not a stack trace. */
function parse<T>(
  schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: unknown } },
  body: unknown,
): T {
  const result = schema.safeParse(body);
  if (!result.success || result.data === undefined) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'Request body failed validation',
      publicMessage: 'Some of the details you entered are not valid.',
      details: { issues: result.error },
    });
  }
  return result.data;
}

export async function register(req: Request, res: Response): Promise<void> {
  const body = parse(registerRequestSchema, req.body);
  const result = await auth.register(body, auditContext(req));
  res.status(202).json(result);
}

export async function verifyPhone(req: Request, res: Response): Promise<void> {
  const body = parse(verifyPhoneRequestSchema, req.body);
  const { user, session } = await auth.verifyPhone({ ...body, channel: 'web' }, auditContext(req));
  res.status(200).json({ user, tokens: session.tokens });
}

export async function login(req: Request, res: Response): Promise<void> {
  const body = parse(loginRequestSchema, req.body);
  const result = await auth.login({ ...body, channel: 'web' }, auditContext(req));

  if ('otpSent' in result) {
    res.status(202).json(result);
    return;
  }
  res.status(200).json({ user: result.user, tokens: result.session.tokens });
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const body = parse(refreshRequestSchema, req.body);
  const session = await auth.rotateSession(body.refreshToken, auditContext(req));
  res.status(200).json({ tokens: session.tokens });
}

export async function logout(req: Request, res: Response): Promise<void> {
  const body = parse(logoutRequestSchema, req.body ?? {});
  if (body.allSessions) {
    const { userId } = requireAuth(req);
    await auth.revokeAllSessions(userId, 'logout_all', {
      ...auditContext(req),
      actorUserId: userId,
    });
  } else if (body.refreshToken !== undefined) {
    await auth.revokeByRefreshToken(body.refreshToken, auditContext(req));
  }
  res.status(204).end();
}

export async function requestPasswordReset(req: Request, res: Response): Promise<void> {
  const body = parse(requestPasswordResetSchema, req.body);
  const result = await auth.requestPasswordReset(body.phone, auditContext(req));
  res.status(202).json(result);
}

export async function resetPassword(req: Request, res: Response): Promise<void> {
  const body = parse(resetPasswordSchema, req.body);
  await auth.resetPassword(body, auditContext(req));
  res.status(204).end();
}

export async function changePassword(req: Request, res: Response): Promise<void> {
  const body = parse(changePasswordSchema, req.body);
  const { userId } = requireAuth(req);
  await auth.changePassword({ userId, ...body }, { ...auditContext(req), actorUserId: userId });
  res.status(204).end();
}
