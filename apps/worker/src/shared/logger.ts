import { getLogger as getBaseLogger } from '@howlow/api/shared';
import type { Logger } from 'pino';

/**
 * The worker shares the API's logger configuration (levels, redaction) but tags
 * its records so the two processes are distinguishable in aggregated logs.
 */
let cached: Logger | undefined;

export function getLogger(): Logger {
  cached ??= getBaseLogger().child({ process: 'worker' });
  return cached;
}
