import { AsyncLocalStorage } from 'node:async_hooks';
import type { Channel } from '@howlow/shared';

/**
 * Ambient per-request metadata. It carries identity and correlation only —
 * never anything a business rule is allowed to branch on beyond the acting
 * user. `channel` exists for logging and auditing.
 */
export interface RequestContext {
  readonly requestId: string;
  readonly channel: Channel;
  readonly userId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
