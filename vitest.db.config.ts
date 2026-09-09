import { defineConfig } from 'vitest/config';

/**
 * Integration tests that run against a real PostgreSQL. Kept out of `npm test`
 * so the unit suite stays fast and dependency-free; CI runs both.
 *
 * These assert that the database rejects invalid operations. They are the only
 * proof that the constraints protecting money and bids actually hold, so they
 * must run against real PostgreSQL — never a mock.
 */
export default defineConfig({
  test: {
    include: ['tests/db/**/*.test.ts'],
    environment: 'node',
    // Constraint tests share one database; running files in parallel would let
    // their fixtures collide.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
