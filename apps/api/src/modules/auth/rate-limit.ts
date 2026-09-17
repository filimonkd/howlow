import { AppError } from '@howlow/shared';
import { getRedis } from '../../db/index.js';
import { getLogger } from '../../shared/index.js';

/**
 * Fixed-window rate limiting in Redis.
 *
 * Redis is the right home for this: it is throttling state, not financial
 * truth, and losing it on a restart costs a window of extra attempts rather
 * than any correctness. Credential-protecting state that must survive a cache
 * restart — account lockout — lives in PostgreSQL instead.
 */
export interface RateLimitRule {
  readonly limit: number;
  readonly windowSeconds: number;
}

export const RATE_LIMITS = {
  register: { limit: 5, windowSeconds: 3600 },
  otpSend: { limit: 5, windowSeconds: 3600 },
  otpVerify: { limit: 10, windowSeconds: 900 },
  login: { limit: 10, windowSeconds: 900 },
  passwordReset: { limit: 5, windowSeconds: 3600 },
  refresh: { limit: 60, windowSeconds: 900 },
  telegramStart: { limit: 20, windowSeconds: 3600 },
  telegramLink: { limit: 10, windowSeconds: 3600 },

  // Bidding, in four dimensions. A bid costs money and the engine takes three
  // row locks, so the limits protect the user's wallet from a runaway client
  // and the auction row from a stampede — not just the API from load.
  //
  // Requests, not amounts: one request may legitimately carry a batch of 100.
  // The per-auction bid ceiling is the auction's own `max_bids_per_user`,
  // enforced transactionally against the participant row, and these windows
  // never stand in for it.
  /** One user's submissions across every auction. */
  bidSubmit: { limit: 60, windowSeconds: 60 },
  /**
   * One user on one auction. Deliberately tighter: a bidder revising their
   * ladder makes a handful of requests, and a hundred in a minute against a
   * single auction is a script, not a person.
   */
  bidSubmitPerAuction: { limit: 20, windowSeconds: 60 },
  /**
   * One address. Looser than the per-user limit because a household, an
   * office or a mobile carrier NAT legitimately shares one, so this is a
   * ceiling on abuse rather than a per-person rule.
   */
  bidSubmitPerIp: { limit: 120, windowSeconds: 60 },
  /**
   * One auction, from everyone. The last seconds of a popular auction are the
   * worst case in the platform: every bidder queues on the same auction row.
   * This bounds the queue instead of letting it grow until requests time out.
   */
  bidSubmitPerAuctionGlobal: { limit: 600, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitName = keyof typeof RATE_LIMITS;

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
}

/**
 * Count one attempt against `subject` for `name`.
 *
 * Fails open on a Redis outage — deliberately. Rate limiting is defence in
 * depth; the account lockout and OTP attempt counters in PostgreSQL are the
 * hard limits, and refusing every login because a cache is down would turn a
 * degraded cache into a total outage.
 */
export async function consumeRateLimit(name: RateLimitName, subject: string): Promise<RateLimitResult> {
  const rule = RATE_LIMITS[name];
  const key = `ratelimit:${name}:${subject}`;

  try {
    const redis = getRedis();
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, rule.windowSeconds);
    }
    const ttl = await redis.ttl(key);
    return {
      allowed: count <= rule.limit,
      remaining: Math.max(0, rule.limit - count),
      retryAfterSeconds: ttl > 0 ? ttl : rule.windowSeconds,
    };
  } catch (error) {
    getLogger().error({ err: error, rateLimit: name }, 'Rate limiter unavailable; allowing request');
    return { allowed: true, remaining: rule.limit, retryAfterSeconds: 0 };
  }
}

/** Consume one attempt and throw if the limit is exhausted. */
export async function enforceRateLimit(name: RateLimitName, subject: string): Promise<void> {
  const result = await consumeRateLimit(name, subject);
  if (!result.allowed) {
    throw new AppError({
      code: 'RATE_LIMITED',
      message: `Rate limit ${name} exhausted for ${subject}`,
      publicMessage: 'Too many attempts. Please wait before trying again.',
      details: { retryAfterSeconds: result.retryAfterSeconds },
    });
  }
}

/** Clear a counter after an outcome that proves the caller is legitimate. */
export async function resetRateLimit(name: RateLimitName, subject: string): Promise<void> {
  try {
    await getRedis().del(`ratelimit:${name}:${subject}`);
  } catch {
    // A stale counter expires on its own; failing to clear it is not an error.
  }
}
