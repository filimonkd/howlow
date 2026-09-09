import { describe, expect, it } from 'vitest';
import { assertRole, hasAnyRole } from './rbac.js';

describe('role checks', () => {
  it('grants when the user holds one of the allowed roles', () => {
    expect(hasAnyRole(['user', 'seller'], ['seller'])).toBe(true);
    expect(hasAnyRole(['user'], ['seller', 'admin'])).toBe(false);
  });

  it('treats an empty requirement as open', () => {
    expect(hasAnyRole(['user'], [])).toBe(true);
  });

  it('lets super_admin satisfy anything, but not admin', () => {
    expect(hasAnyRole(['super_admin'], ['finance'])).toBe(true);
    expect(hasAnyRole(['super_admin'], ['auction_manager'])).toBe(true);
    expect(hasAnyRole(['admin'], ['finance'])).toBe(false);
  });

  it('refuses without naming the role the caller lacked', () => {
    try {
      assertRole(['user'], ['finance']);
      expect.unreachable('expected a refusal');
    } catch (error) {
      const app = error as { code: string; publicMessage: string };
      expect(app.code).toBe('FORBIDDEN');
      expect(app.publicMessage).not.toMatch(/finance/i);
    }
  });
});
