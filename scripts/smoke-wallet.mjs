#!/usr/bin/env node
/**
 * End-to-end verification of the Phase 3 HTTP surface.
 *
 * Boots the built API and drives the real wallet endpoints over HTTP: the
 * owner's wallet and transactions, finance adjustments with an idempotency
 * header, freeze and unfreeze, reconciliation, and the authorization boundary.
 *
 * The database suite calls the wallet module directly, which is the right place
 * to prove locking and ledger behaviour but leaves the channel wiring unproven.
 * Anything the module gets right and the controller wires up wrongly — a
 * serialised amount that became a JSON number, a missing role gate, a broken
 * cursor — shows here and nowhere else.
 *
 * Registration is rate limited per IP, so several runs in quick succession will
 * be refused with 429. That is the limiter working; wait for the window or
 * clear the `ratelimit:register:<ip>` key in Redis.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';
import pg from 'pg';
import { loadEnvFile } from './load-env.mjs';

await loadEnvFile();

const PORT = Number(process.env.SMOKE_PORT ?? 4301);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const BOOT_TIMEOUT_MS = 30_000;

const child = spawn(process.execPath, ['apps/api/dist/index.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
    NODE_ENV: 'development',
    TELEGRAM_BOT_USERNAME: process.env.TELEGRAM_BOT_USERNAME ?? 'howlow_smoke_bot',
  },
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

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

const stop = () => {
  if (!exited) child.kill('SIGTERM');
  void db.end().catch(() => undefined);
};
const fail = (message) => {
  console.error(`smoke-wallet: ${message}`);
  stop();
  process.exit(1);
};
const check = (condition, message) => {
  if (!condition) fail(message);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(path, { method = 'GET', body, token, idempotencyKey } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      ...(idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, raw: text, body: text === '' ? null : JSON.parse(text) };
}

async function waitForBoot() {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) fail('API exited before becoming live');
    try {
      const response = await fetch(`${BASE}/health/live`);
      if (response.ok) return;
    } catch {
      /* not listening yet */
    }
    await sleep(250);
  }
  fail(`API did not become live within ${BOOT_TIMEOUT_MS}ms`);
}

const uniquePhone = (suffix) => `+25199${String(Date.now() % 100_000).padStart(5, '0')}${suffix}`;

/** Register, verify and return a live session. */
async function newAccount(displayName, suffix) {
  const phone = uniquePhone(suffix);
  const registered = await call('/auth/register', {
    method: 'POST',
    body: { phone, displayName },
  });
  check(registered.status === 202, `register returned ${registered.status}`);
  const verified = await call('/auth/verify-phone', {
    method: 'POST',
    body: { phone, code: registered.body.devCode },
  });
  check(verified.status === 200, `verify-phone returned ${verified.status}`);
  return { phone, userId: verified.body.user.id, token: verified.body.tokens.accessToken };
}

async function main() {
  await waitForBoot();
  await db.connect();
  console.log('smoke-wallet: API is live');

  const owner = await newAccount('Wallet Owner', '1');
  const finance = await newAccount('Finance Operator', '2');

  // --- the owner's own wallet ---------------------------------------------
  const unauthenticated = await call('/me/wallet');
  check(unauthenticated.status === 401, `/me/wallet without a token returned ${unauthenticated.status}`);

  const wallet = await call('/me/wallet', { token: owner.token });
  check(wallet.status === 200, `/me/wallet returned ${wallet.status}`);
  check(wallet.body.availableMinor === '0', 'a new wallet did not start at zero');
  check(wallet.body.currency === 'ETB', `wallet currency was ${wallet.body.currency}`);
  check(wallet.body.frozen === false, 'a new wallet was frozen');

  // Money must be a JSON string, never a number: a balance can exceed 2^53.
  check(
    /"availableMinor":"0"/.test(wallet.raw),
    `availableMinor was not serialised as a string: ${wallet.raw}`,
  );
  console.log('smoke-wallet: the owner reads their own wallet, money as strings');

  const empty = await call('/me/wallet/transactions', { token: owner.token });
  check(empty.status === 200, `transactions returned ${empty.status}`);
  check(empty.body.entries.length === 0, 'a new wallet had transactions');
  check(empty.body.nextCursor === null, 'an empty ledger offered a next page');

  // --- authorization ------------------------------------------------------
  const forbidden = await call(`/admin/wallets/${owner.userId}/credit`, {
    method: 'POST',
    token: owner.token,
    body: { amountMinor: '100000', reason: 'Trying to credit my own wallet' },
  });
  check(forbidden.status === 403, `an ordinary user's credit returned ${forbidden.status}`);
  console.log('smoke-wallet: an ordinary user cannot adjust a wallet');

  await db.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'finance')`, [finance.userId]);
  // The role is carried in the access token, so a new session is needed for it.
  const financeSession = await call('/auth/login', {
    method: 'POST',
    body: { method: 'otp_request', phone: finance.phone },
  });
  check(financeSession.status === 202, `login otp request returned ${financeSession.status}`);
  const financeLogin = await call('/auth/login', {
    method: 'POST',
    body: { method: 'otp', phone: finance.phone, code: financeSession.body.devCode },
  });
  check(financeLogin.status === 200, `finance login returned ${financeLogin.status}`);
  check(financeLogin.body.user.roles.includes('finance'), 'the finance role was not granted');
  const financeToken = financeLogin.body.tokens.accessToken;

  // --- a finance credit ---------------------------------------------------
  const rejectedAmount = await call(`/admin/wallets/${owner.userId}/credit`, {
    method: 'POST',
    token: financeToken,
    body: { amountMinor: '-100', reason: 'A negative credit should be refused' },
  });
  check(rejectedAmount.status === 400, `a negative amount returned ${rejectedAmount.status}`);

  const noReason = await call(`/admin/wallets/${owner.userId}/credit`, {
    method: 'POST',
    token: financeToken,
    body: { amountMinor: '100', reason: 'short' },
  });
  check(noReason.status === 400, `an unexplained adjustment returned ${noReason.status}`);

  const key = `smoke-credit-${Date.now()}`;
  const credited = await call(`/admin/wallets/${owner.userId}/credit`, {
    method: 'POST',
    token: financeToken,
    idempotencyKey: key,
    body: { amountMinor: '250000', reason: 'Smoke test opening balance' },
  });
  check(credited.status === 201, `credit returned ${credited.status}: ${credited.raw}`);
  check(credited.body.balanceAfterMinor === '250000', `balance after was ${credited.body.balanceAfterMinor}`);
  check(credited.body.replayed === false, 'a first credit reported itself as a replay');
  console.log('smoke-wallet: finance credits the wallet');

  // The same key again must not double the balance.
  const replayed = await call(`/admin/wallets/${owner.userId}/credit`, {
    method: 'POST',
    token: financeToken,
    idempotencyKey: key,
    body: { amountMinor: '250000', reason: 'Smoke test opening balance' },
  });
  check(replayed.status === 200, `a replayed credit returned ${replayed.status}`);
  check(replayed.body.replayed === true, 'a replayed credit was applied again');
  check(replayed.body.entryId === credited.body.entryId, 'a replay produced a second entry');

  const conflicting = await call(`/admin/wallets/${owner.userId}/credit`, {
    method: 'POST',
    token: financeToken,
    idempotencyKey: key,
    body: { amountMinor: '999', reason: 'Same key, different amount' },
  });
  check(conflicting.status === 409, `a reused key with new details returned ${conflicting.status}`);
  check(
    conflicting.body.error.details.walletError === 'IDEMPOTENCY_CONFLICT',
    'a reused key did not report IDEMPOTENCY_CONFLICT',
  );
  console.log('smoke-wallet: a retried adjustment applies once; a reused key is refused');

  const afterCredit = await call('/me/wallet', { token: owner.token });
  check(afterCredit.body.availableMinor === '250000', 'the owner saw the wrong balance');

  // --- a finance debit and the overdraw refusal ---------------------------
  const debited = await call(`/admin/wallets/${owner.userId}/debit`, {
    method: 'POST',
    token: financeToken,
    body: { amountMinor: '50000', reason: 'Smoke test correction' },
  });
  check(debited.status === 201, `debit returned ${debited.status}: ${debited.raw}`);
  check(debited.body.balanceAfterMinor === '200000', `balance after was ${debited.body.balanceAfterMinor}`);
  check(debited.body.amountMinor === '-50000', 'a debit was not recorded as negative');

  const overdraw = await call(`/admin/wallets/${owner.userId}/debit`, {
    method: 'POST',
    token: financeToken,
    body: { amountMinor: '200001', reason: 'Smoke test overdraw attempt' },
  });
  check(overdraw.status === 422, `an overdraw returned ${overdraw.status}`);
  check(
    overdraw.body.error.details.walletError === 'INSUFFICIENT_FUNDS',
    'an overdraw did not report INSUFFICIENT_FUNDS',
  );
  check(!overdraw.raw.includes('200000'), 'the refusal disclosed the balance');
  console.log('smoke-wallet: a debit is refused rather than overdrawing');

  // --- transactions and pagination ---------------------------------------
  const page = await call('/me/wallet/transactions?limit=1', { token: owner.token });
  check(page.status === 200, `transactions returned ${page.status}`);
  check(page.body.entries.length === 1, `a limit of 1 returned ${page.body.entries.length}`);
  check(page.body.nextCursor !== null, 'a full first page offered no cursor');
  check(page.body.entries[0].type === 'admin_debit', 'the newest entry was not the debit');
  check(/"amountMinor":"-50000"/.test(page.raw), `entry amount was not serialised as a string: ${page.raw}`);

  const next = await call(
    `/me/wallet/transactions?limit=1&cursor=${encodeURIComponent(page.body.nextCursor)}`,
    {
      token: owner.token,
    },
  );
  check(next.status === 200, `the second page returned ${next.status}`);
  check(next.body.entries[0].type === 'admin_credit', 'the second page was not the credit');
  check(next.body.entries[0].id !== page.body.entries[0].id, 'the second page repeated an entry');
  check(next.body.nextCursor === null, 'the last page offered another');

  const badCursor = await call('/me/wallet/transactions?cursor=not-a-cursor', { token: owner.token });
  check(badCursor.status === 400, `a malformed cursor returned ${badCursor.status}`);
  console.log('smoke-wallet: the ledger pages without repeating or skipping');

  // --- freeze and unfreeze ------------------------------------------------
  const frozen = await call(`/admin/wallets/${owner.userId}/freeze`, {
    method: 'POST',
    token: financeToken,
    body: { reason: 'Smoke test fraud review' },
  });
  check(frozen.status === 200, `freeze returned ${frozen.status}: ${frozen.raw}`);
  check(frozen.body.frozen === true, 'the wallet did not report itself frozen');

  const blockedDebit = await call(`/admin/wallets/${owner.userId}/debit`, {
    method: 'POST',
    token: financeToken,
    body: { amountMinor: '100', reason: 'Debit against a frozen wallet' },
  });
  check(blockedDebit.status === 403, `a debit on a frozen wallet returned ${blockedDebit.status}`);
  check(
    blockedDebit.body.error.details.walletError === 'WALLET_FROZEN',
    'a frozen debit did not report WALLET_FROZEN',
  );

  // Credits and reads must still work while frozen.
  const frozenCredit = await call(`/admin/wallets/${owner.userId}/credit`, {
    method: 'POST',
    token: financeToken,
    body: { amountMinor: '1000', reason: 'A credit into a frozen wallet' },
  });
  check(frozenCredit.status === 201, `a credit into a frozen wallet returned ${frozenCredit.status}`);

  const ownerViewFrozen = await call('/me/wallet', { token: owner.token });
  check(ownerViewFrozen.body.frozen === true, 'the owner could not see the freeze');
  check(ownerViewFrozen.body.frozenReason === 'Smoke test fraud review', 'the freeze reason was lost');
  check(ownerViewFrozen.body.availableMinor === '201000', 'the frozen wallet balance was wrong');

  // The account itself must not be suspended: a freeze is a financial control.
  const stillSignedIn = await call('/me', { token: owner.token });
  check(stillSignedIn.status === 200, 'a wallet freeze locked the owner out of their account');
  const { rows } = await db.query(`SELECT status FROM users WHERE id = $1`, [owner.userId]);
  check(rows[0].status === 'active', `the freeze changed users.status to ${rows[0].status}`);
  console.log('smoke-wallet: a freeze stops debits only, and does not suspend the account');

  const thawed = await call(`/admin/wallets/${owner.userId}/unfreeze`, {
    method: 'POST',
    token: financeToken,
    body: { reason: 'Smoke test review completed' },
  });
  check(thawed.status === 200, `unfreeze returned ${thawed.status}`);
  check(thawed.body.frozen === false, 'the wallet stayed frozen');

  const allowedAgain = await call(`/admin/wallets/${owner.userId}/debit`, {
    method: 'POST',
    token: financeToken,
    body: { amountMinor: '1000', reason: 'Debit after unfreezing' },
  });
  check(allowedAgain.status === 201, `a debit after unfreezing returned ${allowedAgain.status}`);
  console.log('smoke-wallet: unfreezing restores debits');

  // --- reconciliation -----------------------------------------------------
  const report = await call(`/admin/wallets/${owner.userId}/reconciliation`, { token: financeToken });
  check(report.status === 200, `reconciliation returned ${report.status}`);
  check(report.body.consistent === true, `the wallet reconciled as inconsistent: ${report.raw}`);
  check(report.body.driftMinor === '0', `drift was ${report.body.driftMinor}`);
  check(report.body.runningBalanceBreaks === 0, 'the replay disagreed with a recorded balance');
  check(report.body.sequenceGaps === 0, 'the ledger had a sequence gap');
  check(report.body.cachedTotalMinor === report.body.ledgerTotalMinor, 'the cache left the ledger');

  const ownerReport = await call(`/admin/wallets/${owner.userId}/reconciliation`, { token: owner.token });
  check(ownerReport.status === 403, `an ordinary user's reconciliation read returned ${ownerReport.status}`);

  // Break it deliberately, and confirm the report detects and does not repair.
  await db.query(`UPDATE wallets SET available_minor = available_minor - 1 WHERE user_id = $1`, [
    owner.userId,
  ]);
  const broken = await call(`/admin/wallets/${owner.userId}/reconciliation`, { token: financeToken });
  check(broken.body.consistent === false, 'a tampered balance reconciled as consistent');
  check(broken.body.driftMinor === '1', `drift was ${broken.body.driftMinor}, expected 1`);

  const afterReport = await call(`/admin/wallets/${owner.userId}/reconciliation`, { token: financeToken });
  check(
    afterReport.body.cachedTotalMinor === broken.body.cachedTotalMinor,
    'reconciliation repaired the balance instead of reporting it',
  );
  console.log('smoke-wallet: reconciliation detects a discrepancy and leaves it alone');

  // --- an unknown wallet --------------------------------------------------
  const missing = await call('/admin/wallets/00000000-0000-4000-8000-000000000000/reconciliation', {
    token: financeToken,
  });
  check(missing.status === 404, `an unknown wallet returned ${missing.status}`);

  console.log('smoke-wallet: OK');
  stop();
  process.exit(0);
}

main().catch((error) => fail(error instanceof Error ? (error.stack ?? error.message) : String(error)));
