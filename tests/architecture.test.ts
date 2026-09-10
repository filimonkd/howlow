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
const WORKER_FIXTURE = 'apps/worker/src/jobs/arch-fixture.ts';

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
  /**
   * The wallet's SQL is reachable from one directory only. That is what makes
   * "no balance change without its ledger entry in the same transaction" a
   * property of the system rather than a convention, so the rule that keeps it
   * that way is worth proving.
   */
  it('stops a channel from reaching wallet SQL directly', async () => {
    for (const fixture of [HTTP_FIXTURE, TELEGRAM_FIXTURE]) {
      const depth = fixture.includes('/http/') ? '../../../' : '../../../';
      const output = await lintFixture(
        fixture,
        `import { updateWalletBalance } from '${depth}modules/wallet/walletRepository.js';\nexport const fixture = updateWalletBalance;\n`,
      );
      expect(output).toMatch(/Only modules\/wallet may touch wallet SQL/);
    }
  });

  it('stops another module from reaching wallet SQL directly', async () => {
    const output = await lintFixture(
      MODULE_FIXTURE,
      "import { insertEntry } from '../wallet/walletRepository.js';\nexport const fixture = insertEntry;\n",
    );
    expect(output).toMatch(/Only modules\/wallet may touch wallet SQL/);
  });

  it('stops the worker from reaching wallet SQL directly', async () => {
    const output = await lintFixture(
      WORKER_FIXTURE,
      "import { updateWalletBalance } from '@howlow/api/modules/wallet/walletRepository.js';\nexport const fixture = updateWalletBalance;\n",
    );
    expect(output).toMatch(/Only modules\/wallet may touch wallet SQL/);
  });

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
