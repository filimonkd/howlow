/** Branded identifier types shared by every channel. */

declare const brand: unique symbol;

type Brand<T, B extends string> = T & { readonly [brand]: B };

export type UserId = Brand<string, 'UserId'>;
export type AuctionId = Brand<string, 'AuctionId'>;
export type BidId = Brand<string, 'BidId'>;
export type WalletId = Brand<string, 'WalletId'>;
export type LedgerEntryId = Brand<string, 'LedgerEntryId'>;
export type OrderId = Brand<string, 'OrderId'>;
export type ProductId = Brand<string, 'ProductId'>;
export type TelegramUserId = Brand<string, 'TelegramUserId'>;

/** Idempotency key supplied by a client to make a mutation replay-safe. */
export type IdempotencyKey = Brand<string, 'IdempotencyKey'>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Unsafe cast helper — only for boundaries that have already validated the value. */
export function asId<T extends string>(value: string): T {
  return value as T;
}
