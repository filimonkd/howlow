/**
 * The worker shares the API's validated configuration. There is one
 * environment contract for the whole platform, not one per process.
 */
export { loadConfig, parseEnv, envSchema, EnvValidationError } from '@howlow/api/config';
export type { Env } from '@howlow/api/config';
