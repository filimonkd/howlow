import { config as loadDotenv } from 'dotenv';
import { parseEnv, type Env } from './env.js';

let cached: Env | undefined;

/**
 * Load and validate configuration once per process. `.env` is read for local
 * development only; in every deployed environment the values come from the
 * process environment.
 */
export function loadConfig(): Env {
  if (cached) return cached;
  if (process.env['NODE_ENV'] !== 'production') {
    loadDotenv({ quiet: true });
  }
  cached = parseEnv(process.env);
  return cached;
}

/** Test-only: drop the memoised configuration. */
export function resetConfigCache(): void {
  cached = undefined;
}

export { parseEnv, envSchema, EnvValidationError } from './env.js';
export type { Env } from './env.js';
