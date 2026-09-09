#!/usr/bin/env node
/**
 * End-to-end verification of the Phase 2 HTTP surface.
 *
 * Boots the built API and drives the real endpoints over HTTP: register, verify,
 * refresh with rotation, reuse detection, password login, /me, Telegram link,
 * and authorization. Anything the services get right but the channel wires up
 * wrongly shows here and nowhere else.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';
import { loadEnvFile } from './load-env.mjs';

await loadEnvFile();

const PORT = Number(process.env.SMOKE_PORT ?? 4300);
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

const stop = () => {
  if (!exited) child.kill('SIGTERM');
};
const fail = (message) => {
  console.error(`smoke-auth: ${message}`);
  stop();
  process.exit(1);
};
const check = (condition, message) => {
  if (!condition) fail(message);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : JSON.parse(text) };
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

const phone = `+25199${String(Date.now() % 100_000).padStart(5, '0')}9`;

async function main() {
  await waitForBoot();
  console.log('smoke-auth: API is live');

  // --- registration -------------------------------------------------------
  const registered = await call('/auth/register', {
    method: 'POST',
    body: { phone, displayName: 'Smoke Test' },
  });
  check(registered.status === 202, `register returned ${registered.status}`);
  check(registered.body.otpSent === true, 'register did not report otpSent');
  const code = registered.body.devCode;
  check(/^\d{6}$/.test(code ?? ''), 'register did not return a development code');
  console.log('smoke-auth: registered, code issued');

  // A wrong code must be refused.
  const wrong = await call('/auth/verify-phone', {
    method: 'POST',
    body: { phone, code: code === '000000' ? '111111' : '000000' },
  });
  check(wrong.status === 400, `wrong code returned ${wrong.status}, expected 400`);
  check(wrong.body.error.code === 'VALIDATION_FAILED', 'wrong code had an unexpected error code');

  // --- verification -------------------------------------------------------
  const verified = await call('/auth/verify-phone', { method: 'POST', body: { phone, code } });
  check(verified.status === 200, `verify-phone returned ${verified.status}`);
  check(verified.body.user.status === 'active', 'user was not activated');
  check(verified.body.user.roles.includes('user'), 'user role was not granted');
  check(!('passwordHash' in verified.body.user), 'password hash leaked into the response');
  const { accessToken, refreshToken } = verified.body.tokens;
  console.log('smoke-auth: phone verified, session issued');

  // --- authenticated identity --------------------------------------------
  const unauthenticated = await call('/me');
  check(unauthenticated.status === 401, `/me without a token returned ${unauthenticated.status}`);

  const me = await call('/me', { token: accessToken });
  check(me.status === 200, `/me returned ${me.status}`);
  check(me.body.id === verified.body.user.id, '/me returned a different identity');
  check(me.body.phone === phone, '/me returned the wrong phone');
  console.log('smoke-auth: /me resolves the authenticated identity');

  // --- refresh rotation and reuse detection -------------------------------
  const rotated = await call('/auth/refresh', { method: 'POST', body: { refreshToken } });
  check(rotated.status === 200, `refresh returned ${rotated.status}`);
  check(
    rotated.body.tokens.refreshToken !== refreshToken,
    'refresh returned the same token instead of rotating',
  );

  const replayed = await call('/auth/refresh', { method: 'POST', body: { refreshToken } });
  check(replayed.status === 401, `replayed refresh token returned ${replayed.status}`);

  const afterReuse = await call('/auth/refresh', {
    method: 'POST',
    body: { refreshToken: rotated.body.tokens.refreshToken },
  });
  check(afterReuse.status === 401, 'reuse did not revoke the rest of the family');
  console.log('smoke-auth: rotation works and reuse revokes the family');

  // --- password login -----------------------------------------------------
  const relogin = await call('/auth/login', {
    method: 'POST',
    body: { method: 'otp_request', phone },
  });
  check(relogin.status === 202, `otp_request returned ${relogin.status}`);
  const loginCode = relogin.body.devCode;

  const loggedIn = await call('/auth/login', {
    method: 'POST',
    body: { method: 'otp', phone, code: loginCode },
  });
  check(loggedIn.status === 200, `otp login returned ${loggedIn.status}`);
  const sessionToken = loggedIn.body.tokens.accessToken;

  const passwordSet = await call('/auth/change-password', {
    method: 'POST',
    body: { newPassword: 'a-smoke-test-password' },
    token: sessionToken,
  });
  check(passwordSet.status === 204, `change-password returned ${passwordSet.status}`);

  const byPassword = await call('/auth/login', {
    method: 'POST',
    body: { method: 'password', phone, password: 'a-smoke-test-password' },
  });
  check(byPassword.status === 200, `password login returned ${byPassword.status}`);

  const badPassword = await call('/auth/login', {
    method: 'POST',
    body: { method: 'password', phone, password: 'not-the-password' },
  });
  check(badPassword.status === 401, `wrong password returned ${badPassword.status}`);
  console.log('smoke-auth: password set and used, wrong password refused');

  // --- account enumeration ------------------------------------------------
  const unknownPhone = await call('/auth/login', {
    method: 'POST',
    body: { method: 'password', phone: '+251999999998', password: 'not-the-password' },
  });
  check(
    unknownPhone.status === badPassword.status &&
      unknownPhone.body.error.message === badPassword.body.error.message,
    'an unknown account is distinguishable from a wrong password',
  );
  console.log('smoke-auth: unknown accounts are indistinguishable from wrong passwords');

  // --- telegram linking ---------------------------------------------------
  const token = byPassword.body.tokens.accessToken;
  const status = await call('/me/telegram/status', { token });
  check(status.status === 200 && status.body.linked === false, 'telegram status was not unlinked');

  const link = await call('/me/telegram/link', { method: 'POST', token });
  check(link.status === 201, `telegram link returned ${link.status}`);
  check(
    /^https:\/\/t\.me\/.+\?start=link_/.test(link.body.deepLink),
    `deep link has an unexpected shape: ${link.body.deepLink}`,
  );
  check(!link.body.deepLink.includes(token), 'the deep link leaked the access token');
  console.log('smoke-auth: telegram deep link issued');

  // --- validation and logout ----------------------------------------------
  const malformed = await call('/auth/register', {
    method: 'POST',
    body: { phone: '0911223344', displayName: 'Bad phone' },
  });
  check(malformed.status === 400, `non-E.164 phone returned ${malformed.status}`);

  const loggedOut = await call('/auth/logout', {
    method: 'POST',
    body: { refreshToken: byPassword.body.tokens.refreshToken },
    token,
  });
  check(loggedOut.status === 204, `logout returned ${loggedOut.status}`);

  const afterLogout = await call('/auth/refresh', {
    method: 'POST',
    body: { refreshToken: byPassword.body.tokens.refreshToken },
  });
  check(afterLogout.status === 401, 'refresh still worked after logout');

  const meAfterLogout = await call('/me', { token });
  check(meAfterLogout.status === 401, 'the access token still worked after logout');
  console.log('smoke-auth: logout revokes the session immediately');

  console.log('smoke-auth: OK');
  stop();
  process.exit(0);
}

main().catch((error) => fail(error instanceof Error ? (error.stack ?? error.message) : String(error)));
