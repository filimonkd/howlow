/** Cross-cutting constants shared by API, worker and web. */

/** Header carrying a client-supplied idempotency key on mutating HTTP routes. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/** Header carrying the per-request correlation id, echoed back on responses. */
export const REQUEST_ID_HEADER = 'x-request-id';

/** Header Telegram uses to authenticate webhook deliveries. */
export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';

/** Path the API exposes for Telegram webhook deliveries. */
export const TELEGRAM_WEBHOOK_PATH = '/telegram/webhook';

/** Version tag of the auction result algorithm. There is exactly one. */
export const AUCTION_ALGORITHM_VERSION = 'LUB_V1';
