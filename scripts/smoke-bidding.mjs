#!/usr/bin/env node
/**
 * End-to-end verification of the Phase 5 bidding engine, over both channels.
 *
 * Two channels, one engine. This boots the built API and drives:
 *
 *   Website  — POST /api/v1/auctions/:publicId/bids for a single bid and a
 *              batch, every refusal a bidder can hit, an idempotent retry, and
 *              the caller's own bid list.
 *   Telegram — the real webhook with real update payloads: the bid button, the
 *              amounts message, the confirmation screen, Confirm, and the
 *              receipt the bot actually sends.
 *
 * Then it checks the database directly: the bids, the participant counters,
 * the auction counters, the wallet balance, the single ledger entry per batch,
 * and the fraud evidence on each row.
 *
 * The module suites call the engine directly, which is the right place to
 * prove locking and the transaction, but leaves the channel wiring unproven —
 * and this phase's wiring had two real defects that only a running endpoint
 * showed: a router-level `authenticate` that broke public browsing, and wallet
 * refusals arriving without the `bidError` code every client branches on.
 *
 * **The point of this script is that both channels reach the same engine.** It
 * asserts that explicitly: a bid placed from Telegram appears in the website's
 * bid list for the same account, and both count against one shared limit.
 *
 * Telegram is driven against a stub Bot API on localhost (TELEGRAM_API_ROOT),
 * so the outbound messages are captured and asserted rather than sent.
 *
 * Registration is rate limited per IP and every smoke script registers from
 * 127.0.0.1, so the run clears the `ratelimit:*` counters first. See
 * clear-rate-limits.mjs for why that belongs to the script.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import process from 'node:process';
import pg from 'pg';
import { clearRateLimits } from './clear-rate-limits.mjs';
import { loadEnvFile } from './load-env.mjs';

await loadEnvFile();
// The limiter is keyed by IP, and every smoke script comes from 127.0.0.1.
// Clearing the counters is this run's precondition, not a bypass of the rule.
await clearRateLimits();

const PORT = Number(process.env.SMOKE_PORT ?? 4304);
const TELEGRAM_STUB_PORT = Number(process.env.SMOKE_TELEGRAM_PORT ?? 4305);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const WEBHOOK = `http://127.0.0.1:${PORT}/telegram/webhook`;
const BOOT_TIMEOUT_MS = 30_000;
const WEBHOOK_SECRET = 'smoke-bidding-webhook-secret-value';

/** Auction and product slugs are globally unique, so each run needs its own. */
const RUN_TAG = Date.now().toString(36);

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
        ? { id: 42, is_bot: true, first_name: 'HOWLOW Bids', username: 'howlow_bids_bot' }
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

const child = spawn(process.execPath, ['apps/api/dist/index.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
    NODE_ENV: 'development',
    TELEGRAM_ENABLED: 'true',
    TELEGRAM_BOT_TOKEN: '42:smoke-token',
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    TELEGRAM_BOT_USERNAME: 'howlow_bids_bot',
    TELEGRAM_API_ROOT: `http://127.0.0.1:${TELEGRAM_STUB_PORT}`,
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
  telegramStub.close();
  void db.end().catch(() => undefined);
};
const fail = (message) => {
  console.error(`smoke-bidding: ${message}`);
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

/** A bid submission, with the header the endpoint requires. */
const submitBids = (reference, amountsMinor, { token, key, ...rest } = {}) =>
  call(`/auctions/${reference}/bids`, {
    method: 'POST',
    body: { amountsMinor },
    token,
    headers: { 'Idempotency-Key': key, ...rest },
  });

/** The `bidError` a refusal carries, which is what clients branch on. */
const bidErrorOf = (response) => response.body?.error?.details?.bidError;

// --- Telegram plumbing ------------------------------------------------------
let updateId = 5000;
async function deliverUpdate(update) {
  const response = await fetch(WEBHOOK, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-telegram-bot-api-secret-token': WEBHOOK_SECRET,
    },
    body: JSON.stringify({ update_id: (updateId += 1), ...update }),
  });
  // grammY answers before its own outbound calls always settle.
  await sleep(300);
  return response.status;
}

/**
 * A Telegram identity unique to this run.
 *
 * `telegram_accounts.telegram_user_id` is unique platform-wide, so a fixed id
 * links to whichever account the *first* run created and every later run
 * collides. Derived from the clock, the same way the slugs are.
 */
const TELEGRAM_ID = 800_000_000_000 + (Date.now() % 1_000_000_000);
const TELEGRAM_USER = {
  id: TELEGRAM_ID,
  is_bot: false,
  first_name: 'Bidder',
  username: `smoke_bidder_${RUN_TAG}`,
};
const CHAT = { id: TELEGRAM_ID, type: 'private' };

const message = (text) => ({
  message: {
    message_id: updateId,
    date: Math.floor(Date.now() / 1000),
    chat: CHAT,
    from: TELEGRAM_USER,
    text,
    entities: text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.length }] : [],
  },
});

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
      from: { id: 42, is_bot: true, first_name: 'HOWLOW Bids' },
      text: 'previous',
    },
  },
});

/** The last message body the bot sent, for asserting what a user would see. */
const lastSent = (method) => {
  for (let index = sent.length - 1; index >= 0; index -= 1) {
    if (sent[index].method === method) return sent[index].body;
  }
  return undefined;
};

const lastText = () => String(lastSent('sendMessage')?.text ?? '');

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

const uniquePhone = (suffix) => `+25198${String(Date.now() % 1_000_000).padStart(6, '0')}${suffix}`;

/** Register, verify, and return a session. */
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
 * A live auction, written straight to the database.
 *
 * The lifecycle service correctly refuses to open an auction whose start time
 * has not arrived, and the point here is bidding rather than scheduling, so the
 * fixture is built in the state the engine needs. The inventory reservation is
 * created too, because a live auction that holds no unit is an inconsistency
 * the engine deliberately refuses to bid on.
 */
async function createLiveAuction(overrides = {}) {
  const tag = `${RUN_TAG}-${Math.random().toString(36).slice(2, 7)}`;
  const { rows: category } = await db.query(
    `INSERT INTO categories (slug, name) VALUES ($1, 'Bidding smoke') RETURNING id`,
    [`bid-cat-${tag}`],
  );
  const { rows: sellerUser } = await db.query(
    `INSERT INTO users (display_name, phone, status, phone_verified_at)
     VALUES ('Bid Smoke Seller', $1, 'active', now()) RETURNING id`,
    [uniquePhone('7')],
  );
  const { rows: seller } = await db.query(
    `INSERT INTO sellers (user_id, display_name, status, approved_at)
     VALUES ($1, 'Bid Smoke Shop', 'approved', now()) RETURNING id`,
    [sellerUser[0].id],
  );
  const { rows: product } = await db.query(
    `INSERT INTO products (seller_id, category_id, slug, title, description,
       retail_price_minor, stock_quantity, status)
     VALUES ($1, $2, $3, 'Bid Smoke Product',
       'A product description long enough to satisfy the service validation rules.',
       2500000, 1, 'active') RETURNING id`,
    [seller[0].id, category[0].id, `bid-prod-${tag}`],
  );
  const { rows: auction } = await db.query(
    `INSERT INTO auctions (product_id, seller_id, slug, title, description, currency,
       bid_fee_minor, min_bid_minor, max_bid_minor, bid_increment_minor,
       max_bids_per_user, winner_payment_hours, starts_at, ends_at, status)
     VALUES ($1, $2, $3, 'Bid Smoke Auction',
       'An auction description long enough to satisfy the service validation rules.',
       'ETB', $4, 100, 5000, 100, $5, 48,
       now() - $6::interval, now() + $7::interval, 'live')
     RETURNING id, slug`,
    [
      product[0].id,
      seller[0].id,
      `bid-auc-${tag}`,
      overrides.bidFeeMinor ?? 500,
      overrides.maxBidsPerUser ?? 25,
      overrides.startedAgo ?? '30 minutes',
      // Negative on purpose for the already-expired fixture: the deadline has
      // to be in the past *at insert*, because the Phase 4 immutability
      // trigger refuses to move `ends_at` on a live auction — correctly, since
      // a seller must not be able to extend an auction people are bidding in.
      overrides.endsIn ?? '2 hours',
    ],
  );
  await db.query(
    `INSERT INTO inventory_reservations (product_id, auction_id, quantity, state)
     VALUES ($1, $2, 1, 'held')`,
    [product[0].id, auction[0].id],
  );
  await db.query(`UPDATE products SET reserved_quantity = 1 WHERE id = $1`, [product[0].id]);
  return { auctionId: auction[0].id, slug: auction[0].slug, productId: product[0].id };
}

/** Put money in a wallet, the way a deposit would. */
async function fundWallet(userId, minor) {
  await db.query(
    `INSERT INTO wallets (user_id, currency, available_minor) VALUES ($1, 'ETB', $2)
     ON CONFLICT (user_id, currency) DO UPDATE SET available_minor = $2`,
    [userId, minor],
  );
}

async function main() {
  await waitForBoot();
  await db.connect();
  console.log('smoke-bidding: API is live');

  const auction = await createLiveAuction();
  const bidder = await newAccount('Smoke Bidder', '1');
  await fundWallet(bidder.userId, 100_000);

  // --- public discovery is untouched by the bid routes --------------------
  //
  // The bid router is mounted on the same `/auctions` path. A router-level
  // `authenticate` there would make every public auction page answer 401,
  // which is exactly the defect this assertion exists to catch.
  const publicDetail = await call(`/auctions/${auction.slug}`);
  check(
    publicDetail.status === 200,
    `public auction detail returned ${publicDetail.status} — the bid routes are shadowing it`,
  );
  const publicList = await call('/auctions');
  check(publicList.status === 200, `public auction list returned ${publicList.status}`);
  console.log('smoke-bidding: mounting bids under /auctions left public discovery alone');

  // --- the authorization and validation boundary --------------------------
  const anonymous = await submitBids(auction.slug, ['100'], { key: `k-${RUN_TAG}-anon` });
  check(anonymous.status === 401, `an unauthenticated bid returned ${anonymous.status}`);

  const noKey = await call(`/auctions/${auction.slug}/bids`, {
    method: 'POST',
    body: { amountsMinor: ['100'] },
    token: bidder.token,
  });
  check(noKey.status === 400, `a bid without an idempotency key returned ${noKey.status}`);
  check(noKey.body.error.code === 'VALIDATION_FAILED', `a missing key gave ${noKey.body.error.code}`);

  // Malformed requests must be stable 4xx, never a 500.
  for (const [amounts, expected, expectedBidError] of [
    [[], 400, undefined],
    [['0'], 400, undefined],
    [['-100'], 400, undefined],
    [['abc'], 400, undefined],
    [['1.5'], 400, undefined],
    [['50'], 400, 'AMOUNT_OUT_OF_RANGE'],
    [['9000'], 400, 'AMOUNT_OUT_OF_RANGE'],
    [['150'], 400, 'AMOUNT_NOT_ALIGNED'],
    [['200', '200'], 409, 'DUPLICATE_AMOUNT'],
    [Array.from({ length: 101 }, (_, index) => String(100 + index * 100)), 400, undefined],
  ]) {
    const response = await submitBids(auction.slug, amounts, {
      token: bidder.token,
      key: `k-${RUN_TAG}-bad-${Math.random().toString(36).slice(2)}`,
    });
    check(
      response.status === expected,
      `amounts ${JSON.stringify(amounts).slice(0, 40)} returned ${response.status}, expected ${expected}: ${response.raw.slice(0, 200)}`,
    );
    if (expectedBidError !== undefined) {
      check(
        bidErrorOf(response) === expectedBidError,
        `expected bidError ${expectedBidError}, got ${bidErrorOf(response)}`,
      );
    }
  }
  const unknownAuction = await submitBids('00000000-0000-4000-8000-000000000000', ['100'], {
    token: bidder.token,
    key: `k-${RUN_TAG}-missing`,
  });
  check(unknownAuction.status === 404, `bidding on an unknown auction returned ${unknownAuction.status}`);
  console.log('smoke-bidding: malformed and unauthorized requests return stable 4xx');

  // --- insufficient funds, before the wallet is topped up ----------------
  //
  // The rival is created unfunded and used for this first, then funded and
  // reused below. Registration is five per IP per hour — production policy,
  // not a test knob — so the script reuses identities rather than minting one
  // per assertion.
  const rival = await newAccount('Smoke Rival', '2');
  const broke = await submitBids(auction.slug, ['100'], {
    token: rival.token,
    key: `k-${RUN_TAG}-broke`,
  });
  check(broke.status === 422, `an unfunded bid returned ${broke.status}`);
  check(broke.body.error.code === 'INSUFFICIENT_FUNDS', `an unfunded bid gave code ${broke.body.error.code}`);
  // The wallet raises its own error; the engine must restate it in the bid
  // vocabulary or every client falls through to a generic message.
  check(
    bidErrorOf(broke) === 'INSUFFICIENT_FUNDS',
    `an unfunded bid gave bidError ${bidErrorOf(broke)} — wallet errors are not being translated`,
  );
  const { rows: nothing } = await db.query(`SELECT count(*) AS n FROM bids WHERE user_id = $1`, [
    rival.userId,
  ]);
  check(nothing[0].n === '0', 'a refused bid still wrote a row');
  console.log('smoke-bidding: an unfunded bid is refused as INSUFFICIENT_FUNDS and writes nothing');

  // --- a single bid ------------------------------------------------------
  const single = await submitBids(auction.slug, ['100'], {
    token: bidder.token,
    key: `k-${RUN_TAG}-single`,
    'X-Device-Hash': 'smoke-device-hash-0001',
  });
  check(single.status === 201, `a single bid returned ${single.status}: ${single.raw}`);
  check(single.body.bids.length === 1, 'a single bid did not return one bid');
  check(single.body.bids[0].status === 'submitted', 'a bid did not read as submitted');
  check(single.body.totalFeeMinor === '500', `a single bid charged ${single.body.totalFeeMinor}`);
  check(single.body.walletBalanceMinor === '99500', `balance was ${single.body.walletBalanceMinor}`);
  check(single.body.bidCount === 1, `bidCount was ${single.body.bidCount}`);
  check(single.body.replayed === false, 'a first submission reported itself as replayed');
  // Money on the wire is a string, never a JSON number.
  check(/"totalFeeMinor":"500"/.test(single.raw), `fee was not serialised as a string: ${single.raw}`);
  console.log('smoke-bidding: a single bid is accepted and charged once');

  // --- a batch -----------------------------------------------------------
  const batch = await submitBids(auction.slug, ['300', '700', '1300'], {
    token: bidder.token,
    key: `k-${RUN_TAG}-batch`,
  });
  check(batch.status === 201, `a batch returned ${batch.status}: ${batch.raw}`);
  check(batch.body.bids.length === 3, `a batch of three returned ${batch.body.bids.length}`);
  check(batch.body.totalFeeMinor === '1500', `a batch of three charged ${batch.body.totalFeeMinor}`);
  check(batch.body.bidCount === 4, `bidCount after a batch was ${batch.body.bidCount}`);
  console.log('smoke-bidding: a batch is accepted atomically and charged per bid');

  // --- the duplicate rule ------------------------------------------------
  const duplicate = await submitBids(auction.slug, ['700'], {
    token: bidder.token,
    key: `k-${RUN_TAG}-dup`,
  });
  check(duplicate.status === 409, `a duplicate amount returned ${duplicate.status}`);
  check(bidErrorOf(duplicate) === 'DUPLICATE_AMOUNT', `a duplicate gave ${bidErrorOf(duplicate)}`);

  // A batch where only one amount collides must fail whole.
  const balanceBefore = (
    await db.query(`SELECT available_minor FROM wallets WHERE user_id = $1`, [bidder.userId])
  ).rows[0].available_minor;
  const partial = await submitBids(auction.slug, ['1900', '700', '2300'], {
    token: bidder.token,
    key: `k-${RUN_TAG}-partial`,
  });
  check(partial.status === 409, `a partially duplicate batch returned ${partial.status}`);
  const { rows: notWritten } = await db.query(
    `SELECT count(*) AS n FROM bids WHERE auction_id = $1 AND amount_minor IN (1900, 2300)`,
    [auction.auctionId],
  );
  check(notWritten[0].n === '0', 'a partially duplicate batch wrote some of its bids');
  const balanceAfter = (
    await db.query(`SELECT available_minor FROM wallets WHERE user_id = $1`, [bidder.userId])
  ).rows[0].available_minor;
  check(
    balanceBefore === balanceAfter,
    `a refused batch changed the balance from ${balanceBefore} to ${balanceAfter}`,
  );
  console.log('smoke-bidding: a batch containing one duplicate is refused whole and charges nothing');

  // --- idempotency -------------------------------------------------------
  const retry = await submitBids(auction.slug, ['300', '700', '1300'], {
    token: bidder.token,
    key: `k-${RUN_TAG}-batch`,
  });
  check(retry.status === 201, `an idempotent retry returned ${retry.status}`);
  check(retry.body.replayed === true, 'an idempotent retry did not report itself as a replay');
  check(retry.body.bids.length === 3, 'an idempotent retry returned a different number of bids');
  check(
    retry.body.walletBalanceMinor === batch.body.walletBalanceMinor,
    'an idempotent retry reported a different balance than the original',
  );
  check(
    retry.body.totalFeeMinor === batch.body.totalFeeMinor,
    'an idempotent retry reported a different fee than the original',
  );

  const conflict = await submitBids(auction.slug, ['2900'], {
    token: bidder.token,
    key: `k-${RUN_TAG}-batch`,
  });
  check(conflict.status === 409, `a reused key with a new body returned ${conflict.status}`);
  check(bidErrorOf(conflict) === 'IDEMPOTENCY_CONFLICT', `a reused key gave ${bidErrorOf(conflict)}`);
  console.log('smoke-bidding: a retry replays and a reused key with a new body conflicts');

  // --- the caller's own bids ---------------------------------------------
  const mine = await call(`/auctions/${auction.slug}/bids`, { token: bidder.token });
  check(mine.status === 200, `the bid list returned ${mine.status}`);
  check(mine.body.bids.length === 4, `the bid list showed ${mine.body.bids.length} bids`);
  check(mine.body.bidCount === 4, `the bid list reported bidCount ${mine.body.bidCount}`);
  check(
    mine.body.bidsRemaining === mine.body.maxBidsPerUser - 4,
    'bidsRemaining did not agree with the count',
  );
  check(
    mine.body.bids.every((bid) => bid.status === 'submitted'),
    'a bid in the list read as something other than submitted',
  );
  // The absolute rule: nothing anywhere may hint at per-amount uniqueness.
  for (const forbidden of ['unique', 'Unique', 'duplicated', 'occupancy', 'bidderCount', 'amountCount']) {
    check(!mine.raw.includes(forbidden), `the bid list payload mentioned ${forbidden}`);
  }
  console.log('smoke-bidding: the caller sees only their own bids, all reading submitted');

  // --- another bidder may hold the same amount ---------------------------
  await fundWallet(rival.userId, 50_000);
  const sameAmount = await submitBids(auction.slug, ['700'], {
    token: rival.token,
    key: `k-${RUN_TAG}-rival`,
  });
  check(
    sameAmount.status === 201,
    `a second bidder on the same amount returned ${sameAmount.status} — that is valid behaviour`,
  );
  const { rows: bothHeld } = await db.query(
    `SELECT count(*) AS n FROM bids WHERE auction_id = $1 AND amount_minor = 700 AND status = 'valid'`,
    [auction.auctionId],
  );
  check(bothHeld[0].n === '2', `two bidders at 700 produced ${bothHeld[0].n} valid bids`);
  console.log('smoke-bidding: two different bidders may hold the same amount, and both stay valid');

  // --- the bid limit -----------------------------------------------------
  // A fresh auction, so the main bidder's own limit elsewhere is untouched.
  const smallAuction = await createLiveAuction({ maxBidsPerUser: 2, bidFeeMinor: 100 });
  const atLimit = await submitBids(smallAuction.slug, ['100', '200'], {
    token: bidder.token,
    key: `k-${RUN_TAG}-limit-a`,
  });
  check(atLimit.status === 201, `filling the limit returned ${atLimit.status}`);
  check(atLimit.body.bidsRemaining === 0, `bidsRemaining was ${atLimit.body.bidsRemaining}`);
  const overLimit = await submitBids(smallAuction.slug, ['300'], {
    token: bidder.token,
    key: `k-${RUN_TAG}-limit-b`,
  });
  check(overLimit.status === 409, `exceeding the limit returned ${overLimit.status}`);
  check(bidErrorOf(overLimit) === 'BID_LIMIT_EXCEEDED', `exceeding the limit gave ${bidErrorOf(overLimit)}`);
  console.log('smoke-bidding: the per-auction bid limit is enforced');

  // --- a zero-fee auction writes no ledger entry -------------------------
  const freeAuction = await createLiveAuction({ bidFeeMinor: 0 });
  const free = await submitBids(freeAuction.slug, ['100', '200'], {
    token: bidder.token,
    key: `k-${RUN_TAG}-free`,
  });
  check(free.status === 201, `a free-auction bid returned ${free.status}: ${free.raw}`);
  check(free.body.totalFeeMinor === '0', `a free auction charged ${free.body.totalFeeMinor}`);
  // Counted against this auction, because the bidder has paid fees elsewhere:
  // what must be absent is an entry *for these* bids.
  const { rows: freeEntries } = await db.query(
    `SELECT count(*) AS n FROM wallet_entries
      WHERE user_id = $1 AND reference_type = 'auction' AND reference_id = $2`,
    [bidder.userId, freeAuction.auctionId],
  );
  check(freeEntries[0].n === '0', `a zero fee wrote ${freeEntries[0].n} ledger entries`);
  const { rows: freeBids } = await db.query(
    `SELECT count(*) AS n FROM bids WHERE auction_id = $1 AND wallet_entry_id IS NULL`,
    [freeAuction.auctionId],
  );
  check(freeBids[0].n === '2', `${freeBids[0].n} free bids carry no wallet entry, expected 2`);
  console.log('smoke-bidding: a zero fee charges nothing and writes no ledger entry');

  // --- a closed auction refuses ------------------------------------------
  await db.query(`UPDATE auctions SET status = 'closing', closing_at = now() WHERE id = $1`, [
    smallAuction.auctionId,
  ]);
  const closed = await submitBids(smallAuction.slug, ['400'], {
    token: bidder.token,
    key: `k-${RUN_TAG}-closed`,
  });
  check(closed.status === 409, `bidding on a closing auction returned ${closed.status}`);
  check(bidErrorOf(closed) === 'AUCTION_NOT_LIVE', `a closing auction gave ${bidErrorOf(closed)}`);

  // Live by status, but past its deadline: the database clock decides, not the
  // status and never the client.
  const expired = await createLiveAuction({
    startedAgo: '2 hours',
    endsIn: '-1 minute',
  });
  const late = await submitBids(expired.slug, ['100'], {
    token: bidder.token,
    key: `k-${RUN_TAG}-late`,
  });
  check(late.status === 409, `a bid past ends_at returned ${late.status}`);
  check(bidErrorOf(late) === 'AUCTION_ENDED', `a late bid gave ${bidErrorOf(late)}`);
  console.log('smoke-bidding: a closed auction and a passed deadline both refuse');

  // --- rate limiting -----------------------------------------------------
  //
  // The per-user-per-auction limit is 20 requests a minute. Driving past it
  // proves the limiter is wired into the engine, so Telegram gets it too.
  const flooder = await newAccount('Smoke Flood', '3');
  await fundWallet(flooder.userId, 200_000);
  const floodAuction = await createLiveAuction({ bidFeeMinor: 100 });
  let limitedAt = 0;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const response = await submitBids(floodAuction.slug, [String(attempt * 100)], {
      token: flooder.token,
      key: `k-${RUN_TAG}-flood-${attempt}`,
    });
    if (response.status === 429) {
      limitedAt = attempt;
      check(
        response.body.error.code === 'RATE_LIMITED',
        `a throttled bid gave code ${response.body.error.code}`,
      );
      break;
    }
  }
  check(limitedAt > 0, 'thirty rapid submissions were never rate limited');
  check(limitedAt > 5, `rate limiting kicked in at attempt ${limitedAt}, which is too aggressive`);
  console.log(`smoke-bidding: rate limiting engaged at request ${limitedAt}`);

  // --- Telegram ----------------------------------------------------------
  //
  // The same engine, reached from a chat. The account is linked directly
  // because the link flow is Phase 2's and is covered by its own smoke test.
  const tgAuction = await createLiveAuction({ bidFeeMinor: 200 });
  const tgUser = await newAccount('Smoke Telegram', '4');
  await fundWallet(tgUser.userId, 80_000);
  await db.query(
    `INSERT INTO telegram_accounts (user_id, telegram_user_id, username, first_name, linked_at)
     VALUES ($1, $2, $3, 'Bidder', now())`,
    [tgUser.userId, String(TELEGRAM_USER.id), TELEGRAM_USER.username],
  );

  check((await deliverUpdate(message('/auctions'))) === 200, 'the /auctions webhook was refused');
  const listText = lastText();
  check(listText.includes('HOWLOW auctions'), `the bot did not send a listing: ${listText.slice(0, 120)}`);

  // Open this run's auction, then press the bid button.
  check(
    (await deliverUpdate(callbackQuery(`a:${tgAuction.auctionId}`))) === 200,
    'opening an auction from the keyboard was refused',
  );
  const detailKeyboard = lastSent('sendMessage')?.reply_markup;
  const buttons = JSON.stringify(detailKeyboard ?? {});
  check(buttons.includes(`ab:${tgAuction.auctionId}`), `the detail keyboard had no bid button: ${buttons}`);
  check(buttons.includes('Place a bid'), `the bid button did not offer bidding: ${buttons}`);

  check(
    (await deliverUpdate(callbackQuery(`ab:${tgAuction.auctionId}`))) === 200,
    'pressing the bid button was refused',
  );
  const promptText = lastText();
  check(
    promptText.includes('Place a bid'),
    `the bot did not prompt for amounts: ${promptText.slice(0, 160)}`,
  );
  check(promptText.includes('In steps of'), 'the prompt did not state the ladder');
  check(promptText.includes('Your wallet'), 'the prompt did not state the wallet balance');

  // A malformed ladder is caught before the confirmation.
  await deliverUpdate(message('3.5 seven'));
  check(
    lastText().includes('not a whole number'),
    `a malformed amount list was not explained: ${lastText().slice(0, 160)}`,
  );

  // An off-ladder amount is refused by the engine's own rule, not a copy.
  await deliverUpdate(message('150'));
  check(
    lastText().includes('allowed bid steps'),
    `an off-ladder amount was not refused: ${lastText().slice(0, 160)}`,
  );

  // The real batch, exactly as the brief's example types it.
  await deliverUpdate(message('100 300 700'));
  const confirmText = lastText();
  check(
    confirmText.includes('You are submitting'),
    `no confirmation was shown: ${confirmText.slice(0, 200)}`,
  );
  check(confirmText.includes('Number of bids: 3'), `the confirmation miscounted: ${confirmText}`);
  check(confirmText.includes('Participation fee'), 'the confirmation did not state the fee');
  check(confirmText.includes('Wallet'), 'the confirmation did not state the wallet');
  const confirmKeyboard = JSON.stringify(lastSent('sendMessage')?.reply_markup ?? {});
  check(confirmKeyboard.includes('"bc"'), `no confirm button: ${confirmKeyboard}`);
  // The payload must carry no state — no auction id, no amounts.
  check(
    !confirmKeyboard.includes(tgAuction.auctionId) && !confirmKeyboard.includes('700'),
    `the confirm payload carried state: ${confirmKeyboard}`,
  );
  console.log('smoke-bidding: Telegram prompts, validates and confirms a batch');

  check((await deliverUpdate(callbackQuery('bc'))) === 200, 'confirming the bid was refused');
  const receipt = lastText();
  check(receipt.includes('Bids submitted'), `no receipt was sent: ${receipt.slice(0, 200)}`);
  check(receipt.includes('submitted'), 'the receipt did not mark the bids submitted');
  for (const forbidden of ['unique', 'Unique', 'duplicated', 'someone else']) {
    check(!receipt.includes(forbidden), `the Telegram receipt mentioned ${forbidden}`);
  }

  // The engine wrote it, so the website sees it: one account, one limit.
  const tgFromWeb = await call(`/auctions/${tgAuction.slug}/bids`, { token: tgUser.token });
  check(tgFromWeb.status === 200, `the website could not read the Telegram bids: ${tgFromWeb.status}`);
  check(
    tgFromWeb.body.bids.length === 3,
    `the website saw ${tgFromWeb.body.bids.length} of the 3 bids placed from Telegram`,
  );
  check(
    tgFromWeb.body.bids.every((bid) => bid.channel === 'telegram'),
    'bids placed from Telegram were not marked as such',
  );
  check(tgFromWeb.body.bidCount === 3, `the shared bid count was ${tgFromWeb.body.bidCount}`);
  console.log('smoke-bidding: a Telegram bid is the website’s bid — one engine, one limit');

  // Tapping Confirm again must not charge twice.
  const beforeSecondTap = (
    await db.query(`SELECT available_minor FROM wallets WHERE user_id = $1`, [tgUser.userId])
  ).rows[0].available_minor;
  await deliverUpdate(callbackQuery('bc'));
  const afterSecondTap = (
    await db.query(`SELECT available_minor FROM wallets WHERE user_id = $1`, [tgUser.userId])
  ).rows[0].available_minor;
  check(
    beforeSecondTap === afterSecondTap,
    `a second Confirm tap moved the balance from ${beforeSecondTap} to ${afterSecondTap}`,
  );
  const { rows: tgBidRows } = await db.query(
    `SELECT count(*) AS n FROM bids WHERE auction_id = $1 AND user_id = $2`,
    [tgAuction.auctionId, tgUser.userId],
  );
  check(tgBidRows[0].n === '3', `a second Confirm tap produced ${tgBidRows[0].n} bids`);
  console.log('smoke-bidding: tapping Confirm twice charges once');

  // Cancel discards the draft.
  await deliverUpdate(callbackQuery(`ab:${tgAuction.auctionId}`));
  await deliverUpdate(message('1900'));
  await deliverUpdate(callbackQuery('bx'));
  check(lastText().includes('Cancelled'), `cancel was not acknowledged: ${lastText().slice(0, 120)}`);
  await deliverUpdate(callbackQuery('bc'));
  check(
    lastText().includes('expired'),
    `confirming after cancel did not refuse: ${lastText().slice(0, 160)}`,
  );
  const { rows: afterCancel } = await db.query(
    `SELECT count(*) AS n FROM bids WHERE auction_id = $1 AND user_id = $2`,
    [tgAuction.auctionId, tgUser.userId],
  );
  check(afterCancel[0].n === '3', `cancel then confirm wrote a bid: ${afterCancel[0].n} rows`);
  console.log('smoke-bidding: cancelling discards the draft, and confirming afterwards refuses');

  // --- what the database holds -------------------------------------------
  const { rows: truth } = await db.query(
    `SELECT
       (SELECT count(*) FROM bids WHERE auction_id = $1 AND status = 'valid') AS bids,
       (SELECT total_bids FROM auctions WHERE id = $1) AS total_bids,
       (SELECT total_participants FROM auctions WHERE id = $1) AS total_participants,
       (SELECT count(DISTINCT user_id) FROM bids WHERE auction_id = $1) AS distinct_bidders,
       (SELECT bid_count FROM auction_participants WHERE auction_id = $1 AND user_id = $2) AS pcount,
       (SELECT total_fees_minor FROM auction_participants WHERE auction_id = $1 AND user_id = $2) AS pfees,
       (SELECT first_bid_at IS NOT NULL AND last_bid_at IS NOT NULL
          FROM auction_participants WHERE auction_id = $1 AND user_id = $2) AS stamped,
       (SELECT available_minor FROM wallets WHERE user_id = $2) AS balance,
       -- The wallet must agree with its own ledger. Derived rather than
       -- hardcoded: this bidder pays fees on several auctions in this run, and
       -- a fixed figure would only assert that the script's arithmetic matches
       -- itself. What matters is that the balance is the funded amount less
       -- exactly what the ledger says was taken.
       (SELECT coalesce(sum(-amount_minor), 0) FROM wallet_entries
          WHERE user_id = $2 AND entry_type = 'bid_fee') AS fees_booked,
       (SELECT count(*) FROM wallet_entries WHERE user_id = $2 AND entry_type = 'bid_fee') AS entries,
       (SELECT count(*) FROM bids WHERE auction_id = $1 AND user_id = $2 AND wallet_entry_id IS NOT NULL) AS linked,
       (SELECT count(*) FROM bids WHERE auction_id = $1 AND user_id = $2 AND ip_address IS NOT NULL) AS with_ip,
       (SELECT count(*) FROM bids WHERE auction_id = $1 AND user_id = $2 AND device_hash IS NOT NULL) AS with_device,
       (SELECT count(*) FROM audit_logs WHERE action = 'bid.submitted' AND entity_id = $1::text) AS audits`,
    [auction.auctionId, bidder.userId],
  );
  const t = truth[0];
  check(t.bids === '5', `the auction holds ${t.bids} valid bids, expected 5`);
  check(t.total_bids === 5, `total_bids is ${t.total_bids}, expected 5`);
  check(
    String(t.total_participants) === t.distinct_bidders,
    `total_participants is ${t.total_participants} but ${t.distinct_bidders} users have bid`,
  );
  check(t.pcount === 4, `the participant holds ${t.pcount} bids, expected 4`);
  check(t.pfees === '2000', `the participant paid ${t.pfees}, expected 2000`);
  check(t.stamped === true, 'first_bid_at or last_bid_at was not set');
  check(
    BigInt(t.balance) === 100_000n - BigInt(t.fees_booked),
    `the wallet holds ${t.balance} but the ledger booked ${t.fees_booked} against 100000`,
  );
  // One entry per accepted submission, never one per bid: the batch of three
  // produced a single charge.
  const { rows: submissions } = await db.query(
    `SELECT count(DISTINCT idempotency_key) AS n FROM bids WHERE user_id = $1 AND fee_minor > 0`,
    [bidder.userId],
  );
  check(
    t.entries === submissions[0].n,
    `${t.entries} ledger entries for ${submissions[0].n} charged submissions — a batch must charge once`,
  );
  check(t.linked === '4', `${t.linked} of 4 bids carry their wallet entry`);
  check(t.with_ip === '4', `${t.with_ip} of 4 bids carry an address`);
  check(t.with_device === '1', `${t.with_device} bids carry a device hash, expected 1`);
  // One audit row per accepted submission on this auction, from every bidder —
  // the row is scoped to the auction, not to one user.
  const { rows: accepted } = await db.query(
    `SELECT count(DISTINCT idempotency_key) AS n FROM bids WHERE auction_id = $1`,
    [auction.auctionId],
  );
  check(
    t.audits === accepted[0].n,
    `${t.audits} audit rows for ${accepted[0].n} accepted submissions on this auction`,
  );
  console.log('smoke-bidding: counters, wallet, ledger, evidence and audit all agree');

  // The audit row must not carry the user's ladder: their whole strategy would
  // otherwise sit in the application log this writer also emits to.
  const { rows: auditRows } = await db.query(
    `SELECT after_data FROM audit_logs WHERE action = 'bid.submitted' AND entity_id = $1::text LIMIT 5`,
    [auction.auctionId],
  );
  for (const row of auditRows) {
    const serialised = JSON.stringify(row.after_data);
    check(!/amountsMinor|"amount"/.test(serialised), `an audit row carried bid amounts: ${serialised}`);
  }
  console.log('smoke-bidding: audit rows record the submission without the amounts');

  // --- Phase 6 stays untouched -------------------------------------------
  const { rows: phase6 } = await db.query(
    `SELECT (SELECT count(*) FROM auction_results) AS results,
            (SELECT count(*) FROM orders) AS orders`,
  );
  check(phase6[0].results === '0', `Phase 5 wrote ${phase6[0].results} auction results`);
  check(phase6[0].orders === '0', `Phase 5 wrote ${phase6[0].orders} orders`);
  console.log('smoke-bidding: no auction results and no orders — the Phase 6 boundary holds');

  await cleanupRun();

  console.log('smoke-bidding: OK');
  stop();
}

/**
 * Remove the auctions and products this run created.
 *
 * Not politeness: this script builds seven auctions per run against the shared
 * development database, and a live auction it leaves behind is a live auction
 * on every listing every other script and every developer then sees. It was
 * caught by `verify:catalog` failing on a database several bidding runs old —
 * its Telegram assertion looks at the first page of the listing, and this
 * script's litter had filled it.
 *
 * Deleted in foreign-key order and scoped to this run's slug prefix. Registered
 * bidder accounts are left alone: `audit_logs.actor_user_id` is
 * `ON DELETE SET NULL` but `sessions` is `RESTRICT`, so removing them would
 * mean unpicking Phase 2's tables for no gain — an unused account changes
 * nothing anyone sees.
 */
async function cleanupRun() {
  const auctions = `SELECT id FROM auctions WHERE slug LIKE 'bid-auc-${RUN_TAG}%'`;
  const products = `SELECT id FROM products WHERE slug LIKE 'bid-prod-${RUN_TAG}%'`;
  try {
    await db.query('BEGIN');
    await db.query(`DELETE FROM bids WHERE auction_id IN (${auctions})`);
    await db.query(`DELETE FROM auction_participants WHERE auction_id IN (${auctions})`);
    await db.query(`DELETE FROM inventory_reservations WHERE product_id IN (${products})`);
    await db.query(`DELETE FROM auctions WHERE id IN (${auctions})`);
    await db.query(`DELETE FROM products WHERE id IN (${products})`);
    await db.query(`DELETE FROM categories WHERE slug LIKE 'bid-cat-${RUN_TAG}%'`);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    // A failed cleanup must not fail a run whose assertions all passed; it
    // leaves rows behind, which is the state this function exists to improve
    // rather than a correctness problem.
    console.warn(`smoke-bidding: could not clean up this run's fixtures: ${String(error)}`);
  }
}

main().catch((error) => {
  console.error(error);
  fail('unexpected failure');
});
