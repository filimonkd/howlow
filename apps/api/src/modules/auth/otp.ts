import { createHash, randomInt } from 'node:crypto';

/**
 * One-time codes.
 *
 * Six digits, generated with `randomInt` (CSPRNG-backed and free of the modulo
 * bias a naive `random() * 900000` introduces). Only the hash is stored, and the
 * plaintext is returned exactly once — to the caller that is about to send it.
 * Nothing logs it.
 *
 * SHA-256 with the destination mixed in: the code has only ~20 bits of entropy,
 * so binding the hash to the phone number stops a stolen table from being
 * attacked as one big rainbow-table problem, while the attempt limit and short
 * expiry do the real work of making guessing useless.
 */
export const OTP_LENGTH = 6;
export const OTP_TTL_SECONDS = 300;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_SECONDS = 60;
export const OTP_MAX_SENDS_PER_CHALLENGE = 5;

export function generateOtpCode(): string {
  return String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');
}

export function hashOtpCode(code: string, destination: string): string {
  return createHash('sha256').update(`${destination}:${code}`, 'utf8').digest('hex');
}

export function otpExpiresAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + OTP_TTL_SECONDS * 1000);
}
