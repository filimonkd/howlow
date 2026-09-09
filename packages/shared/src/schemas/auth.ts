import { z } from 'zod';
import { CHANNELS } from '../channel.js';

/**
 * Wire contracts for authentication, shared by the API and the website so both
 * agree on the shape of every request and response.
 */

/** E.164. Phone is the primary account identifier. */
export const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/, 'Phone must be in E.164 format, e.g. +251911234567');

export const emailSchema = z.email().max(254);

/**
 * Twelve characters minimum. Length beats composition rules: a passphrase is
 * both stronger and easier to remember than a short string with a symbol in it.
 */
export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(200, 'Password must be at most 200 characters');

export const otpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Code must be 6 digits');

export const otpPurposeSchema = z.enum(['phone_verify', 'login', 'password_reset']);

export const roleSchema = z.enum([
  'user',
  'seller',
  'support_agent',
  'finance',
  'auction_manager',
  'admin',
  'super_admin',
]);

export type Role = z.infer<typeof roleSchema>;

export const registerRequestSchema = z.object({
  phone: phoneSchema,
  displayName: z.string().trim().min(1).max(80),
  email: emailSchema.optional(),
});

export const verifyPhoneRequestSchema = z.object({
  phone: phoneSchema,
  code: otpCodeSchema,
});

/**
 * Login is either a one-time code or a password. Discriminated so a request can
 * never carry both and leave the server choosing.
 */
export const loginRequestSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('otp'), phone: phoneSchema, code: otpCodeSchema }),
  z.object({ method: z.literal('password'), phone: phoneSchema, password: z.string().min(1) }),
  z.object({ method: z.literal('otp_request'), phone: phoneSchema }),
]);

export const refreshRequestSchema = z.object({ refreshToken: z.string().min(20) });
export const logoutRequestSchema = z.object({
  refreshToken: z.string().min(20).optional(),
  allSessions: z.boolean().default(false),
});

export const requestPasswordResetSchema = z.object({ phone: phoneSchema });
export const resetPasswordSchema = z.object({
  phone: phoneSchema,
  code: otpCodeSchema,
  newPassword: passwordSchema,
});
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).optional(),
  newPassword: passwordSchema,
});

export const tokenPairSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int().positive(),
});

export type TokenPair = z.infer<typeof tokenPairSchema>;

/**
 * The authenticated user as the API exposes it. `id` is the account's uuid —
 * opaque and non-enumerable. No internal sequential identifier is ever exposed.
 */
export const publicUserSchema = z.object({
  id: z.uuid(),
  displayName: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  status: z.enum(['pending', 'active', 'suspended', 'deleted']),
  roles: z.array(roleSchema),
  hasPassword: z.boolean(),
  phoneVerified: z.boolean(),
  createdAt: z.iso.datetime(),
});

export type PublicUser = z.infer<typeof publicUserSchema>;

export const authResultSchema = z.object({
  user: publicUserSchema,
  tokens: tokenPairSchema,
});

export type AuthResult = z.infer<typeof authResultSchema>;

/**
 * Registration and OTP requests never reveal whether an account exists — the
 * response is identical either way. `otpSent` says a code was dispatched if one
 * was warranted, not that the account is real.
 */
export const otpDispatchedSchema = z.object({
  otpSent: z.literal(true),
  expiresInSeconds: z.number().int().positive(),
  /** Development only. Never populated when NODE_ENV is production. */
  devCode: z.string().optional(),
});

export const telegramLinkSchema = z.object({
  deepLink: z.url(),
  expiresInSeconds: z.number().int().positive(),
});

export const telegramStatusSchema = z.object({
  linked: z.boolean(),
  telegramUserId: z.string().nullable(),
  username: z.string().nullable(),
  linkedAt: z.iso.datetime().nullable(),
});

export const sessionChannelSchema = z.enum(CHANNELS);

export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type TelegramStatus = z.infer<typeof telegramStatusSchema>;
