import { randomBytes } from 'node:crypto';
import { AppError, type PublicUser } from '@howlow/shared';
import { loadConfig } from '../../config/index.js';
import { withTransaction } from '../../db/index.js';
import { recordAuthEvent, type AuditContext } from './audit.js';
import { toPublicUser } from './auth.service.js';
import { enforceRateLimit } from './rate-limit.js';
import * as repo from './repository.js';
import { hashToken } from './tokens.js';

/**
 * Telegram identity.
 *
 * Identity resolution is always: Telegram user id → telegram_accounts → HOWLOW
 * user id → roles. The username, display name and first/last name are never
 * used to identify or authorise anyone — Telegram re-assigns usernames, so
 * trusting one would let a handle change become an account takeover.
 */
export const LINK_TOKEN_TTL_SECONDS = 900;

export interface TelegramIdentity {
  readonly telegramUserId: string;
  readonly username?: string | undefined;
  readonly firstName?: string | undefined;
  readonly lastName?: string | undefined;
  readonly languageCode?: string | undefined;
}

/**
 * Create a website-initiated link token and return the Telegram deep link.
 *
 * The raw token exists only in the returned URL; the database holds a SHA-256
 * digest. Issuing a new token retires any previous live one.
 */
export async function createLinkToken(
  userId: string,
  context: AuditContext,
): Promise<{ deepLink: string; expiresInSeconds: number }> {
  await enforceRateLimit('telegramLink', userId);

  const env = loadConfig();
  const botUsername = env.TELEGRAM_BOT_USERNAME;
  if (botUsername === undefined || botUsername === '') {
    throw new AppError({
      code: 'INTERNAL',
      message: 'TELEGRAM_BOT_USERNAME is not configured',
      publicMessage: 'Telegram linking is not available right now.',
    });
  }

  const existing = await repo.findTelegramAccountByUserId(userId);
  if (existing) {
    throw new AppError({
      code: 'CONFLICT',
      message: 'User already has a linked Telegram account',
      publicMessage: 'Your account is already connected to Telegram.',
    });
  }

  const token = randomBytes(32).toString('base64url');
  await repo.replaceLinkToken({
    userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + LINK_TOKEN_TTL_SECONDS * 1000),
  });

  await recordAuthEvent('TELEGRAM_LINK_CREATED', { ...context, actorUserId: userId });

  return {
    deepLink: `https://t.me/${botUsername}?start=link_${token}`,
    expiresInSeconds: LINK_TOKEN_TTL_SECONDS,
  };
}

const LINK_REJECTED = (message: string, publicMessage: string): AppError =>
  new AppError({ code: 'VALIDATION_FAILED', message, publicMessage });

/**
 * Confirm a link from the Telegram side.
 *
 * The whole check-and-link runs in one transaction and claims the token with
 * `FOR UPDATE`, so two confirmations racing the same token serialise and the
 * second finds it consumed. Single use is guaranteed by the database rather
 * than by handler ordering.
 */
export async function confirmLink(
  input: { token: string; identity: TelegramIdentity },
  context: AuditContext,
): Promise<PublicUser> {
  await enforceRateLimit('telegramLink', input.identity.telegramUserId);

  return withTransaction(async (tx) => {
    const row = await repo.claimLinkToken(hashToken(input.token), tx);

    if (!row) {
      throw LINK_REJECTED('Unknown link token', 'That link is not valid. Please generate a new one.');
    }
    if (row.consumed_at !== null) {
      throw LINK_REJECTED(
        'Link token already consumed',
        'That link has already been used. Please generate a new one.',
      );
    }
    if (row.expires_at.getTime() <= Date.now()) {
      throw LINK_REJECTED('Link token expired', 'That link has expired. Please generate a new one.');
    }

    // This Telegram account may already belong to a different HOWLOW user.
    const existingForTelegram = await repo.findTelegramAccountByTelegramId(input.identity.telegramUserId, tx);
    if (existingForTelegram) {
      if (existingForTelegram.user_id === row.user_id) {
        throw LINK_REJECTED(
          'Telegram account already linked to this user',
          'This Telegram account is already connected to your HOWLOW account.',
        );
      }
      throw LINK_REJECTED(
        'Telegram account already linked to a different user',
        'This Telegram account is already connected to another HOWLOW account.',
      );
    }

    const user = await repo.findUserById(row.user_id, tx);
    if (user?.status !== 'active') {
      throw LINK_REJECTED('Link target account is not active', 'That account cannot be connected right now.');
    }

    await repo.createTelegramAccount(
      {
        userId: user.id,
        telegramUserId: input.identity.telegramUserId,
        username: input.identity.username,
        firstName: input.identity.firstName,
        lastName: input.identity.lastName,
        languageCode: input.identity.languageCode,
      },
      tx,
    );
    await repo.markLinkTokenConsumed(row.id, input.identity.telegramUserId, tx);

    await recordAuthEvent(
      'TELEGRAM_LINKED',
      { ...context, actorUserId: user.id },
      { telegramUserId: input.identity.telegramUserId },
      tx,
    );

    const roles = await repo.getUserRoles(user.id, tx);
    return toPublicUser(user, roles);
  });
}

/**
 * Resolve a Telegram user id to a HOWLOW identity, or undefined when unlinked.
 * The only identity lookup the bot is permitted to make.
 */
export async function resolveTelegramUser(telegramUserId: string): Promise<PublicUser | undefined> {
  const account = await repo.findTelegramAccountByTelegramId(telegramUserId);
  if (!account) return undefined;
  const user = await repo.findUserById(account.user_id);
  if (!user) return undefined;
  const roles = await repo.getUserRoles(user.id);
  return toPublicUser(user, roles);
}

export async function getTelegramStatus(userId: string): Promise<{
  linked: boolean;
  telegramUserId: string | null;
  username: string | null;
  linkedAt: string | null;
}> {
  const account = await repo.findTelegramAccountByUserId(userId);
  if (!account) {
    return { linked: false, telegramUserId: null, username: null, linkedAt: null };
  }
  return {
    linked: true,
    telegramUserId: account.telegram_user_id,
    username: account.username,
    linkedAt: account.linked_at.toISOString(),
  };
}

/**
 * Unlink Telegram from the website.
 *
 * Refuses when Telegram is the account's only way back in: an account with no
 * verified phone and no password would become unreachable. Bids and orders are
 * never touched — they belong to the HOWLOW user, not to the channel that
 * created them.
 */
export async function unlinkTelegram(userId: string, context: AuditContext): Promise<void> {
  await withTransaction(async (tx) => {
    const user = await repo.findUserById(userId, tx);
    if (!user) throw new AppError({ code: 'NOT_FOUND', message: 'User not found' });

    const account = await repo.findTelegramAccountByUserId(userId, tx);
    if (!account) {
      throw new AppError({
        code: 'NOT_FOUND',
        message: 'No Telegram account is linked',
        publicMessage: 'Your account is not connected to Telegram.',
      });
    }

    const canStillSignIn = user.phone_verified_at !== null || user.password_hash !== null;
    if (!canStillSignIn) {
      throw new AppError({
        code: 'CONFLICT',
        message: 'Unlinking would leave the account with no authentication method',
        publicMessage: 'Verify your phone number or set a password before disconnecting Telegram.',
      });
    }

    await repo.deleteTelegramAccount(userId, tx);
    await recordAuthEvent(
      'TELEGRAM_UNLINKED',
      { ...context, actorUserId: userId },
      { telegramUserId: account.telegram_user_id },
      tx,
    );
  });
}
