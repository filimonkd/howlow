/**
 * Clears the Redis rate-limit counters before a smoke run.
 *
 * The limiter is keyed by source IP, and every smoke script drives the API from
 * 127.0.0.1 against one Redis. Registration allows five attempts per hour, so
 * running the auth, wallet and catalog scripts back to back — which is exactly
 * what CI does — spends the shared budget and the last script is refused with
 * 429. The limiter is behaving correctly; the counters are a precondition each
 * script has to establish for itself, the way the database suites truncate
 * their tables before a run.
 *
 * Only `ratelimit:*` keys are removed, so sessions, queues and anything else in
 * Redis are left alone. Scanned rather than KEYS-ed so the habit stays right
 * even though a test Redis holds very little.
 *
 * This makes the budget per-script rather than per-hour; it does not raise it.
 * Registration is five per IP per hour and smoke-catalog, the heaviest script,
 * spends four — so a script that grows past five accounts will see 429 again.
 * Reuse an account or split the script; do not relax the production limit to
 * suit a test.
 */
import process from 'node:process';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

/**
 * Delete every rate-limit counter. Returns the number of keys removed, or
 * undefined if Redis could not be reached — a warning rather than a failure,
 * because the run may still have budget left and the real assertions follow.
 */
export async function clearRateLimits() {
  let redis;
  try {
    const { default: Redis } = await import('ioredis');
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
    await redis.connect();

    let removed = 0;
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', 'ratelimit:*', 'COUNT', 500);
      cursor = next;
      if (keys.length > 0) removed += await redis.del(...keys);
    } while (cursor !== '0');
    return removed;
  } catch (error) {
    console.warn(`clear-rate-limits: could not reach Redis at ${REDIS_URL}: ${String(error)}`);
    return undefined;
  } finally {
    redis?.disconnect();
  }
}
