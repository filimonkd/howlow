import { describe, expect, it } from 'vitest';
import { EnvValidationError, parseEnv } from './env.js';

const base = {
  DATABASE_URL: 'postgresql://howlow:howlow@localhost:5432/howlow',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'a'.repeat(48),
  SESSION_SECRET: 'b'.repeat(48),
  S3_ACCESS_KEY: 'access',
  S3_SECRET_KEY: 'secret',
};

describe('environment validation', () => {
  it('applies defaults for everything optional', () => {
    const env = parseEnv(base);
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(4000);
    expect(env.TELEGRAM_ENABLED).toBe(false);
  });

  it('rejects a missing required variable', () => {
    const { DATABASE_URL: _omitted, ...withoutDatabase } = base;
    expect(() => parseEnv(withoutDatabase)).toThrow(EnvValidationError);
  });

  it('rejects a short or placeholder secret', () => {
    expect(() => parseEnv({ ...base, JWT_SECRET: 'too-short' })).toThrow(EnvValidationError);
    expect(() => parseEnv({ ...base, SESSION_SECRET: `change-me-${'x'.repeat(40)}` })).toThrow(
      EnvValidationError,
    );
  });

  it('requires the Telegram settings only when the channel is enabled', () => {
    expect(() => parseEnv({ ...base, TELEGRAM_ENABLED: 'true' })).toThrow(EnvValidationError);

    // Partial configuration is still refused: the bot username is needed to
    // build account-linking deep links, so enabling the channel without it
    // would fail later, at the point a user tried to connect Telegram.
    expect(() =>
      parseEnv({
        ...base,
        TELEGRAM_ENABLED: 'true',
        TELEGRAM_BOT_TOKEN: '1234:token',
        TELEGRAM_WEBHOOK_SECRET: 'c'.repeat(32),
      }),
    ).toThrow(EnvValidationError);

    const env = parseEnv({
      ...base,
      TELEGRAM_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: '1234:token',
      TELEGRAM_WEBHOOK_SECRET: 'c'.repeat(32),
      TELEGRAM_BOT_USERNAME: 'howlow_bot',
    });
    expect(env.TELEGRAM_ENABLED).toBe(true);
    expect(env.TELEGRAM_BOT_USERNAME).toBe('howlow_bot');
  });

  it('coerces numeric and boolean strings', () => {
    const env = parseEnv({ ...base, PORT: '8080', DATABASE_SSL: '1' });
    expect(env.PORT).toBe(8080);
    expect(env.DATABASE_SSL).toBe(true);
  });

  it('reports every problem at once, naming the variables', () => {
    try {
      parseEnv({ ...base, PORT: 'not-a-port', JWT_SECRET: 'short' });
      expect.unreachable('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const issues = (error as EnvValidationError).issues.join('\n');
      expect(issues).toContain('PORT');
      expect(issues).toContain('JWT_SECRET');
    }
  });
});
