import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'tests/**/*.test.ts'],
    // The database suite needs real PostgreSQL; it runs via `npm run test:db`.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/db/**'],
    testTimeout: 30_000,
    environment: 'node',
    passWithNoTests: false,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'apps/*/src/**'],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
  },
});
