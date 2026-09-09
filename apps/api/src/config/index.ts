import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { parseEnv, type Env } from './env.js';

let cached: Env | undefined;

/**
 * Locate the nearest `.env` by walking up from `startDir`.
 *
 * npm runs a workspace script with the cwd set to that workspace, so
 * `npm run dev:api` starts in `apps/api/` while `.env` lives at the repository
 * root. Resolving relative to the cwd would therefore silently find nothing and
 * fail validation, differently depending on which script was used to start the
 * process. Walking up makes every entry point agree on one file.
 */
export function findEnvFile(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Load and validate configuration once per process. `.env` is read for local
 * development only; in every deployed environment the values come from the
 * process environment.
 */
export function loadConfig(): Env {
  if (cached) return cached;
  if (process.env['NODE_ENV'] !== 'production') {
    const envFile = findEnvFile(process.cwd());
    if (envFile !== undefined) {
      loadDotenv({ path: envFile, quiet: true });
    }
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
