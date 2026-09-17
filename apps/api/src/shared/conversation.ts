import { getRedis } from '../db/index.js';
import { getLogger } from './logger.js';

/**
 * Short-lived state for a multi-step conversation.
 *
 * A chat is not a request. "Place a bid" → "type your amounts" → "confirm" is
 * three separate updates from Telegram, and the middle one is a plain text
 * message that means nothing without knowing which auction it answers. This is
 * where that context lives between them.
 *
 * ## Why Redis, and why this is not a database table
 *
 * A draft is not a fact about the platform. It is a half-finished sentence:
 * losing it means the user types their amounts again, which is a small
 * annoyance and never a wrong balance or a lost bid. Nothing here is ever read
 * to decide whether a bid is valid — `bidService.submitBids()` re-resolves the
 * auction, re-reads the terms under a lock and re-checks every rule, so a
 * stale or tampered draft can at worst produce a request that is then refused
 * on its merits.
 *
 * That is also why it carries a TTL rather than a cleanup job: an abandoned
 * draft should disappear on its own.
 *
 * ## Why the idempotency key is minted here
 *
 * The draft holds the key the eventual submission will use. It is generated
 * once, when the confirmation is shown, so tapping Confirm twice replays the
 * first submission instead of charging for a second one. Generating it at
 * submit time would make a double-tap two distinct intents — which is exactly
 * the double-charge idempotency exists to prevent.
 *
 * Lives in `shared/` rather than in a channel because a channel adapter must
 * not open a cache connection, and rather than in `modules/bidding` because it
 * is conversation state, not a bidding rule.
 */

/** Long enough to type a ladder of amounts, short enough to forget a mistake. */
export const DRAFT_TTL_SECONDS = 15 * 60;

const key = (namespace: string, subject: string): string => `conv:${namespace}:${subject}`;

/**
 * Store a draft, replacing any previous one for this subject.
 *
 * One draft per subject on purpose: a user who starts bidding on a second
 * auction has changed their mind about the first, and keeping both would make
 * "confirm" ambiguous.
 */
export async function putDraft(
  namespace: string,
  subject: string,
  value: unknown,
  ttlSeconds: number = DRAFT_TTL_SECONDS,
): Promise<void> {
  try {
    await getRedis().set(key(namespace, subject), JSON.stringify(value), 'EX', ttlSeconds);
  } catch (error) {
    // A draft that cannot be saved surfaces as "that has expired" when the
    // user continues, which is the honest outcome. Failing the whole
    // interaction here would be worse for no gain.
    getLogger().warn({ err: error, namespace }, 'Conversation draft could not be stored');
  }
}

/**
 * Read a draft. Returns undefined when there is none, when it has expired, or
 * when the cache is unreachable — the caller must treat all three the same
 * way, because they are indistinguishable to the person waiting.
 */
export async function getDraft<T>(namespace: string, subject: string): Promise<T | undefined> {
  try {
    const raw = await getRedis().get(key(namespace, subject));
    if (raw === null) return undefined;
    return JSON.parse(raw) as T;
  } catch (error) {
    getLogger().warn({ err: error, namespace }, 'Conversation draft could not be read');
    return undefined;
  }
}

/** Forget a draft, once it has been acted on or abandoned. */
export async function dropDraft(namespace: string, subject: string): Promise<void> {
  try {
    await getRedis().del(key(namespace, subject));
  } catch {
    // It expires on its own; failing to delete it early is not an error.
  }
}
