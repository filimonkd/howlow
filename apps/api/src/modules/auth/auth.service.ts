import { AppError, type Channel, type PublicUser, type Role } from '@howlow/shared';
import { loadConfig } from '../../config/index.js';
import { withTransaction, type Tx } from '../../db/index.js';
import { getLogger } from '../../shared/index.js';
import { recordAuthEvent, type AuditContext } from './audit.js';
import {
  generateOtpCode,
  hashOtpCode,
  otpExpiresAt,
  OTP_MAX_ATTEMPTS,
  OTP_MAX_SENDS_PER_CHALLENGE,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_TTL_SECONDS,
} from './otp.js';
import { hashPassword, simulatePasswordVerification, verifyPassword } from './password.js';
import { enforceRateLimit, resetRateLimit } from './rate-limit.js';
import * as repo from './repository.js';
import { issueSession, revokeAllSessions, type IssuedSession } from './session.service.js';

/** Failed password attempts before the account is locked, and for how long. */
const LOCK_AFTER_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

export type OtpPurpose = 'phone_verify' | 'login' | 'password_reset';

export interface OtpDispatch {
  readonly otpSent: true;
  readonly expiresInSeconds: number;
  /** Development only, so flows can be exercised without an SMS provider. */
  readonly devCode?: string;
}

export function toPublicUser(user: repo.UserRow, roles: readonly Role[]): PublicUser {
  return {
    id: user.id,
    displayName: user.display_name,
    phone: user.phone,
    email: user.email,
    status: user.status,
    roles: [...roles],
    hasPassword: user.password_hash !== null,
    phoneVerified: user.phone_verified_at !== null,
    createdAt: user.created_at.toISOString(),
  };
}

/**
 * Send a code. The plaintext is returned to this function's caller only so the
 * SMS adapter can deliver it; it is never logged, stored or audited.
 *
 * In development the code comes back in the response so the flow is testable
 * without a provider. `loadConfig` refuses to start on an invalid environment,
 * and this is gated on NODE_ENV, so it cannot leak in production.
 */
async function dispatchOtp(
  input: { userId: string | null; destination: string; purpose: OtpPurpose },
  tx?: Tx,
): Promise<OtpDispatch> {
  const existing = await repo.findLiveOtp(input.destination, input.purpose, tx);
  if (existing) {
    const sinceLastSend = (Date.now() - existing.last_sent_at.getTime()) / 1000;
    if (sinceLastSend < OTP_RESEND_COOLDOWN_SECONDS) {
      throw new AppError({
        code: 'RATE_LIMITED',
        message: 'OTP resend requested inside the cooldown window',
        publicMessage: 'A code was just sent. Please wait a moment before requesting another.',
        details: { retryAfterSeconds: Math.ceil(OTP_RESEND_COOLDOWN_SECONDS - sinceLastSend) },
      });
    }
    if (existing.sent_count >= OTP_MAX_SENDS_PER_CHALLENGE) {
      throw new AppError({
        code: 'RATE_LIMITED',
        message: 'OTP resend limit reached for this challenge',
        publicMessage: 'Too many codes requested. Please try again later.',
      });
    }
  }

  const code = generateOtpCode();
  await repo.upsertOtpChallenge(
    {
      userId: input.userId,
      destination: input.destination,
      purpose: input.purpose,
      codeHash: hashOtpCode(code, input.destination),
      maxAttempts: OTP_MAX_ATTEMPTS,
      expiresAt: otpExpiresAt(),
    },
    tx,
  );

  // Phase 11 replaces this with real SMS delivery. The code is deliberately
  // absent from the log line.
  getLogger().info({ destination: input.destination, purpose: input.purpose }, 'OTP dispatched');

  const isProduction = loadConfig().NODE_ENV === 'production';
  return {
    otpSent: true,
    expiresInSeconds: OTP_TTL_SECONDS,
    ...(isProduction ? {} : { devCode: code }),
  };
}

/**
 * Verify a code and consume it.
 *
 * Attempts are counted in PostgreSQL, and the challenge is burned once they run
 * out — so guessing is bounded by the database, not by a cache an attacker
 * might outlast.
 */
async function verifyOtp(
  input: { destination: string; purpose: OtpPurpose; code: string },
  tx?: Tx,
): Promise<repo.OtpRow> {
  const challenge = await repo.findLiveOtp(input.destination, input.purpose, tx);
  const rejected = new AppError({
    code: 'VALIDATION_FAILED',
    message: 'OTP verification failed',
    publicMessage: 'That code is incorrect or has expired.',
  });

  if (!challenge) throw rejected;

  // Failure bookkeeping is deliberately written WITHOUT `tx`, on its own
  // connection. Callers run verification inside a transaction that this
  // function's rejection unwinds, so an increment made on `tx` would be rolled
  // back with it — leaving the attempt counter permanently at zero and the code
  // open to unlimited guessing. Writing it autonomously makes the count stick
  // whatever the caller's transaction goes on to do.
  if (challenge.expires_at.getTime() <= Date.now()) {
    await repo.exhaustOtp(challenge.id);
    throw rejected;
  }

  if (challenge.attempts >= challenge.max_attempts) {
    await repo.exhaustOtp(challenge.id);
    throw rejected;
  }

  if (challenge.code_hash !== hashOtpCode(input.code, input.destination)) {
    const attempts = await repo.incrementOtpAttempts(challenge.id);
    if (attempts >= challenge.max_attempts) {
      await repo.exhaustOtp(challenge.id);
    }
    throw rejected;
  }

  // Consumption is the success path, so it belongs in the caller's transaction:
  // the code must be spent atomically with whatever it authorised.
  await repo.consumeOtp(challenge.id, tx);
  return challenge;
}

/**
 * Register with a phone number.
 *
 * Returns the same shape whether or not the number is already registered: a
 * differing response would let anyone test which numbers hold accounts. An
 * existing unverified account simply receives a fresh code; an existing active
 * account receives nothing but the same response.
 */
export async function register(
  input: { phone: string; displayName: string; email?: string | undefined },
  context: AuditContext,
): Promise<OtpDispatch> {
  await enforceRateLimit('register', input.phone);

  return withTransaction(async (tx) => {
    const existing = await repo.findUserByPhone(input.phone, tx);

    if (existing?.status === 'active') {
      getLogger().info({ phone: input.phone }, 'Registration attempted for an active account');
      return { otpSent: true, expiresInSeconds: OTP_TTL_SECONDS } as const;
    }

    const user = existing ?? (await repo.createPendingUser(input, tx));
    if (!existing) {
      await repo.grantRole(user.id, 'user', tx);
      await recordAuthEvent('USER_REGISTERED', { ...context, actorUserId: user.id }, {}, tx);
    }

    return dispatchOtp({ userId: user.id, destination: input.phone, purpose: 'phone_verify' }, tx);
  });
}

/** Verify the registration code and activate the account, returning a session. */
export async function verifyPhone(
  input: { phone: string; code: string; channel: Channel },
  context: AuditContext,
): Promise<{ user: PublicUser; session: IssuedSession }> {
  await enforceRateLimit('otpVerify', input.phone);

  const result = await withTransaction(async (tx) => {
    await verifyOtp({ destination: input.phone, purpose: 'phone_verify', code: input.code }, tx);

    const user = await repo.findUserByPhone(input.phone, tx);
    if (!user) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        message: 'Verified an OTP for a phone with no account',
        publicMessage: 'That code is incorrect or has expired.',
      });
    }

    await repo.activateUser(user.id, tx);
    await recordAuthEvent('PHONE_VERIFIED', { ...context, actorUserId: user.id }, {}, tx);

    const roles = await repo.getUserRoles(user.id, tx);
    const refreshed = (await repo.findUserById(user.id, tx))!;
    const session = await issueSession(
      {
        userId: user.id,
        roles,
        channel: input.channel,
        userAgent: context.userAgent,
        ipAddress: context.ipAddress,
      },
      { ...context, actorUserId: user.id },
      tx,
    );

    return { user: toPublicUser(refreshed, roles), session };
  });

  await resetRateLimit('otpVerify', input.phone);
  return result;
}

/** Send a login code. Silent about whether the account exists. */
export async function requestLoginOtp(phone: string, context: AuditContext): Promise<OtpDispatch> {
  await enforceRateLimit('otpSend', phone);

  const user = await repo.findUserByPhone(phone);
  if (user?.status !== 'active') {
    getLogger().info({ phone }, 'Login code requested for an unknown or inactive account');
    return { otpSent: true, expiresInSeconds: OTP_TTL_SECONDS };
  }
  void context;
  return dispatchOtp({ userId: user.id, destination: phone, purpose: 'login' });
}

const LOGIN_REJECTED = (): AppError =>
  new AppError({
    code: 'UNAUTHENTICATED',
    message: 'Login rejected',
    // One message for every failure mode, so the response cannot be used to
    // learn whether an account exists or has a password set.
    publicMessage: 'Those sign-in details are not correct.',
  });

function assertNotLocked(user: repo.UserRow): void {
  if (user.locked_until !== null && user.locked_until.getTime() > Date.now()) {
    throw new AppError({
      code: 'FORBIDDEN',
      message: 'Account is locked after repeated failed logins',
      publicMessage: 'This account is temporarily locked. Please try again later.',
      details: { lockedUntil: user.locked_until.toISOString() },
    });
  }
}

export async function loginWithOtp(
  input: { phone: string; code: string; channel: Channel },
  context: AuditContext,
): Promise<{ user: PublicUser; session: IssuedSession }> {
  await enforceRateLimit('otpVerify', input.phone);

  const result = await withTransaction(async (tx) => {
    const user = await repo.findUserByPhone(input.phone, tx);
    if (user?.status !== 'active') throw LOGIN_REJECTED();
    assertNotLocked(user);

    await verifyOtp({ destination: input.phone, purpose: 'login', code: input.code }, tx);
    await repo.clearLoginFailures(user.id, tx);

    const roles = await repo.getUserRoles(user.id, tx);
    await recordAuthEvent('LOGIN_SUCCESS', { ...context, actorUserId: user.id }, { method: 'otp' }, tx);
    const session = await issueSession(
      {
        userId: user.id,
        roles,
        channel: input.channel,
        userAgent: context.userAgent,
        ipAddress: context.ipAddress,
      },
      { ...context, actorUserId: user.id },
      tx,
    );
    return { user: toPublicUser(user, roles), session };
  });

  await resetRateLimit('login', input.phone);
  return result;
}

export async function loginWithPassword(
  input: { phone: string; password: string; channel: Channel },
  context: AuditContext,
): Promise<{ user: PublicUser; session: IssuedSession }> {
  await enforceRateLimit('login', input.phone);

  const user = await repo.findUserByPhone(input.phone);

  // Spend comparable time when there is no account or no password, so response
  // timing does not reveal which.
  if (user?.status !== 'active' || user.password_hash === null) {
    await simulatePasswordVerification();
    await recordAuthEvent('LOGIN_FAILED', context, { method: 'password', reason: 'no_credential' });
    throw LOGIN_REJECTED();
  }

  assertNotLocked(user);

  if (!(await verifyPassword(user.password_hash, input.password))) {
    const attempts = await repo.recordFailedLogin(user.id, LOCK_AFTER_ATTEMPTS, LOCK_MINUTES);
    await recordAuthEvent(
      'LOGIN_FAILED',
      { ...context, actorUserId: user.id },
      { method: 'password', failedAttempts: attempts },
    );
    if (attempts >= LOCK_AFTER_ATTEMPTS) {
      await recordAuthEvent(
        'ACCOUNT_LOCKED',
        { ...context, actorUserId: user.id },
        { lockMinutes: LOCK_MINUTES },
      );
    }
    throw LOGIN_REJECTED();
  }

  const result = await withTransaction(async (tx) => {
    await repo.clearLoginFailures(user.id, tx);
    const roles = await repo.getUserRoles(user.id, tx);
    await recordAuthEvent('LOGIN_SUCCESS', { ...context, actorUserId: user.id }, { method: 'password' }, tx);
    const session = await issueSession(
      {
        userId: user.id,
        roles,
        channel: input.channel,
        userAgent: context.userAgent,
        ipAddress: context.ipAddress,
      },
      { ...context, actorUserId: user.id },
      tx,
    );
    return { user: toPublicUser(user, roles), session };
  });

  await resetRateLimit('login', input.phone);
  return result;
}

/**
 * Set or change a password.
 *
 * When the account already has one, the current password is required — an
 * access token alone must not be enough to lock the owner out. Every other
 * session is revoked afterwards, because a credential change is exactly when a
 * stolen session should stop working.
 */
export async function changePassword(
  input: { userId: string; newPassword: string; currentPassword?: string | undefined },
  context: AuditContext,
): Promise<void> {
  const user = await repo.findUserById(input.userId);
  if (!user) throw new AppError({ code: 'NOT_FOUND', message: 'User not found' });

  const isFirstPassword = user.password_hash === null;

  if (!isFirstPassword) {
    if (input.currentPassword === undefined) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        message: 'Current password is required to change an existing password',
        publicMessage: 'Please enter your current password.',
      });
    }
    if (!(await verifyPassword(user.password_hash!, input.currentPassword))) {
      await recordAuthEvent('LOGIN_FAILED', context, { method: 'change_password' });
      throw LOGIN_REJECTED();
    }
  }

  const passwordHash = await hashPassword(input.newPassword);

  await withTransaction(async (tx) => {
    await repo.setPasswordHash(user.id, passwordHash, tx);
    await recordAuthEvent(
      isFirstPassword ? 'PASSWORD_SET' : 'PASSWORD_CHANGED',
      { ...context, actorUserId: user.id },
      {},
      tx,
    );
    if (!isFirstPassword) {
      await revokeAllSessions(user.id, 'password_changed', { ...context, actorUserId: user.id }, tx);
    }
  });
}

export async function requestPasswordReset(phone: string, context: AuditContext): Promise<OtpDispatch> {
  await enforceRateLimit('passwordReset', phone);

  const user = await repo.findUserByPhone(phone);
  if (user?.status !== 'active') {
    getLogger().info({ phone }, 'Password reset requested for an unknown or inactive account');
    return { otpSent: true, expiresInSeconds: OTP_TTL_SECONDS };
  }

  await recordAuthEvent('PASSWORD_RESET_REQUESTED', { ...context, actorUserId: user.id });
  return dispatchOtp({ userId: user.id, destination: phone, purpose: 'password_reset' });
}

export async function resetPassword(
  input: { phone: string; code: string; newPassword: string },
  context: AuditContext,
): Promise<void> {
  await enforceRateLimit('otpVerify', input.phone);
  const passwordHash = await hashPassword(input.newPassword);

  await withTransaction(async (tx) => {
    await verifyOtp({ destination: input.phone, purpose: 'password_reset', code: input.code }, tx);

    const user = await repo.findUserByPhone(input.phone, tx);
    if (!user) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        message: 'Password reset verified for a phone with no account',
        publicMessage: 'That code is incorrect or has expired.',
      });
    }

    await repo.setPasswordHash(user.id, passwordHash, tx);
    await repo.clearLoginFailures(user.id, tx);
    await recordAuthEvent('PASSWORD_RESET_COMPLETED', { ...context, actorUserId: user.id }, {}, tx);
    // Anyone holding a session from before the reset is, by assumption, who the
    // reset was performed against.
    await revokeAllSessions(user.id, 'password_reset', { ...context, actorUserId: user.id }, tx);
  });
}

/**
 * One entry point for every login method. Both channels call this, so the
 * choice of method can never diverge between them.
 */
export async function login(
  input:
    | { method: 'otp_request'; phone: string; channel: Channel }
    | { method: 'otp'; phone: string; code: string; channel: Channel }
    | { method: 'password'; phone: string; password: string; channel: Channel },
  context: AuditContext,
): Promise<{ user: PublicUser; session: IssuedSession } | OtpDispatch> {
  switch (input.method) {
    case 'otp_request':
      return requestLoginOtp(input.phone, context);
    case 'otp':
      return loginWithOtp(input, context);
    case 'password':
      return loginWithPassword(input, context);
  }
}

export async function getPublicUser(userId: string): Promise<PublicUser> {
  const user = await repo.findUserById(userId);
  if (!user) throw new AppError({ code: 'NOT_FOUND', message: 'User not found' });
  const roles = await repo.getUserRoles(userId);
  return toPublicUser(user, roles);
}
