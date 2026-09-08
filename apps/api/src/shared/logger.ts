import { pino, type Logger } from 'pino';
import { loadConfig } from '../config/index.js';

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-telegram-bot-api-secret-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.secret',
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'SESSION_SECRET',
  'TELEGRAM_BOT_TOKEN',
  'S3_SECRET_KEY',
];

let cached: Logger | undefined;

export function getLogger(): Logger {
  if (cached) return cached;
  const env = loadConfig();
  cached = pino({
    level: env.LOG_LEVEL,
    base: { service: env.SERVICE_NAME, version: env.APP_VERSION },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    ...(env.NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } } }
      : {}),
  });
  return cached;
}
