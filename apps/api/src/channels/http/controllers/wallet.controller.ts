import type { Request, Response } from 'express';
import {
  adminAdjustmentSchema,
  REQUEST_ID_HEADER,
  walletFreezeSchema,
  walletTransactionsQuerySchema,
} from '@howlow/shared';
import * as wallet from '../../../modules/wallet/index.js';
import { requireAuth } from '../middleware/authenticate.js';

/**
 * The website's wallet endpoints.
 *
 * These contain no business logic: they read the caller, validate the request
 * shape, call the wallet module and serialise the result. Every balance rule,
 * every lock and every ledger write lives in the module, so the Telegram
 * handlers reach identical behaviour by calling the same functions.
 */
function requestContext(req: Request): wallet.RequestContext {
  const requestId = req.res?.getHeader(REQUEST_ID_HEADER);
  return {
    ipAddress: req.ip,
    userAgent: req.header('user-agent'),
    requestId: typeof requestId === 'string' ? requestId : undefined,
  };
}

/**
 * The `:publicId` path parameter. Express types a param as `string | string[]`
 * because a repeated segment can match more than once; a wallet identifier is
 * one value, so anything else is rejected rather than coerced.
 */
function publicIdParam(req: Request): string {
  const value = req.params['publicId'];
  return typeof value === 'string' ? value : '';
}

export async function getMyWallet(req: Request, res: Response): Promise<void> {
  const { userId } = requireAuth(req);
  res.status(200).json(wallet.toWalletDto(await wallet.getWallet(userId)));
}

export async function getMyTransactions(req: Request, res: Response): Promise<void> {
  const { userId } = requireAuth(req);
  const query = walletTransactionsQuerySchema.parse(req.query);
  const page = await wallet.getTransactions(userId, {
    limit: query.limit,
    ...(query.cursor !== undefined ? { beforeSeq: wallet.decodeCursor(query.cursor) } : {}),
  });
  res.status(200).json({
    entries: page.entries.map(wallet.toWalletEntryDto),
    nextCursor: page.nextSeq === null ? null : wallet.encodeCursor(page.nextSeq),
  });
}

/**
 * `:publicId` is resolved by the module, which accepts either the wallet's id
 * or its owner's. The role gate in front of this route is not the only check:
 * the module asserts the actor's role again, so the operation is protected
 * however it is reached.
 */
async function adjust(
  direction: 'credit' | 'debit',
  req: Request,
  res: Response,
): Promise<void> {
  const { userId } = requireAuth(req);
  const body = adminAdjustmentSchema.parse(req.body);
  const target = await wallet.resolveWalletForAdmin(
    publicIdParam(req),
    userId,
    body.currency,
  );
  const key = idempotencyKey(req);

  const input = {
    walletId: target.id,
    amountMinor: BigInt(body.amountMinor),
    currency: body.currency,
    reason: body.reason,
    ...(body.referenceType !== undefined ? { referenceType: body.referenceType } : {}),
    ...(body.referenceId !== undefined ? { referenceId: body.referenceId } : {}),
    ...(key !== undefined ? { idempotencyKey: key } : {}),
    actorUserId: userId,
    channel: 'web' as const,
    context: requestContext(req),
  };

  const result =
    direction === 'credit' ? await wallet.adminCredit(input) : await wallet.adminDebit(input);

  res.status(result.replayed ? 200 : 201).json({
    walletId: result.walletId,
    entryId: result.entryId,
    amountMinor: result.amountMinor.toString(),
    balanceAfterMinor: result.balanceAfterMinor.toString(),
    currency: result.currency,
    replayed: result.replayed,
  });
}

/**
 * An `Idempotency-Key` header makes a retried adjustment apply once. Finance
 * tooling that times out and retries must not double someone's balance.
 */
function idempotencyKey(req: Request): string | undefined {
  const header = req.header('idempotency-key');
  return header !== undefined && header.trim().length >= 8 ? header.trim() : undefined;
}

export async function adminCredit(req: Request, res: Response): Promise<void> {
  await adjust('credit', req, res);
}

export async function adminDebit(req: Request, res: Response): Promise<void> {
  await adjust('debit', req, res);
}

export async function getReconciliation(req: Request, res: Response): Promise<void> {
  const { userId } = requireAuth(req);
  const target = await wallet.resolveWalletForAdmin(publicIdParam(req), userId);
  res.status(200).json(await wallet.reconcileWallet(target.id));
}

export async function freeze(req: Request, res: Response): Promise<void> {
  const { userId } = requireAuth(req);
  const body = walletFreezeSchema.parse(req.body);
  const target = await wallet.resolveWalletForAdmin(publicIdParam(req), userId);
  const frozen = await wallet.freezeWallet({
    walletId: target.id,
    reason: body.reason,
    actorUserId: userId,
    channel: 'web',
    context: requestContext(req),
  });
  res.status(200).json(wallet.toWalletDto(frozen));
}

export async function unfreeze(req: Request, res: Response): Promise<void> {
  const { userId } = requireAuth(req);
  const body = walletFreezeSchema.parse(req.body);
  const target = await wallet.resolveWalletForAdmin(publicIdParam(req), userId);
  const thawed = await wallet.unfreezeWallet({
    walletId: target.id,
    reason: body.reason,
    actorUserId: userId,
    channel: 'web',
    context: requestContext(req),
  });
  res.status(200).json(wallet.toWalletDto(thawed));
}
