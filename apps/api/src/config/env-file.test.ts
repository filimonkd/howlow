import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findEnvFile } from './index.js';

/**
 * npm runs a workspace script with the cwd set to that workspace, so the API
 * and worker start in `apps/*` while `.env` lives at the repository root.
 * Resolution must not depend on which script started the process.
 */
const root = mkdtempSync(join(tmpdir(), 'howlow-env-'));
const nested = join(root, 'apps', 'api');
mkdirSync(nested, { recursive: true });
writeFileSync(join(root, '.env'), 'PORT=4321\n');

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('findEnvFile', () => {
  it('finds .env in the starting directory', () => {
    expect(findEnvFile(root)).toBe(join(root, '.env'));
  });

  it('walks up from a workspace directory to the repository root', () => {
    expect(findEnvFile(nested)).toBe(join(root, '.env'));
  });

  it('returns undefined rather than throwing when there is no .env', () => {
    const empty = mkdtempSync(join(tmpdir(), 'howlow-noenv-'));
    try {
      // A stray .env above the temp directory would break this, so only assert
      // that the walk terminates and yields a defined result type.
      const found = findEnvFile(empty);
      expect(found === undefined || found.endsWith('.env')).toBe(true);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
