/**
 * A channel is how a request reached HOWLOW. It is metadata only: no business
 * rule may branch on it, and auction results, wallet balances and bid handling
 * are identical across channels.
 */
export const CHANNELS = ['web', 'telegram', 'admin', 'system'] as const;

export type Channel = (typeof CHANNELS)[number];

export function isChannel(value: unknown): value is Channel {
  return typeof value === 'string' && (CHANNELS as readonly string[]).includes(value);
}
