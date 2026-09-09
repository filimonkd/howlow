/**
 * Loads the repository's `.env` for tooling that runs outside the application.
 *
 * The API and worker read `.env` through their validated config, and
 * node-pg-migrate reads it too, so a developer reasonably expects every `npm
 * run` script to see the same file. Standalone scripts get it from here rather
 * than each inventing its own rule.
 *
 * Walks up from the starting directory because npm runs a workspace script with
 * the cwd set to that workspace, while `.env` lives at the repository root.
 * Values already present in the environment win, so CI — which sets them
 * explicitly and has no `.env` — is unaffected.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';

export function findEnvFile(startDir = process.cwd()) {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Load `.env` if there is one. Returns the path used, or undefined. */
export async function loadEnvFile(startDir = process.cwd()) {
  const envFile = findEnvFile(startDir);
  if (envFile === undefined) return undefined;
  const { config } = await import('dotenv');
  config({ path: envFile, quiet: true });
  return envFile;
}
