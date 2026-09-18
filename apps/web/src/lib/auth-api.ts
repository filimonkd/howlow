import type { AuthResult, PublicUser, TelegramStatus, TokenPair } from '@howlow/shared';
import { apiFetch } from './api.js';

/**
 * The website's auth client.
 *
 * Tokens are held in memory for the page's lifetime and the refresh token is
 * mirrored to localStorage so a reload does not sign the user out. That is a
 * deliberate MVP trade-off: it is readable by XSS, and Phase 7 should move the
 * refresh token to an httpOnly cookie once the real website is built.
 */
const REFRESH_STORAGE_KEY = 'howlow.refresh';

let accessToken: string | undefined;

export function getAccessToken(): string | undefined {
  return accessToken;
}

export function storedRefreshToken(): string | undefined {
  try {
    return window.localStorage.getItem(REFRESH_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function rememberTokens(tokens: TokenPair): void {
  accessToken = tokens.accessToken;
  try {
    window.localStorage.setItem(REFRESH_STORAGE_KEY, tokens.refreshToken);
  } catch {
    // A private window without storage still works for this session.
  }
}

export function forgetTokens(): void {
  accessToken = undefined;
  try {
    window.localStorage.removeItem(REFRESH_STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}

function authorized(): RequestInit {
  return accessToken === undefined ? {} : { headers: { Authorization: `Bearer ${accessToken}` } };
}

function json(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export interface OtpDispatched {
  otpSent: true;
  expiresInSeconds: number;
  devCode?: string;
}

export function register(input: { phone: string; displayName: string }): Promise<OtpDispatched> {
  return apiFetch('/auth/register', (v) => v as OtpDispatched, json(input));
}

export async function verifyPhone(input: { phone: string; code: string }): Promise<AuthResult> {
  const result = await apiFetch('/auth/verify-phone', (v) => v as AuthResult, json(input));
  rememberTokens(result.tokens);
  return result;
}

export function requestLoginCode(phone: string): Promise<OtpDispatched> {
  return apiFetch('/auth/login', (v) => v as OtpDispatched, json({ method: 'otp_request', phone }));
}

export async function login(
  input:
    { method: 'otp'; phone: string; code: string } | { method: 'password'; phone: string; password: string },
): Promise<AuthResult> {
  const result = await apiFetch('/auth/login', (v) => v as AuthResult, json(input));
  rememberTokens(result.tokens);
  return result;
}

/**
 * The refresh in flight, if there is one.
 *
 * **A refresh token may be presented exactly once.** The API rotates it and
 * treats a second presentation as theft: it revokes the whole session family,
 * which signs the user out and makes them re-authenticate with an OTP. That
 * behaviour is correct and must not be weakened — so the client's job is never
 * to present the same token twice, and this is how it keeps that promise.
 *
 * Two callers racing is not hypothetical. React's `StrictMode` invokes effects
 * twice in development, so the session-restore effect fired two refreshes with
 * one stored token and the second revoked the session — **a returning user was
 * signed out on every page load of the dev server.** Found by driving the real
 * website in Chromium; nothing in the module tests could see it, because the
 * defect is that two callers exist rather than that either is wrong.
 *
 * It is not only a development problem. Two tabs restoring at once, or a
 * reload during a slow refresh, present the same stored token twice in
 * production for exactly the same reason.
 */
let inFlight: Promise<boolean> | undefined;

export async function refresh(): Promise<boolean> {
  // Concurrent callers share one rotation and one answer. Cleared in
  // `finally`, so a later refresh — after the token has rotated — is a fresh
  // request rather than a cached verdict.
  inFlight ??= (async () => {
    const refreshToken = storedRefreshToken();
    if (refreshToken === undefined) return false;
    try {
      const result = await apiFetch<{ tokens: TokenPair }>(
        '/auth/refresh',
        (v) => v as { tokens: TokenPair },
        json({ refreshToken }),
      );
      rememberTokens(result.tokens);
      return true;
    } catch {
      forgetTokens();
      return false;
    }
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = undefined;
  }
}

export async function logout(): Promise<void> {
  const refreshToken = storedRefreshToken();
  await apiFetch('/auth/logout', () => null, {
    ...json({ refreshToken }),
    headers: { 'Content-Type': 'application/json', ...authorized().headers },
  }).catch(() => null);
  forgetTokens();
}

export function requestPasswordReset(phone: string): Promise<OtpDispatched> {
  return apiFetch('/auth/request-password-reset', (v) => v as OtpDispatched, json({ phone }));
}

export function resetPassword(input: { phone: string; code: string; newPassword: string }): Promise<null> {
  return apiFetch('/auth/reset-password', () => null, json(input));
}

export function getMe(): Promise<PublicUser> {
  return apiFetch('/me', (v) => v as PublicUser, authorized());
}

export function setPassword(input: { newPassword: string; currentPassword?: string }): Promise<null> {
  return apiFetch('/auth/change-password', () => null, {
    ...json(input),
    headers: { 'Content-Type': 'application/json', ...authorized().headers },
  });
}

export function telegramStatus(): Promise<TelegramStatus> {
  return apiFetch('/me/telegram/status', (v) => v as TelegramStatus, authorized());
}

export function createTelegramLink(): Promise<{ deepLink: string; expiresInSeconds: number }> {
  return apiFetch('/me/telegram/link', (v) => v as { deepLink: string; expiresInSeconds: number }, {
    method: 'POST',
    ...authorized(),
  });
}

export function unlinkTelegram(): Promise<null> {
  return apiFetch('/me/telegram', () => null, { method: 'DELETE', ...authorized() });
}
