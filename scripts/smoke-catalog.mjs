#!/usr/bin/env node
/**
 * End-to-end verification of the Phase 4 channel surfaces.
 *
 * Two channels, one backend. This boots the built API and drives:
 *
 *   Website  — public discovery and detail, a seller creating a product and an
 *              auction and submitting it, a manager approving it, and the
 *              authorization boundary from both sides.
 *   Telegram — the real webhook with real update payloads: /auctions, an
 *              inline-keyboard callback opening an auction, and the detail the
 *              bot actually sends.
 *
 * The module suites call the services directly, which is the right place to
 * prove locking and lifecycle rules but leaves the channel wiring unproven.
 * This closes that gap — and it earned its place immediately: probing the real
 * endpoints is what found that a draft auction was publicly readable by id.
 *
 * Telegram is driven against a stub Bot API on localhost (TELEGRAM_API_ROOT),
 * so the outbound messages are captured and asserted rather than sent.
 *
 * Registration is rate limited per IP, so several runs in quick succession are
 * refused with 429. That is the limiter working; wait for the window or clear
 * the `ratelimit:register:<ip>` keys in Redis.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import process from 'node:process';
import pg from 'pg';
import { loadEnvFile } from './load-env.mjs';

await loadEnvFile();

const PORT = Number(process.env.SMOKE_PORT ?? 4302);
const TELEGRAM_STUB_PORT = Number(process.env.SMOKE_TELEGRAM_PORT ?? 4303);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const WEBHOOK = `http://127.0.0.1:${PORT}/telegram/webhook`;
const BOOT_TIMEOUT_MS = 30_000;
const WEBHOOK_SECRET = 'smoke-telegram-webhook-secret-value';

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
        ? { id: 42, is_bot: true, first_name: 'HOWLOW Smoke', username: 'howlow_smoke_bot' }
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
    TELEGRAM_BOT_USERNAME: 'howlow_smoke_bot',
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
  console.error(`smoke-catalog: ${message}`);
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
  return { status: response.status, raw: text, body: text === '' ? null : JSON.parse(text) };
}

/** Deliver a real Telegram update to the real webhook. */
let updateId = 1000;
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
  await sleep(250);
  return response.status;
}

const TELEGRAM_USER = { id: 987_654_321, is_bot: false, first_name: 'Smoke', username: 'smoke_reader' };
const CHAT = { id: 987_654_321, type: 'private' };

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
      from: { id: 42, is_bot: true, first_name: 'HOWLOW Smoke' },
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

async function waitForBoot() {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) fail('API exited before becoming live');
    try {
      if ((await fetch(`${BASE}/health/live`)).ok) return;
    } catch {
      /* not listening yet */
    }
    await sleep(250);
  }
  fail(`API did not become live within ${BOOT_TIMEOUT_MS}ms`);
}

const uniquePhone = (suffix) => `+25199${String(Date.now() % 100_000).padStart(5, '0')}${suffix}`;
/** Product and auction slugs are globally unique, so each run needs its own. */
const RUN_TAG = Date.now().toString(36);

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

/** A role only reaches the caller through a fresh access token. */
async function reissueToken(phone) {
  const requested = await call('/auth/login', { method: 'POST', body: { method: 'otp_request', phone } });
  check(requested.status === 202, `login otp request returned ${requested.status}`);
  const login = await call('/auth/login', {
    method: 'POST',
    body: { method: 'otp', phone, code: requested.body.devCode },
  });
  check(login.status === 200, `login returned ${login.status}`);
  return { token: login.body.tokens.accessToken, roles: login.body.user.roles };
}

async function main() {
  await waitForBoot();
  await db.connect();
  console.log('smoke-catalog: API is live');

  // --- public discovery, unauthenticated ----------------------------------
  const categories = await call('/categories');
  check(categories.status === 200, `GET /categories returned ${categories.status}`);
  check(Array.isArray(categories.body.categories), '/categories did not return a list');

  const listing = await call('/auctions');
  check(listing.status === 200, `GET /auctions returned ${listing.status}`);
  check(Array.isArray(listing.body.auctions), '/auctions did not return a list');
  console.log('smoke-catalog: public discovery answers without a session');

  // --- malformed requests must be 4xx, never 500 --------------------------
  for (const [path, expected] of [
    ['/auctions?limit=999', 400],
    ['/auctions?limit=0', 400],
    ['/auctions?cursor=not-a-cursor', 400],
    ['/auctions?sort=sideways', 400],
    ['/auctions/00000000-0000-4000-8000-000000000000', 404],
    ['/auctions/definitely-not-real', 404],
    ['/categories/not-a-category', 404],
  ]) {
    const response = await call(path);
    check(response.status === expected, `GET ${path} returned ${response.status}, expected ${expected}`);
  }
  console.log('smoke-catalog: malformed requests return stable 4xx');

  // --- the authorization boundary -----------------------------------------
  for (const [path, method] of [
    ['/seller/products', 'GET'],
    ['/seller/auctions', 'GET'],
    ['/admin/auctions/pending', 'GET'],
    ['/admin/categories', 'GET'],
  ]) {
    const response = await call(path, { method });
    check(response.status === 401, `${method} ${path} without a token returned ${response.status}`);
  }

  const buyer = await newAccount('Smoke Buyer', '1');
  for (const path of ['/seller/products', '/admin/auctions/pending']) {
    const response = await call(path, { token: buyer.token });
    check(response.status === 403, `${path} as an ordinary user returned ${response.status}`);
  }
  console.log('smoke-catalog: seller and admin routes refuse the wrong caller');

  // --- a seller builds a listing ------------------------------------------
  const seller = await newAccount('Smoke Seller', '2');
  await db.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'seller') ON CONFLICT DO NOTHING`, [
    seller.userId,
  ]);
  await db.query(
    `INSERT INTO sellers (user_id, display_name, status, approved_at)
     VALUES ($1, 'Smoke Shop', 'approved', now())`,
    [seller.userId],
  );
  const sellerSession = await reissueToken(seller.phone);
  check(sellerSession.roles.includes('seller'), 'the seller role did not reach the token');

  const product = await call('/seller/products', {
    method: 'POST',
    token: sellerSession.token,
    body: {
      title: `Smoke Telephone ${RUN_TAG}`,
      description: 'A smoke-test product description that is comfortably long enough.',
      retailPriceMinor: '12000000',
      stockQuantity: 1,
      condition: 'new',
      brand: 'Smoke',
      specs: { Storage: '256GB' },
    },
  });
  check(product.status === 201, `POST /seller/products returned ${product.status}: ${product.raw}`);
  check(product.body.status === 'draft', `a new product was ${product.body.status}, expected draft`);
  check(
    product.body.slug === `smoke-telephone-${RUN_TAG}`,
    `slug was ${product.body.slug}, expected it derived from the title`,
  );
  // Money is a string on the wire, never a JSON number.
  check(
    /"retailPriceMinor":"12000000"/.test(product.raw),
    `retailPriceMinor was not serialised as a string: ${product.raw}`,
  );
  const productId = product.body.id;
  console.log('smoke-catalog: seller creates a product');

  const slot = await call(`/seller/products/${productId}/images`, {
    method: 'POST',
    token: sellerSession.token,
    body: { contentType: 'image/jpeg', sizeBytes: 4096, altText: 'Front' },
  });
  check(slot.status === 201, `image slot returned ${slot.status}: ${slot.raw}`);
  check(slot.body.method === 'PUT', 'the upload slot was not a PUT');
  check(slot.body.uploadUrl.includes('X-Amz-Signature='), 'the upload URL was not presigned');
  // The key is the server's, built from the seller and product, never the caller's.
  check(slot.body.uploadUrl.includes(`/${productId}/`), 'the upload URL was not scoped to the product');
  console.log('smoke-catalog: image upload slots are presigned and server-scoped');

  const activated = await call(`/seller/products/${productId}`, {
    method: 'PATCH',
    token: sellerSession.token,
    body: { status: 'active' },
  });
  check(activated.status === 200, `activating the product returned ${activated.status}`);

  const startsAt = new Date(Date.now() + 60_000).toISOString();
  const endsAt = new Date(Date.now() + 3_600_000).toISOString();
  const auctionBody = {
    productId,
    title: `Smoke Auction ${RUN_TAG}`,
    description: 'A smoke-test auction description that is comfortably long enough.',
    startsAt,
    endsAt,
    minBidMinor: '100',
    maxBidMinor: '5000',
    bidIncrementMinor: '100',
    maxBidsPerUser: 25,
    bidFeeMinor: '500',
    shippingNote: 'Delivered within Addis Ababa in two days',
  };

  // An unwalkable ladder is refused before anything is stored.
  const badLadder = await call('/seller/auctions', {
    method: 'POST',
    token: sellerSession.token,
    body: { ...auctionBody, maxBidMinor: '5050' },
  });
  check(badLadder.status === 400, `an indivisible bid range returned ${badLadder.status}`);

  const auction = await call('/seller/auctions', {
    method: 'POST',
    token: sellerSession.token,
    body: auctionBody,
  });
  check(auction.status === 201, `POST /seller/auctions returned ${auction.status}: ${auction.raw}`);
  check(auction.body.status === 'draft', `a new auction was ${auction.body.status}`);
  const auctionId = auction.body.id;
  const auctionSlug = auction.body.slug;
  console.log('smoke-catalog: seller creates an auction');

  // A draft must not be publicly readable, by id or by slug.
  for (const reference of [auctionId, auctionSlug]) {
    const hidden = await call(`/auctions/${reference}`);
    check(hidden.status === 404, `a draft auction was publicly readable at ${reference}`);
  }
  console.log('smoke-catalog: a draft auction is not publicly readable');

  const submitted = await call(`/seller/auctions/${auctionId}/submit`, {
    method: 'POST',
    token: sellerSession.token,
  });
  check(submitted.status === 200, `submit returned ${submitted.status}: ${submitted.raw}`);
  check(submitted.body.changed === true, 'submitting reported no change');
  check(
    submitted.body.auction.status === 'pending_approval',
    `after submitting, status was ${submitted.body.auction.status}`,
  );
  console.log('smoke-catalog: seller submits the auction for review');

  // A seller cannot approve, whatever roles they hold.
  const selfApprove = await call(`/admin/auctions/${auctionId}/approve`, {
    method: 'POST',
    token: sellerSession.token,
  });
  check(selfApprove.status === 403, `a seller approving returned ${selfApprove.status}`);

  // --- a manager approves --------------------------------------------------
  const manager = await newAccount('Smoke Manager', '3');
  await db.query(
    `INSERT INTO user_roles (user_id, role) VALUES ($1, 'auction_manager') ON CONFLICT DO NOTHING`,
    [manager.userId],
  );
  const managerSession = await reissueToken(manager.phone);
  check(managerSession.roles.includes('auction_manager'), 'the manager role did not reach the token');

  const queue = await call('/admin/auctions/pending', { token: managerSession.token });
  check(queue.status === 200, `the review queue returned ${queue.status}`);
  check(
    queue.body.auctions.some((item) => item.id === auctionId),
    'the submitted auction was not in the review queue',
  );

  const approved = await call(`/admin/auctions/${auctionId}/approve`, {
    method: 'POST',
    token: managerSession.token,
  });
  check(approved.status === 200, `approve returned ${approved.status}: ${approved.raw}`);
  check(
    approved.body.auction.status === 'scheduled',
    `after approval, status was ${approved.body.auction.status}`,
  );

  // Approving again is a no-op rather than a second effect.
  const reapproved = await call(`/admin/auctions/${auctionId}/approve`, {
    method: 'POST',
    token: managerSession.token,
  });
  check(reapproved.status === 200, `re-approve returned ${reapproved.status}`);
  check(reapproved.body.changed === false, 're-approving reported a change');
  console.log('smoke-catalog: manager approves, and approving twice changes nothing');

  // --- the auction is now public ------------------------------------------
  const publicDetail = await call(`/auctions/${auctionSlug}`);
  check(publicDetail.status === 200, `the public detail returned ${publicDetail.status}`);
  check(publicDetail.body.id === auctionId, 'the slug resolved to a different auction');
  check(publicDetail.body.terms.minBidMinor === '100', 'the terms did not survive the round trip');
  check(
    /"bidFeeMinor":"500"/.test(publicDetail.raw),
    `money was not serialised as a string: ${publicDetail.raw}`,
  );

  // Nothing about anyone's bids may appear in a public payload.
  for (const forbidden of [
    'bidCount',
    'bids',
    'participantCount',
    'uniqueAmountCount',
    'winnerUserId',
    'winningAmountMinor',
    'sellerId',
  ]) {
    check(!Object.hasOwn(publicDetail.body, forbidden), `the public auction payload exposed ${forbidden}`);
  }

  const inListing = await call('/auctions');
  check(
    inListing.body.auctions.some((item) => item.id === auctionId),
    'the approved auction did not appear in public discovery',
  );
  console.log('smoke-catalog: the approved auction is public, and leaks no bid data');

  // --- both channels reach the same auction -------------------------------
  const before = sent.length;
  check((await deliverUpdate(message('/auctions'))) === 200, 'the webhook rejected /auctions');
  const listMessage = lastSent('sendMessage');
  check(listMessage !== undefined, '/auctions sent no message');
  check(
    String(listMessage.text).includes(`Smoke Telephone ${RUN_TAG}`),
    `the bot's list did not show the auction: ${JSON.stringify(listMessage.text)}`,
  );
  check(sent.length > before, 'the bot sent nothing at all');

  // The inline keyboard must carry a compact id and nothing else. The list can
  // legitimately contain other auctions, so this looks for *ours*.
  const keyboard = listMessage.reply_markup?.inline_keyboard ?? [];
  const buttons = keyboard.flat().filter((item) => typeof item.callback_data === 'string');
  check(buttons.length > 0, 'the list had no inline button');
  const button = buttons.find((item) => item.callback_data === `a:${auctionId}`);
  check(
    button !== undefined,
    `no button opened this run's auction; payloads were ${JSON.stringify(
      buttons.map((item) => item.callback_data),
    )}`,
  );
  for (const item of buttons) {
    check(
      Buffer.byteLength(item.callback_data, 'utf8') <= 64,
      `a callback payload exceeds the 64-byte limit: ${item.callback_data}`,
    );
    // A payload carries an identifier and nothing else — no status, no price.
    check(
      /^(a|al|ab):/.test(item.callback_data),
      `a callback payload had an unexpected shape: ${item.callback_data}`,
    );
  }
  console.log('smoke-catalog: Telegram /auctions lists the auction with a compact callback');

  // Opening it from the keyboard, exactly as a tap would.
  check(
    (await deliverUpdate(callbackQuery(button.callback_data))) === 200,
    'the webhook rejected the callback',
  );
  const detailMessage = lastSent('sendMessage');
  const detailText = String(detailMessage.text);
  check(detailText.includes(`Smoke Telephone ${RUN_TAG}`), 'the bot detail omitted the product');
  check(detailText.includes('1.00 ETB'), 'the bot detail omitted the minimum bid');
  check(detailText.includes('50.00 ETB'), 'the bot detail omitted the maximum bid');
  check(detailText.includes('5.00 ETB per bid'), 'the bot detail omitted the participation fee');
  check(detailText.includes('Up to 25 bids each'), 'the bot detail omitted the per-person limit');
  check(detailText.includes('120000.00 ETB'), 'the bot detail omitted the reference price');
  check(detailText.includes('lowest bid nobody else matched'), 'the bot detail did not explain the format');
  check(detailText.includes(auctionSlug), 'the bot detail did not link to the website page');
  check(
    !/bids so far|bidders|participants|current lowest|winning bid/i.test(detailText),
    'the bot detail leaked information about bids',
  );
  console.log('smoke-catalog: Telegram detail renders the same auction the website shows');

  // The bidding placeholder explains itself rather than doing nothing.
  check(
    (await deliverUpdate(callbackQuery(`ab:${auctionId}`))) === 200,
    'the webhook rejected the bid placeholder',
  );
  const answered = lastSent('answerCallbackQuery');
  check(answered !== undefined, 'the bid placeholder answered nothing');
  check(
    /coming soon|not opened yet|no longer taking bids/i.test(String(answered.text ?? '')),
    `the bid placeholder said: ${JSON.stringify(answered.text)}`,
  );
  console.log('smoke-catalog: Telegram has no bidding, and says so');

  // A draft must stay invisible to Telegram too, even when its id is supplied
  // directly in a callback payload. Its own product, so the auction is not
  // refused for want of stock — a skipped check would prove nothing.
  const draftProduct = await call('/seller/products', {
    method: 'POST',
    token: sellerSession.token,
    body: {
      title: `Smoke Draft Product ${RUN_TAG}`,
      description: 'A second smoke-test product, for the draft-visibility check.',
      retailPriceMinor: '500000',
      stockQuantity: 1,
      condition: 'new',
    },
  });
  check(draftProduct.status === 201, `the draft product returned ${draftProduct.status}`);
  await call(`/seller/products/${draftProduct.body.id}`, {
    method: 'PATCH',
    token: sellerSession.token,
    body: { status: 'active' },
  });

  const draft = await call('/seller/auctions', {
    method: 'POST',
    token: sellerSession.token,
    body: {
      ...auctionBody,
      title: `Second Smoke Draft ${RUN_TAG}`,
      productId: draftProduct.body.id,
      maxBidMinor: '1000',
    },
  });
  check(draft.status === 201, `the draft auction returned ${draft.status}: ${draft.raw}`);
  check(draft.body.status === 'draft', `the second auction was ${draft.body.status}`);

  const draftText = `Second Smoke Draft ${RUN_TAG}`;
  await deliverUpdate(callbackQuery(`a:${draft.body.id}`));
  const afterDraft = String(lastSent('sendMessage')?.text ?? '');
  check(
    !afterDraft.includes(draftText) && !afterDraft.includes(`Smoke Draft Product ${RUN_TAG}`),
    `Telegram rendered a draft auction: ${afterDraft.slice(0, 200)}`,
  );
  check(
    /does not exist/i.test(afterDraft) || afterDraft.includes(`Smoke Telephone ${RUN_TAG}`),
    `Telegram gave an unexpected answer for a draft: ${afterDraft.slice(0, 200)}`,
  );
  console.log('smoke-catalog: Telegram refuses a draft auction named in a callback');

  // An unauthenticated webhook delivery is refused.
  const unsigned = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ update_id: 1, ...message('/auctions') }),
  });
  check(unsigned.status === 401, `an unsigned webhook delivery returned ${unsigned.status}`);
  console.log('smoke-catalog: an unsigned webhook delivery is refused');

  // --- staff operations ----------------------------------------------------
  const noReason = await call(`/admin/auctions/${auctionId}/suspend`, {
    method: 'POST',
    token: managerSession.token,
    body: {},
  });
  check(noReason.status === 400, `suspending without a reason returned ${noReason.status}`);

  const suspended = await call(`/admin/auctions/${auctionId}/suspend`, {
    method: 'POST',
    token: managerSession.token,
    body: { reason: 'Suspended by the smoke test' },
  });
  check(suspended.status === 200, `suspend returned ${suspended.status}: ${suspended.raw}`);

  // A suspended auction is hidden from the public again.
  const hiddenAgain = await call(`/auctions/${auctionSlug}`);
  check(hiddenAgain.status === 404, `a suspended auction returned ${hiddenAgain.status} publicly`);

  const resumed = await call(`/admin/auctions/${auctionId}/resume`, {
    method: 'POST',
    token: managerSession.token,
  });
  check(resumed.status === 200, `resume returned ${resumed.status}`);
  check(
    resumed.body.auction.status === 'scheduled',
    `resume restored ${resumed.body.auction.status}, expected scheduled`,
  );
  console.log('smoke-catalog: suspend hides the auction, resume restores its previous state');

  // Live terms cannot be edited. Made live directly, since the worker owns
  // opening and this is about the edit refusal.
  await db.query(
    `UPDATE auctions SET starts_at = now() - interval '1 hour', status = 'live', opened_at = now()
      WHERE id = $1`,
    [auctionId],
  );
  const lateEdit = await call(`/seller/auctions/${auctionId}`, {
    method: 'PATCH',
    token: sellerSession.token,
    body: { minBidMinor: '200' },
  });
  check(lateEdit.status === 409, `editing a live auction returned ${lateEdit.status}`);
  check(
    lateEdit.body.error.details.auctionError === 'AUCTION_IMMUTABLE',
    `editing a live auction reported ${JSON.stringify(lateEdit.body.error.details)}`,
  );
  console.log('smoke-catalog: a live auction’s terms cannot be edited');

  // A seller cannot reach another seller's auction.
  const otherSeller = await newAccount('Smoke Other Seller', '4');
  await db.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'seller') ON CONFLICT DO NOTHING`, [
    otherSeller.userId,
  ]);
  await db.query(
    `INSERT INTO sellers (user_id, display_name, status, approved_at)
     VALUES ($1, 'Smoke Other Shop', 'approved', now())`,
    [otherSeller.userId],
  );
  const otherSession = await reissueToken(otherSeller.phone);
  const crossRead = await call(`/seller/auctions/${auctionId}`, { token: otherSession.token });
  check(crossRead.status === 403, `cross-seller auction read returned ${crossRead.status}`);
  const crossProduct = await call(`/seller/products/${productId}`, { token: otherSession.token });
  check(crossProduct.status === 403, `cross-seller product read returned ${crossProduct.status}`);
  console.log('smoke-catalog: one seller cannot reach another’s listing');

  console.log('smoke-catalog: OK');
  stop();
  process.exit(0);
}

main().catch((error) => fail(error instanceof Error ? (error.stack ?? error.message) : String(error)));
