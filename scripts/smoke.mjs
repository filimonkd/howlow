#!/usr/bin/env node
/**
 * Runtime verification used by CI and by `npm run verify:runtime`.
 *
 * Boots the built API in a child process, waits for it to become live, then
 * asserts that readiness reports both PostgreSQL and Redis as up. Exits
 * non-zero on any failure so a broken boot cannot pass a pull request.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

const PORT = Number(process.env.SMOKE_PORT ?? 4100);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const BOOT_TIMEOUT_MS = 30_000;

const child = spawn(process.execPath, ['apps/api/dist/index.js'], {
  env: { ...process.env, PORT: String(PORT), LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn' },
  stdio: ['ignore', 'inherit', 'inherit'],
});

let exited = false;
child.on('exit', (code) => {
  exited = true;
  if (code !== 0) {
    console.error(`API exited early with code ${code}`);
    process.exit(1);
  }
});

const stop = () => {
  if (!exited) child.kill('SIGTERM');
};

const fail = (message) => {
  console.error(`smoke: ${message}`);
  stop();
  process.exit(1);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForLiveness() {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) fail('API process exited before becoming live');
    try {
      const response = await fetch(`${BASE}/health/live`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await sleep(250);
  }
  fail(`API did not become live within ${BOOT_TIMEOUT_MS}ms`);
}

async function main() {
  await waitForLiveness();
  console.log('smoke: API is live');

  const response = await fetch(`${BASE}/health/ready`);
  const body = await response.json();

  if (!response.ok) fail(`readiness returned ${response.status}: ${JSON.stringify(body)}`);
  if (body.status !== 'ok') fail(`readiness is ${body.status}: ${JSON.stringify(body.checks)}`);
  if (body.checks?.postgres?.status !== 'up') fail('PostgreSQL is not reachable');
  if (body.checks?.redis?.status !== 'up') fail('Redis is not reachable');

  console.log('smoke: PostgreSQL up, Redis up — API ready');

  const meta = await (await fetch(`${BASE}/meta`)).json();
  if (meta.auctionAlgorithm !== 'LUB_V1') fail(`unexpected auction algorithm: ${meta.auctionAlgorithm}`);

  const missing = await fetch(`${BASE}/does-not-exist`);
  if (missing.status !== 404) fail(`unknown route returned ${missing.status}, expected 404`);
  const missingBody = await missing.json();
  if (missingBody.error?.code !== 'NOT_FOUND') fail('error envelope is not the shared shape');

  console.log('smoke: OK');
  stop();
  process.exit(0);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
