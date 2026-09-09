import { describe, expect, it } from 'vitest';
import { generateRefreshToken, hashToken, tokensMatch } from './tokens.js';

describe('refresh tokens', () => {
  it('generates distinct, URL-safe, high-entropy tokens', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 1000; i += 1) tokens.add(generateRefreshToken());
    expect(tokens.size).toBe(1000);

    const sample = generateRefreshToken();
    expect(sample).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes base64url encodes to 43 characters.
    expect(sample).toHaveLength(43);
  });

  it('hashes to a hex digest that does not contain the token', () => {
    const token = generateRefreshToken();
    const digest = hashToken(token);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(token);
    expect(hashToken(token)).toBe(digest);
    expect(hashToken(generateRefreshToken())).not.toBe(digest);
  });

  it('compares in constant time and rejects length mismatches', () => {
    const token = generateRefreshToken();
    expect(tokensMatch(hashToken(token), hashToken(token))).toBe(true);
    expect(tokensMatch(hashToken(token), hashToken(generateRefreshToken()))).toBe(false);
    expect(tokensMatch('short', 'a-much-longer-value')).toBe(false);
  });
});
