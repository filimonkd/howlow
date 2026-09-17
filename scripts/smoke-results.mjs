#!/usr/bin/env node
/**
 * End-to-end verification of LUB_V1 and auction closing.
 *
 * ## What makes this different from the test suites
 *
 * `tests/db/results.test.ts` proves the algorithm and the transaction by
 * calling the services. This proves the **whole machine**: a real API process,
 * a real worker process, real bids placed over HTTP and through the Telegram
 * webhook, and auctions decided by the worker's own sweeper on its own
 * schedule. Nothing here calls `calculateLubV1`, `closeAuction` or even
 * `runClose` — the script creates auctions whose deadlines have passed and
 * waits for production code to notice.
 *
 * That distinction has earned its keep. Every phase of this project has had
 * defects that only a running system showed: a router-level `authenticate`
 * that broke public browsing, a missing bearer token, a connection-pool
 * deadlock, wallet refusals arriving without the code clients branch on. A
 * calculator that is right while the worker never runs it is worth nothing.
 *
 * ## The three outcomes
 *
 *   winner         1x2, 2x1, 3x2 → the winner is 2, and it is *not* the
 *                  lowest bid. One order awaiting payment, the unit kept,
 *                  no fees returned.
 *   no_unique_bid  every amount bid twice → nobody wins, the unit goes back,
 *                  every fee comes back.
 *   no_bids        nobody bid → no order, the unit goes back, and the result
 *                  still carries the checksum of the empty set.
 *
 * All three are created before the worker starts, so one sweep decides them
 * together and the run does not take three sweeps' worth of waiting.
 *
 * Then both channels are driven against the decided auctions: the public
 * result endpoint, the caller's own outcome for the winner and for a loser,
 * and the Telegram result message.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import process from 'node:process';
import pg from 'pg';
import { clearRateLimits } from './clear-rate-limits.mjs';
import { loadEnvFile } from './load-env.mjs';

await loadEnvFile();
// Registration is limited per IP and every smoke script comes from 127.0.0.1.
await clearRateLimits();

const PORT = Number(process.env.SMOKE_PORT ?? 4306);
const TELEGRAM_STUB_PORT = Number(process.env.SMOKE_TELEGRAM_PORT ?? 4307);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const WEBHOOK = `http://127.0.0.1:${PORT}/telegram/webhook`;
const BOOT_TIMEOUT_MS = 30_000;
/** Two sweeper intervals plus slack: the sweep runs every 30 seconds. */
const CLOSE_TIMEOUT_MS = 90_000;
const WEBHOOK_SECRET = 'smoke-results-webhook-secret-value';

/** Slugs are globally unique, so each run needs its own prefix. */
const RUN_TAG = Date.now().toString(36);

/** SHA-256 of the empty string: the checksum of an auction with no valid bids. */
const EMPTY_CHECKSUM = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// --- A stub Bot API, so the bot's outbound messages can be asserted ---------
/** @type {{ method: string, body: unknown }[]} */
const sent = [];

const telegramStub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    const method = (req.url ?? '').split('/').pop() ?? '';
    let body = {};
    try {
      body = raw === '' ? {} : JSON.parse(raw);
    } catch {
      body = { unparsed: raw };
    }
    sent.push({ method, body });
    const result =
      method === 'getMe'
        ? { id: 43, is_bot: true, first_name: 'HOWLOW Results', username: 'howlow_results_bot' }
        : method === 'answerCallbackQuery'
          ? true
          : {
              message_id: sent.length,
              date: Math.floor(Date.now() / 1000),
              chat: { id: 1, type: 'private' },
            };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result }));
  });
});
await new Promise((resolve) => telegramStub.listen(TELEGRAM_STUB_PORT, resolve));

const childEnv = {
  ...process.env,
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
  NODE_ENV: 'development',
  TELEGRAM_ENABLED: 'true',
  TELEGRAM_BOT_TOKEN: '43:smoke-token',
  TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
  TELEGRAM_BOT_USERNAME: 'howlow_results_bot',
  TELEGRAM_API_ROOT: `http://127.0.0.1:${TELEGRAM_STUB_PORT}`,
};

const api = spawn(process.execPath, ['apps/api/dist/index.js'], {
  env: { ...childEnv, PORT: String(PORT) },
  stdio: ['ignore', 'inherit', 'inherit'],
});

/** The worker is started later, once the auctions to decide already exist. */
let worker;
let apiExited = false;
api.on('exit', (code) => {
  apiExited = true;
  if (code !== 0) {
    console.error(`API exited early with code ${code}`);
    process.exit(1);
  }
});

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

const stop = () => {
  if (!apiExited) api.kill('SIGTERM');
  if (worker !== undefined) worker.kill('SIGTERM');
  telegramStub.close();
  void db.end().catch(() => undefined);
};
const fail = (message) => {
  console.error(`smoke-results: ${message}`);
  stop();
  process.exit(1);
};
const check = (condition, message) => {
  if (!condition) fail(message);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(path, { method = 'GET', body, token, headers = {} } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, raw: text, body: text === '' ? null : JSON.parse(text) };
}

const submitBids = (reference, amountsMinor, { token, key }) =>
  call(`/auctions/${reference}/bids`, {
    method: 'POST',
    body: { amountsMinor },
    token,
    headers: { 'Idempotency-Key': key },
  });

// --- Telegram plumbing ------------------------------------------------------
let updateId = 9000;
async function deliverUpdate(update) {
  const response = await fetch(WEBHOOK, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-telegram-bot-api-secret-token': WEBHOOK_SECRET,
    },
    body: JSON.stringify({ update_id: (updateId += 1), ...update }),
  });
  // grammY answers the webhook before its own outbound calls settle.
  await sleep(400);
  return response.status;
}

/** Unique platform-wide, so it is derived from the clock rather than fixed. */
const TELEGRAM_ID = 810_000_000_000 + (Date.now() % 1_000_000_000);
const TELEGRAM_USER = {
  id: TELEGRAM_ID,
  is_bot: false,
  first_name: 'Result Reader',
  username: `smoke_results_${RUN_TAG}`,
};
const CHAT = { id: TELEGRAM_ID, type: 'private' };

const callbackQuery = (data) => ({
  callback_query: {
    id: String(updateId),
    from: TELEGRAM_USER,
    chat_instance: 'smoke',
    data,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: CHAT,
      from: { id: 43, is_bot: true, first_name: 'HOWLOW Results' },
      text: 'previous',
    },
  },
});

const lastSent = (method) => {
  for (let index = sent.length - 1; index >= 0; index -= 1) {
    if (sent[index].method === method) return sent[index].body;
  }
  return undefined;
};
const lastText = () => String(lastSent('sendMessage')?.text ?? '');
const lastKeyboard = () => JSON.stringify(lastSent('sendMessage')?.reply_markup ?? {});

async function waitForBoot() {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/health/live`)).ok) return;
    } catch {
      /* not listening yet */
    }
    await sleep(250);
  }
  fail(`API did not become live within ${BOOT_TIMEOUT_MS}ms`);
}

const uniquePhone = (suffix) => `+25197${String(Date.now() % 1_000_000).padStart(6, '0')}${suffix}`;

async function newAccount(displayName, suffix) {
  const phone = uniquePhone(suffix);
  const registered = await call('/auth/register', { method: 'POST', body: { phone, displayName } });
  check(registered.status === 202, `register returned ${registered.status}: ${registered.raw}`);
  const verified = await call('/auth/verify-phone', {
    method: 'POST',
    body: { phone, code: registered.body.devCode },
  });
  check(verified.status === 200, `verify-phone returned ${verified.status}`);
  return { phone, userId: verified.body.user.id, token: verified.body.tokens.accessToken };
}

/**
 * A live auction with a future deadline, so the real endpoint will take bids.
 *
 * Written straight to the database because scheduling is Phase 4's subject and
 * the lifecycle correctly refuses to open an auction before its start time.
 * The inventory reservation is created too: a live auction holding no unit is
 * an inconsistency the engine deliberately refuses to bid on, and the closing
 * path has to have a real unit to keep or release.
 *
 * Amounts run 1..100 in steps of 1, so the figures in this script are the
 * figures the specification's fixtures name.
 */
async function createLiveAuction(label) {
  const tag = `${RUN_TAG}-${label}`;
  const { rows: category } = await db.query(
    `INSERT INTO categories (slug, name) VALUES ($1, 'Results smoke') RETURNING id`,
    [`res-cat-${tag}`],
  );
  const { rows: sellerUser } = await db.query(
    `INSERT INTO users (display_name, phone, status, phone_verified_at)
     VALUES ('Result Smoke Seller', $1, 'active', now()) RETURNING id`,
    [uniquePhone(String(label.length))],
  );
  const { rows: seller } = await db.query(
    `INSERT INTO sellers (user_id, display_name, status, approved_at)
     VALUES ($1, 'Result Smoke Shop', 'approved', now()) RETURNING id`,
    [sellerUser[0].id],
  );
  const { rows: product } = await db.query(
    `INSERT INTO products (seller_id, category_id, slug, title, description,
       retail_price_minor, stock_quantity, status)
     VALUES ($1, $2, $3, 'Result Smoke Product',
       'A product description long enough to satisfy the service validation rules.',
       2500000, 1, 'active') RETURNING id`,
    [seller[0].id, category[0].id, `res-prod-${tag}`],
  );
  const { rows: auction } = await db.query(
    `INSERT INTO auctions (product_id, seller_id, slug, title, description, currency,
       bid_fee_minor, min_bid_minor, max_bid_minor, bid_increment_minor,
       max_bids_per_user, winner_payment_hours, starts_at, ends_at, status, opened_at)
     VALUES ($1, $2, $3, 'Result Smoke Auction',
       'An auction description long enough to satisfy the service validation rules.',
       'ETB', 500, 1, 100, 1, 50, 48,
       now() - interval '30 minutes', now() + interval '2 hours', 'live', now())
     RETURNING id, slug`,
    [product[0].id, seller[0].id, `res-auc-${tag}`],
  );
  await db.query(
    `INSERT INTO inventory_reservations (product_id, auction_id, quantity, state)
     VALUES ($1, $2, 1, 'held')`,
    [product[0].id, auction[0].id],
  );
  await db.query(`UPDATE products SET reserved_quantity = 1 WHERE id = $1`, [product[0].id]);
  return { auctionId: auction[0].id, slug: auction[0].slug, productId: product[0].id };
}

/**
 * Move an auction's deadline into the past.
 *
 * `ends_at` is a protected term once an auction is live and the Phase 4
 * trigger refuses to change it — correctly, since a seller must not be able to
 * extend or curtail an auction people are bidding in. So this drops to
 * `session_replication_role = 'replica'` for one statement, the same test-only
 * escape hatch the database fixtures use. It is what lets the bids be placed
 * through the real engine while the auction is genuinely open, and the
 * deadline pass afterwards.
 */
async function expireAuction(auctionId) {
  await db.query('BEGIN');
  try {
    await db.query("SET LOCAL session_replication_role = 'replica'");
    await db.query(`UPDATE auctions SET ends_at = now() - interval '5 seconds' WHERE id = $1`, [auctionId]);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function fundWallet(userId, minor) {
  await db.query(
    `INSERT INTO wallets (user_id, currency, available_minor) VALUES ($1, 'ETB', $2)
     ON CONFLICT (user_id, currency) DO UPDATE SET available_minor = $2`,
    [userId, minor],
  );
}

const walletBalance = async (userId) => {
  const { rows } = await db.query(`SELECT available_minor FROM wallets WHERE user_id = $1`, [userId]);
  return BigInt(rows[0]?.available_minor ?? '0');
};

const resultRow = async (auctionId) => {
  const { rows } = await db.query(
    `SELECT outcome, algorithm_version, winner_user_id, winning_amount_minor,
            total_bids, total_valid_bids, unique_amount_count, participant_count,
            frozen_bid_checksum
       FROM auction_results WHERE auction_id = $1`,
    [auctionId],
  );
  return rows[0];
};

/**
 * Wait for the worker's own sweeper to decide these auctions.
 *
 * Polls the database, because that is where the answer is. Nothing here
 * enqueues a job, calls a service or nudges the worker: the whole point is that
 * production code notices an auction whose deadline has passed.
 */
async function waitForResults(auctionIds) {
  const deadline = Date.now() + CLOSE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { rows } = await db.query(
      `SELECT count(*) AS n FROM auction_results WHERE auction_id = ANY($1::uuid[])`,
      [auctionIds],
    );
    if (Number(rows[0].n) === auctionIds.length) return Date.now();
    await sleep(1000);
  }
  const { rows } = await db.query(`SELECT id, status FROM auctions WHERE id = ANY($1::uuid[])`, [auctionIds]);
  fail(
    `the worker did not decide all ${auctionIds.length} auctions within ${CLOSE_TIMEOUT_MS}ms: ` +
      rows.map((row) => `${row.id}=${row.status}`).join(', '),
  );
}

async function main() {
  await waitForBoot();
  await db.connect();
  console.log('smoke-results: API is live');

  // --- three auctions, bids placed through the real channels ---------------
  const winnerAuction = await createLiveAuction('win');
  const tiedAuction = await createLiveAuction('tie');
  const emptyAuction = await createLiveAuction('none');

  const alice = await newAccount('Smoke Alice', '1');
  const bob = await newAccount('Smoke Bob', '2');
  await fundWallet(alice.userId, 200_000);
  await fundWallet(bob.userId, 200_000);

  // Link Bob's Telegram account directly: the link flow is Phase 2's subject
  // and has its own smoke test. What matters here is that a chat can read a
  // result, and that the personal half is addressed to the right account.
  await db.query(
    `INSERT INTO telegram_accounts (user_id, telegram_user_id, username, first_name, linked_at)
     VALUES ($1, $2, $3, 'Result Reader', now())`,
    [bob.userId, String(TELEGRAM_ID), TELEGRAM_USER.username],
  );

  // TEST 3 from the specification: 1x2, 2x1, 3x2. The winner is 2 — the
  // lowest amount is not unique, and the lowest unique amount is not the
  // highest one either. Alice takes 1, 2 and 3; Bob takes 1 and 3.
  const aliceBids = await submitBids(winnerAuction.slug, ['1', '2', '3'], {
    token: alice.token,
    key: `r-${RUN_TAG}-alice-win`,
  });
  check(aliceBids.status === 201, `Alice's bids returned ${aliceBids.status}: ${aliceBids.raw}`);
  const bobBids = await submitBids(winnerAuction.slug, ['1', '3'], {
    token: bob.token,
    key: `r-${RUN_TAG}-bob-win`,
  });
  check(bobBids.status === 201, `Bob's bids returned ${bobBids.status}: ${bobBids.raw}`);

  // Every amount bid twice, so nobody can win.
  for (const [account, key] of [
    [alice, 'alice-tie'],
    [bob, 'bob-tie'],
  ]) {
    const response = await submitBids(tiedAuction.slug, ['10', '11'], {
      token: account.token,
      key: `r-${RUN_TAG}-${key}`,
    });
    check(response.status === 201, `a tied-auction bid returned ${response.status}: ${response.raw}`);
  }

  // `emptyAuction` gets nothing at all.
  console.log('smoke-results: bids placed over HTTP against three auctions');

  const aliceBefore = await walletBalance(alice.userId);
  const bobBefore = await walletBalance(bob.userId);

  // --- nothing may be readable before the close ---------------------------
  const early = await call(`/auctions/${winnerAuction.slug}/result`);
  check(early.status === 404, `a running auction's result returned ${early.status}, expected 404`);
  check(
    early.body?.error?.details?.resultError === 'RESULT_NOT_FOUND',
    `a running auction gave resultError ${early.body?.error?.details?.resultError}`,
  );
  const earlyMine = await call(`/auctions/${winnerAuction.slug}/result/me`, { token: alice.token });
  check(earlyMine.status === 404, `a running auction's own-outcome returned ${earlyMine.status}`);
  console.log('smoke-results: a running auction has no result to read');

  // --- let the deadlines pass, then start the worker -----------------------
  for (const auction of [winnerAuction, tiedAuction, emptyAuction]) {
    await expireAuction(auction.auctionId);
  }

  worker = spawn(process.execPath, ['apps/worker/dist/index.js'], {
    env: childEnv,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  worker.on('exit', (code) => {
    if (code !== 0 && code !== null) fail(`the worker exited early with code ${code}`);
  });
  console.log('smoke-results: worker started; waiting for its sweeper to decide three auctions');

  const startedWaiting = Date.now();
  await waitForResults([winnerAuction.auctionId, tiedAuction.auctionId, emptyAuction.auctionId]);
  console.log(`smoke-results: the worker decided all three in ${String(Date.now() - startedWaiting)}ms`);

  // --- the winning auction -------------------------------------------------
  const win = await resultRow(winnerAuction.auctionId);
  check(win.outcome === 'winner', `the winning auction's outcome was ${win.outcome}`);
  check(win.algorithm_version === 'LUB_V1', `algorithm was ${win.algorithm_version}`);
  // **The product rule.** 1 was bid twice and 2 once, so 2 wins and 1 loses.
  check(
    win.winning_amount_minor === '2',
    `the winning amount was ${win.winning_amount_minor}, expected 2 — the lowest UNIQUE amount`,
  );
  check(win.winner_user_id === alice.userId, `the winner was ${win.winner_user_id}, expected Alice`);
  check(win.total_valid_bids === 5, `total_valid_bids was ${String(win.total_valid_bids)}, expected 5`);
  check(win.participant_count === 2, `participant_count was ${String(win.participant_count)}`);
  check(win.unique_amount_count === 1, `unique_amount_count was ${String(win.unique_amount_count)}`);
  check(/^[0-9a-f]{64}$/.test(win.frozen_bid_checksum), `checksum was ${win.frozen_bid_checksum}`);

  const { rows: orders } = await db.query(
    `SELECT id, order_number, user_id, status, total_minor, payment_due_at, placed_at
       FROM orders WHERE auction_id = $1`,
    [winnerAuction.auctionId],
  );
  check(orders.length === 1, `the won auction produced ${String(orders.length)} orders, expected 1`);
  check(orders[0].user_id === alice.userId, `the order belongs to ${orders[0].user_id}, not the winner`);
  check(orders[0].status === 'pending_payment', `the order status was ${orders[0].status}`);
  check(orders[0].total_minor === '2', `the order is for ${orders[0].total_minor}, expected 2`);
  check(orders[0].payment_due_at !== null, 'the order carries no payment deadline');
  const windowHours =
    (new Date(orders[0].payment_due_at).getTime() - new Date(orders[0].placed_at).getTime()) / 3_600_000;
  check(Math.abs(windowHours - 48) < 0.01, `the payment window was ${windowHours.toFixed(2)}h, expected 48`);
  check(/^HL-\d{4}-\d{6,}$/.test(orders[0].order_number), `order number was ${orders[0].order_number}`);

  // The winner keeps the unit: it is owed to them.
  const { rows: heldUnit } = await db.query(
    `SELECT r.state, p.reserved_quantity FROM inventory_reservations r
       JOIN products p ON p.id = r.product_id WHERE r.auction_id = $1`,
    [winnerAuction.auctionId],
  );
  check(heldUnit[0].state === 'held', `a won auction released its unit (${heldUnit[0].state})`);
  check(
    heldUnit[0].reserved_quantity === 1,
    `reserved_quantity was ${String(heldUnit[0].reserved_quantity)}`,
  );

  // Nothing was charged and nothing was refunded: the fees bought a chance,
  // and the auction ran.
  const { rows: winRefunds } = await db.query(
    `SELECT count(*) AS n FROM wallet_entries
      WHERE entry_type = 'bid_fee_refund' AND reference_type = 'auction' AND reference_id = $1`,
    [winnerAuction.auctionId],
  );
  check(winRefunds[0].n === '0', `a won auction refunded ${winRefunds[0].n} fees`);
  console.log('smoke-results: the winner is the lowest UNIQUE amount, with one pending-payment order');

  // --- no unique bid -------------------------------------------------------
  const tie = await resultRow(tiedAuction.auctionId);
  check(tie.outcome === 'no_unique_bid', `the tied auction's outcome was ${tie.outcome}`);
  check(tie.winning_amount_minor === null, `a no-winner auction named amount ${tie.winning_amount_minor}`);
  check(tie.winner_user_id === null, 'a no-winner auction named a winner');
  check(tie.unique_amount_count === 0, `unique_amount_count was ${String(tie.unique_amount_count)}`);

  const { rows: tieOrders } = await db.query(`SELECT count(*) AS n FROM orders WHERE auction_id = $1`, [
    tiedAuction.auctionId,
  ]);
  check(tieOrders[0].n === '0', `a no-winner auction created ${tieOrders[0].n} orders`);

  const { rows: tieUnit } = await db.query(
    `SELECT r.state, p.reserved_quantity FROM inventory_reservations r
       JOIN products p ON p.id = r.product_id WHERE r.auction_id = $1`,
    [tiedAuction.auctionId],
  );
  check(tieUnit[0].state === 'released', `a no-winner auction kept its unit (${tieUnit[0].state})`);
  check(tieUnit[0].reserved_quantity === 0, `reserved_quantity was ${String(tieUnit[0].reserved_quantity)}`);

  // Both bidders paid 2 x 500 into the tied auction and get all of it back.
  const { rows: tieRefunds } = await db.query(
    `SELECT user_id, amount_minor, idempotency_key FROM wallet_entries
      WHERE entry_type = 'bid_fee_refund' AND reference_type = 'auction' AND reference_id = $1
      ORDER BY user_id`,
    [tiedAuction.auctionId],
  );
  check(tieRefunds.length === 2, `a no-winner auction booked ${String(tieRefunds.length)} refunds`);
  for (const refund of tieRefunds) {
    check(refund.amount_minor === '1000', `a refund was ${refund.amount_minor}, expected 1000`);
    check(
      refund.idempotency_key === `auction-refund:${tiedAuction.auctionId}:${refund.user_id}`,
      `a refund carried key ${refund.idempotency_key}`,
    );
  }
  // Net effect on each wallet: the 1000 from the tied auction, and nothing
  // from the auction that produced a winner.
  check(
    (await walletBalance(alice.userId)) === aliceBefore + 1_000n,
    `Alice's balance moved by ${String((await walletBalance(alice.userId)) - aliceBefore)}, expected 1000`,
  );
  check(
    (await walletBalance(bob.userId)) === bobBefore + 1_000n,
    `Bob's balance moved by ${String((await walletBalance(bob.userId)) - bobBefore)}, expected 1000`,
  );
  console.log('smoke-results: no unique bid returned every fee and the unit');

  // --- no bids -------------------------------------------------------------
  const none = await resultRow(emptyAuction.auctionId);
  check(none.outcome === 'no_bids', `the empty auction's outcome was ${none.outcome}`);
  check(none.total_bids === 0, `an auction with no bids counted ${String(none.total_bids)}`);
  check(none.participant_count === 0, `participant_count was ${String(none.participant_count)}`);
  check(
    none.frozen_bid_checksum === EMPTY_CHECKSUM,
    `the empty-set checksum was ${none.frozen_bid_checksum}`,
  );
  const { rows: noneOrders } = await db.query(`SELECT count(*) AS n FROM orders WHERE auction_id = $1`, [
    emptyAuction.auctionId,
  ]);
  check(noneOrders[0].n === '0', `an auction with no bids created ${noneOrders[0].n} orders`);
  const { rows: noneUnit } = await db.query(
    `SELECT state FROM inventory_reservations WHERE auction_id = $1`,
    [emptyAuction.auctionId],
  );
  check(noneUnit[0].state === 'released', `an auction with no bids kept its unit (${noneUnit[0].state})`);
  console.log('smoke-results: no bids means no order, and the unit goes back');

  // --- every auction reached `completed` -----------------------------------
  const { rows: statuses } = await db.query(`SELECT id, status FROM auctions WHERE id = ANY($1::uuid[])`, [
    [winnerAuction.auctionId, tiedAuction.auctionId, emptyAuction.auctionId],
  ]);
  for (const row of statuses) {
    check(row.status === 'completed', `auction ${row.id} ended as ${row.status}, expected completed`);
  }

  // --- the sweeper keeps running, and must change nothing ------------------
  //
  // The worker sweeps every thirty seconds and these auctions are still there.
  // A second pass that produced a second result, a second order or a second
  // refund would be the failure this whole phase is built to prevent — so the
  // run waits for another sweep and re-counts rather than assuming.
  const beforeSecondSweep = JSON.stringify({ win, tie, none, orders: orders.length });
  await sleep(35_000);
  const { rows: recount } = await db.query(
    `SELECT (SELECT count(*) FROM auction_results WHERE auction_id = ANY($1::uuid[])) AS results,
            (SELECT count(*) FROM orders WHERE auction_id = ANY($1::uuid[])) AS orders,
            (SELECT count(*) FROM wallet_entries
              WHERE entry_type = 'bid_fee_refund' AND reference_type = 'auction'
                AND reference_id = ANY($1::uuid[])) AS refunds`,
    [[winnerAuction.auctionId, tiedAuction.auctionId, emptyAuction.auctionId]],
  );
  check(recount[0].results === '3', `after a second sweep there were ${recount[0].results} results`);
  check(recount[0].orders === '1', `after a second sweep there were ${recount[0].orders} orders`);
  check(recount[0].refunds === '2', `after a second sweep there were ${recount[0].refunds} refunds`);
  const afterSecondSweep = JSON.stringify({
    win: await resultRow(winnerAuction.auctionId),
    tie: await resultRow(tiedAuction.auctionId),
    none: await resultRow(emptyAuction.auctionId),
    orders: 1,
  });
  check(
    afterSecondSweep === beforeSecondSweep,
    'a second sweep changed a published result:\n' + beforeSecondSweep + '\n' + afterSecondSweep,
  );
  console.log('smoke-results: a second sweeper pass changed nothing at all');

  // --- the website surface -------------------------------------------------
  const published = await call(`/auctions/${winnerAuction.slug}/result`);
  check(published.status === 200, `the public result returned ${published.status}: ${published.raw}`);
  check(published.body.outcome === 'winner', `the public result said ${published.body.outcome}`);
  check(
    published.body.winningAmountMinor === '2',
    `the public amount was ${published.body.winningAmountMinor}`,
  );
  check(
    published.body.algorithmVersion === 'LUB_V1',
    `the public algorithm was ${published.body.algorithmVersion}`,
  );
  check(
    published.body.checksum === win.frozen_bid_checksum,
    'the published checksum differs from the stored one',
  );
  check(
    published.body.statistics.totalValidBids === 5,
    'the published statistics differ from the stored ones',
  );

  // **The disclosure rule, over the wire.** The public result may not name a
  // bidder — not the winner, not a loser.
  for (const [who, userId] of [
    ['the winner', alice.userId],
    ['a loser', bob.userId],
  ]) {
    check(!published.raw.includes(userId), `the public result named ${who} (${userId}): ${published.raw}`);
  }
  console.log('smoke-results: the public result publishes the amount and names nobody');

  const aliceOutcome = await call(`/auctions/${winnerAuction.slug}/result/me`, { token: alice.token });
  check(aliceOutcome.status === 200, `the winner's own outcome returned ${aliceOutcome.status}`);
  check(aliceOutcome.body.won === true, 'the winner was not told they won');
  check(aliceOutcome.body.order !== null, 'the winner was not given their order');
  check(
    aliceOutcome.body.order.status === 'pending_payment',
    `the order read ${aliceOutcome.body.order.status}`,
  );
  check(
    aliceOutcome.body.order.totalMinor === '2',
    `the order was for ${aliceOutcome.body.order.totalMinor}`,
  );
  check(aliceOutcome.body.bidCount === 3, `the winner placed ${String(aliceOutcome.body.bidCount)} bids`);
  check(aliceOutcome.body.feesPaidMinor === '1500', `the winner paid ${aliceOutcome.body.feesPaidMinor}`);
  check(
    aliceOutcome.body.refundedMinor === '0',
    `the winner was refunded ${aliceOutcome.body.refundedMinor}`,
  );

  const bobOutcome = await call(`/auctions/${winnerAuction.slug}/result/me`, { token: bob.token });
  check(bobOutcome.status === 200, `a loser's own outcome returned ${bobOutcome.status}`);
  check(bobOutcome.body.won === false, 'a loser was told they won');
  check(bobOutcome.body.order === null, 'a loser was given an order');
  check(
    bobOutcome.body.winningAmountMinor === '2',
    `a loser saw amount ${bobOutcome.body.winningAmountMinor}`,
  );
  check(bobOutcome.body.bidCount === 2, `a loser placed ${String(bobOutcome.body.bidCount)} bids`);
  // A loser's own view must not name the winner either.
  check(!bobOutcome.raw.includes(alice.userId), `a loser's outcome named the winner: ${bobOutcome.raw}`);
  console.log("smoke-results: each bidder is told their own outcome and nobody else's");

  const anonymous = await call(`/auctions/${winnerAuction.slug}/result/me`);
  check(anonymous.status === 401, `an unauthenticated own-outcome returned ${anonymous.status}`);

  // Public discovery still works: the result router shares the `/auctions`
  // mount, and a router-level `authenticate` there would break browsing.
  const detail = await call(`/auctions/${winnerAuction.slug}`);
  check(
    detail.status === 200,
    `public auction detail returned ${detail.status} — the result routes shadow it`,
  );
  const list = await call('/auctions');
  check(list.status === 200, `the public auction list returned ${list.status}`);
  console.log('smoke-results: mounting results under /auctions left public discovery alone');

  // --- the Telegram surface ------------------------------------------------
  //
  // Bob's chat, so the personal half is a loser's. Opening the auction must
  // offer its result rather than a dead bid button.
  check(
    (await deliverUpdate(callbackQuery(`a:${winnerAuction.auctionId}`))) === 200,
    'the auction callback was not accepted',
  );
  check(
    lastKeyboard().includes('See the result'),
    `the detail keyboard offered no result: ${lastKeyboard()}`,
  );
  check(
    lastKeyboard().includes(`ar:${winnerAuction.auctionId}`),
    'the result button carries the wrong payload',
  );
  check(!lastKeyboard().includes('Place a bid'), 'a decided auction still offered a bid button');

  check(
    (await deliverUpdate(callbackQuery(`ar:${winnerAuction.auctionId}`))) === 200,
    'the result callback was not accepted',
  );
  const resultText = lastText();
  check(resultText.includes('0.02 ETB'), `the bot did not show the winning amount: ${resultText}`);
  check(resultText.includes('LUB_V1'), 'the bot did not name the algorithm');
  check(resultText.includes(win.frozen_bid_checksum), 'the bot showed a different checksum');
  check(/did not win/i.test(resultText), `the bot did not tell the loser they lost: ${resultText}`);
  // The disclosure rule again, in the chat: no bidder id, and no winner named.
  for (const userId of [alice.userId, bob.userId]) {
    check(!resultText.includes(userId), `the bot's result message named a bidder: ${userId}`);
  }
  console.log('smoke-results: the bot shows the same result, and names no bidder');

  // The same chat, the same engine: a tied auction reads as no winner.
  check(
    (await deliverUpdate(callbackQuery(`ar:${tiedAuction.auctionId}`))) === 200,
    'the tied result callback was not accepted',
  );
  const tieText = lastText();
  check(/nobody won/i.test(tieText), `the bot did not report a no-winner auction: ${tieText}`);
  check(/returned/i.test(tieText), 'the bot did not mention the returned fees');
  check(!/\d+\.\d{2} ETB/.test(tieText.split('———')[1] ?? ''), 'a no-winner result showed a money amount');
  console.log('smoke-results: the bot reports a no-winner auction and the refund');

  // --- the result is reproducible -----------------------------------------
  //
  // The published checksum must be the digest of the bids that produced it.
  // Recomputed here in SQL, independently of the module that wrote it.
  const { rows: recomputed } = await db.query(
    `SELECT encode(digest(coalesce(string_agg(
              b.id::text || ':' || b.user_id::text || ':' || b.amount_minor::text,
              E'\\n' ORDER BY b.id), ''), 'sha256'), 'hex') AS checksum
       FROM bids b WHERE b.auction_id = $1 AND b.status = 'valid'`,
    [winnerAuction.auctionId],
  );
  check(
    recomputed[0].checksum === win.frozen_bid_checksum,
    `the checksum does not reproduce: stored ${win.frozen_bid_checksum}, recomputed ${recomputed[0].checksum}`,
  );
  console.log('smoke-results: the published checksum reproduces from the bids');

  // --- the audit trail ----------------------------------------------------
  const { rows: audited } = await db.query(
    `SELECT action FROM audit_logs WHERE entity_id = $1 ORDER BY created_at`,
    [winnerAuction.auctionId],
  );
  const actions = audited.map((row) => row.action);
  for (const required of [
    'auction.closing',
    'auction.calculating',
    'auction.result_calculated',
    'auction.winner_created',
    'auction.completed',
  ]) {
    check(actions.includes(required), `the audit trail is missing ${required}: ${actions.join(', ')}`);
  }
  check(
    actions.filter((action) => action === 'auction.result_calculated').length === 1,
    'the audit trail records the auction as decided more than once',
  );
  console.log('smoke-results: the audit trail records the close exactly once');

  await cleanupRun();
  console.log('smoke-results: OK');
  stop();
}

/**
 * Remove what this run created.
 *
 * Not politeness. This script leaves three completed auctions per run in the
 * shared development database, and completed auctions accumulate on every
 * listing every other script and every developer then sees — which is how
 * `verify:catalog` came to fail on a database a few bidding runs old. Results
 * and orders go first: both reference the auction with ON DELETE RESTRICT.
 *
 * `auction_results` is append-only by trigger, so the delete runs under
 * `session_replication_role = 'replica'` — the same test-only escape hatch the
 * database suite's teardown uses. No application code may do this, and the
 * guarantee it suspends is asserted by tests/db/immutability.test.ts.
 *
 * Registered accounts are left alone: `sessions` references them with
 * RESTRICT, and an unused account changes nothing anyone sees.
 */
async function cleanupRun() {
  const auctions = `SELECT id FROM auctions WHERE slug LIKE 'res-auc-${RUN_TAG}%'`;
  const products = `SELECT id FROM products WHERE slug LIKE 'res-prod-${RUN_TAG}%'`;
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL session_replication_role = 'replica'");
    await db.query(`DELETE FROM orders WHERE auction_id IN (${auctions})`);
    await db.query(`DELETE FROM auction_results WHERE auction_id IN (${auctions})`);
    await db.query(`DELETE FROM bids WHERE auction_id IN (${auctions})`);
    await db.query(`DELETE FROM auction_participants WHERE auction_id IN (${auctions})`);
    await db.query(`DELETE FROM inventory_reservations WHERE product_id IN (${products})`);
    await db.query(`DELETE FROM auctions WHERE id IN (${auctions})`);
    await db.query(`DELETE FROM products WHERE id IN (${products})`);
    await db.query(`DELETE FROM categories WHERE slug LIKE 'res-cat-${RUN_TAG}%'`);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    console.warn(`smoke-results: could not clean up this run's fixtures: ${String(error)}`);
  }
}

main().catch((error) => {
  console.error(error);
  fail('unexpected failure');
});
