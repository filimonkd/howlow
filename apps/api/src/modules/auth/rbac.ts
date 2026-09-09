import { AppError, type Role } from '@howlow/shared';
import * as repo from './repository.js';

/**
 * Role-based authorization.
 *
 * Roles are resolved from the HOWLOW user id, so the website and the Telegram
 * bot reach identical answers for the same person. Nothing here knows which
 * channel asked.
 */
export const ROLE_RANK: Record<Role, number> = {
  user: 0,
  seller: 10,
  support_agent: 20,
  finance: 30,
  auction_manager: 40,
  admin: 50,
  super_admin: 60,
};

/** True when the user holds any of `allowed`, or outranks all of them. */
export function hasAnyRole(userRoles: readonly Role[], allowed: readonly Role[]): boolean {
  if (allowed.length === 0) return true;
  if (userRoles.includes('super_admin')) return true;
  return allowed.some((role) => userRoles.includes(role));
}

export function assertRole(userRoles: readonly Role[], allowed: readonly Role[]): void {
  if (!hasAnyRole(userRoles, allowed)) {
    throw new AppError({
      code: 'FORBIDDEN',
      message: `Requires one of: ${allowed.join(', ')}`,
      publicMessage: 'You do not have permission to do that.',
    });
  }
}

export async function loadRoles(userId: string): Promise<Role[]> {
  return repo.getUserRoles(userId);
}
