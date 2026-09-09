import type { Request, Response } from 'express';
import { REQUEST_ID_HEADER } from '@howlow/shared';
import * as auth from '../../../modules/auth/index.js';
import { requireAuth } from '../middleware/authenticate.js';

function auditContext(req: Request): auth.AuditContext {
  const requestId = req.res?.getHeader(REQUEST_ID_HEADER);
  return {
    channel: 'web',
    ipAddress: req.ip,
    userAgent: req.header('user-agent'),
    requestId: typeof requestId === 'string' ? requestId : undefined,
  };
}

export async function getMe(req: Request, res: Response): Promise<void> {
  const { userId } = requireAuth(req);
  res.status(200).json(await auth.getPublicUser(userId));
}

export async function createTelegramLink(req: Request, res: Response): Promise<void> {
  const { userId } = requireAuth(req);
  const link = await auth.createLinkToken(userId, { ...auditContext(req), actorUserId: userId });
  res.status(201).json(link);
}

export async function getTelegramStatus(req: Request, res: Response): Promise<void> {
  const { userId } = requireAuth(req);
  res.status(200).json(await auth.getTelegramStatus(userId));
}

export async function unlinkTelegram(req: Request, res: Response): Promise<void> {
  const { userId } = requireAuth(req);
  await auth.unlinkTelegram(userId, { ...auditContext(req), actorUserId: userId });
  res.status(204).end();
}
