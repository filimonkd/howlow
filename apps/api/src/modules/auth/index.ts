/**
 * The auth module's public surface. Both channels call these and nothing else;
 * neither reaches into the repository or writes SQL of its own.
 */
export {
  changePassword,
  getPublicUser,
  login,
  loginWithOtp,
  loginWithPassword,
  register,
  requestLoginOtp,
  requestPasswordReset,
  resetPassword,
  verifyPhone,
  toPublicUser,
} from './auth.service.js';
export type { OtpDispatch, OtpPurpose } from './auth.service.js';

export {
  isSessionActive,
  issueSession,
  revokeAllSessions,
  revokeByRefreshToken,
  rotateSession,
} from './session.service.js';
export type { IssuedSession } from './session.service.js';

export {
  confirmLink,
  createLinkToken,
  getTelegramStatus,
  resolveTelegramUser,
  unlinkTelegram,
  LINK_TOKEN_TTL_SECONDS,
} from './telegram.service.js';
export type { TelegramIdentity } from './telegram.service.js';

export { assertRole, hasAnyRole, loadRoles, ROLE_RANK } from './rbac.js';
export { verifyAccessToken } from './tokens.js';
export type { AccessTokenClaims } from './tokens.js';
export { recordAuthEvent } from './audit.js';
export type { AuditContext, AuthEvent } from './audit.js';
export { enforceRateLimit, RATE_LIMITS } from './rate-limit.js';
export type { RateLimitName } from './rate-limit.js';
