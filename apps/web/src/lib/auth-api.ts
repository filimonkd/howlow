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

export async function refresh(): Promise<boolean> {
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
