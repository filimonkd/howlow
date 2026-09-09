import { describe, expect, it } from 'vitest';
import { generateOtpCode, hashOtpCode, otpExpiresAt, OTP_LENGTH, OTP_TTL_SECONDS } from './otp.js';

describe('otp codes', () => {
  it('generates codes of the declared length, digits only', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateOtpCode()).toMatch(new RegExp(`^\\d{${String(OTP_LENGTH)}}$`));
    }
  });

  it('covers the whole range including leading zeros', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 3000; i += 1) seen.add(generateOtpCode());
    // A generator that dropped leading zeros, or used a biased modulo, would
    // show up as a collapsed range rather than thousands of distinct values.
    expect(seen.size).toBeGreaterThan(2500);
  });

  it('binds the hash to the destination, so one table is not one rainbow table', () => {
    const code = '123456';
    const forOnePhone = hashOtpCode(code, '+251911111111');
    const forAnother = hashOtpCode(code, '+251922222222');

    expect(forOnePhone).toMatch(/^[0-9a-f]{64}$/);
    expect(forOnePhone).not.toBe(forAnother);
    expect(forOnePhone).not.toContain(code);
    // Deterministic, so verification can compare hashes.
    expect(hashOtpCode(code, '+251911111111')).toBe(forOnePhone);
  });

  it('expires in the future by the declared window', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(otpExpiresAt(now).getTime() - now.getTime()).toBe(OTP_TTL_SECONDS * 1000);
  });
});
