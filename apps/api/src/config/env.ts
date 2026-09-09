import { z } from 'zod';

/**
 * Validated process environment.
 *
 * Every environment variable HOWLOW reads is declared here exactly once.
 * The process refuses to start on an invalid or incomplete environment, so no
 * module ever has to defend against a missing variable at runtime.
 */

const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((value) => value === true || value === 'true' || value === '1');

const port = z.coerce.number().int().min(1).max(65_535);

const secret = (name: string) =>
  z
    .string()
    .min(32, `${name} must be at least 32 characters`)
    .refine((value) => !/^(change-?me|placeholder|secret|todo)/i.test(value), {
      message: `${name} still contains a placeholder value`,
    });

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    SERVICE_NAME: z.string().min(1).default('howlow-api'),
    APP_VERSION: z.string().min(1).default('0.1.0'),

    PORT: port.default(4000),
    HOST: z.string().min(1).default('0.0.0.0'),
    PUBLIC_API_URL: z.url().default('http://localhost:4000'),
    WEB_ORIGIN: z.url().default('http://localhost:5173'),

    DATABASE_URL: z.string().min(1),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),
    DATABASE_SSL: booleanish.default(false),

    REDIS_URL: z.string().min(1),

    JWT_SECRET: secret('JWT_SECRET'),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
    JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().min(600).default(2_592_000),
    SESSION_SECRET: secret('SESSION_SECRET'),

    TELEGRAM_ENABLED: booleanish.default(false),
    TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
    TELEGRAM_WEBHOOK_SECRET: z.string().min(16).optional(),
    // Used to build the t.me deep link for account linking. Public information,
    // not a secret.
    TELEGRAM_BOT_USERNAME: z.string().min(3).max(64).optional(),

    S3_ENDPOINT: z.url().default('http://localhost:9000'),
    S3_REGION: z.string().min(1).default('us-east-1'),
    S3_BUCKET: z.string().min(1).default('howlow-dev'),
    S3_ACCESS_KEY: z.string().min(1),
    S3_SECRET_KEY: z.string().min(1),
    S3_FORCE_PATH_STYLE: booleanish.default(true),

    SMTP_HOST: z.string().min(1).default('localhost'),
    SMTP_PORT: port.default(1025),
    SMTP_FROM: z.string().min(3).default('HOWLOW <no-reply@howlow.local>'),
  })
  .superRefine((env, ctx) => {
    if (!env.TELEGRAM_ENABLED) return;
    if (!env.TELEGRAM_BOT_TOKEN) {
      ctx.addIssue({
        code: 'custom',
        path: ['TELEGRAM_BOT_TOKEN'],
        message: 'TELEGRAM_BOT_TOKEN is required when TELEGRAM_ENABLED is true',
      });
    }
    if (!env.TELEGRAM_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['TELEGRAM_WEBHOOK_SECRET'],
        message: 'TELEGRAM_WEBHOOK_SECRET is required when TELEGRAM_ENABLED is true',
      });
    }
    if (!env.TELEGRAM_BOT_USERNAME) {
      ctx.addIssue({
        code: 'custom',
        path: ['TELEGRAM_BOT_USERNAME'],
        message: 'TELEGRAM_BOT_USERNAME is required when TELEGRAM_ENABLED is true',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvValidationError';
  }
}

/**
 * Parse an environment record. Exported separately from `loadEnv` so it can be
 * unit-tested without touching `process.env`.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}
