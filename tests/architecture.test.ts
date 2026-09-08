import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ESLint } from 'eslint';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The system design invariants say channel adapters may not reach the database
 * and may not import each other, and that business logic may not know about
 * transports. Those rules live in `eslint.config.js`; this suite proves the
 * mechanism actually rejects a violation, so the enforcement cannot be quietly
 * lost in a later phase.
 *
 * The fixtures are written to their real locations on disk, because the rules
 * are path-scoped and type-aware linting resolves files through the TypeScript
 * project. They are removed again when the suite finishes.
 */
const ROOT = process.cwd();
const eslint = new ESLint({ cwd: ROOT });
const written = new Set<string>();

const TELEGRAM_FIXTURE = 'apps/api/src/channels/telegram/handlers/arch-fixture.ts';
const HTTP_FIXTURE = 'apps/api/src/channels/http/controllers/arch-fixture.ts';
const MODULE_FIXTURE = 'apps/api/src/modules/health/arch-fixture.ts';

async function lintFixture(relativePath: string, code: string): Promise<string> {
  const absolute = join(ROOT, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, code, 'utf8');
  written.add(absolute);

  const [result] = await eslint.lintFiles([absolute]);
  const messages = result?.messages ?? [];
  const fatal = messages.find((message) => message.fatal === true);
  if (fatal) throw new Error(`Fixture failed to parse: ${fatal.message}`);

  return messages.map((message) => `${message.ruleId ?? 'unknown'}: ${message.message}`).join('\n');
}

afterAll(() => {
  for (const path of written) rmSync(path, { force: true });
});

describe('architecture boundaries', () => {
  it('stops the Telegram channel from importing the database', async () => {
    const output = await lintFixture(
      TELEGRAM_FIXTURE,
      "import { getPool } from '../../../db/index.js';\nexport const fixture = getPool;\n",
    );
    expect(output).toMatch(/must not touch the database/);
  });

  it('stops the HTTP channel from importing the database', async () => {
    const output = await lintFixture(
      HTTP_FIXTURE,
      "import { withTransaction } from '../../../db/transaction.js';\nexport const fixture = withTransaction;\n",
    );
    expect(output).toMatch(/must not touch the database/);
  });

  it('stops a channel from opening its own pg, redis or queue connection', async () => {
    const output = await lintFixture(HTTP_FIXTURE, "import pg from 'pg';\nexport const fixture = pg;\n");
    expect(output).toMatch(/must not open database, cache or queue connections/);
  });

  it('stops the Telegram channel from importing the HTTP channel', async () => {
    const output = await lintFixture(
      TELEGRAM_FIXTURE,
      "import { createApiRouter } from '../../http/index.js';\nexport const fixture = createApiRouter;\n",
    );
    expect(output).toMatch(/Channels are siblings/);
  });

  it('stops the HTTP channel from importing the Telegram channel', async () => {
    const output = await lintFixture(
      HTTP_FIXTURE,
      "import { getBot } from '../../telegram/bot.js';\nexport const fixture = getBot;\n",
    );
    expect(output).toMatch(/Channels are siblings/);
  });

  it('keeps the Telegram SDK out of the HTTP channel', async () => {
    const output = await lintFixture(
      HTTP_FIXTURE,
      "import { Bot } from 'grammy';\nexport const fixture = Bot;\n",
    );
    expect(output).toMatch(/belongs to channels\/telegram only/);
  });

  it('keeps transports out of business logic', async () => {
    const output = await lintFixture(
      MODULE_FIXTURE,
      "import express from 'express';\nexport const fixture = express;\n",
    );
    expect(output).toMatch(/must not know about transports/);
  });

  it('allows a channel to call an application service', async () => {
    const output = await lintFixture(
      TELEGRAM_FIXTURE,
      "import { getHealth } from '../../../modules/health/index.js';\nexport const fixture = getHealth;\n",
    );
    expect(output).not.toMatch(/no-restricted-imports/);
  });
});
