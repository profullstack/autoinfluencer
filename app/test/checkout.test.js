import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { PACKS } from '../src/coinpay.js';
import { CHECKOUT_ASSETS, creditsCheckout, packOptions } from '../src/checkout.js';

const SITE = 'https://influencer.marketing.pit.world';
const ai = { generateObject: async () => { throw new Error('unused'); } };

// What each pack has always cost. A change here is a price change.
const PRICES = { t1000: [1000, 1000], t2750: [2750, 2500], t6000: [6000, 5000], t13000: [13000, 10000], 'solo-month': [0, 4900], 'solo-year': [0, 49000], 'studio-month': [0, 14900], 'studio-year': [0, 149000] };

/** A checkout whose `start` (coinpay.checkout in the app) only records what it was asked. */
function wired({ who = { id: 'acc_1', email: 'ada@example.com' }, packs } = {}) {
  const calls = [];
  const checkout = creditsCheckout({
    publicUrl: SITE,
    account: (cookieHeader) => (cookieHeader === 'ai_sid=ok' ? who : null),
    start: async (accountId, pack) => {
      calls.push([accountId, pack]);
      return { url: 'https://coinpayportal.com/checkout/cs_test1', id: 'chk_test1' };
    },
    ...(packs ? { packs } : {}),
  });
  return { checkout, calls };
}

const formPost = (checkout, fields, headers = {}) =>
  checkout.POST(
    new Request(`${SITE}/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: SITE, referer: `${SITE}/checkout`, cookie: 'ai_sid=ok', ...headers },
      body: new URLSearchParams(fields),
    }),
  );

test('the option table is the pack table', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(PACKS).map(([id, p]) => [id, [p.credits, Math.round(p.usd * 100)]])), PRICES);
  assert.deepEqual(packOptions().slice(0, 5), [
    { id: 't1000', name: '1,000 credits', price: 10 },
    { id: 't2750', name: '2,750 credits', price: 25 },
    { id: 't6000', name: '6,000 credits', price: 50 },
    { id: 't13000', name: '13,000 credits', price: 100 },
    { id: 'solo-month', name: 'Solo plan · 1 month', price: 49 },
  ]);
  const { checkout } = wired();
  assert.deepEqual(checkout.config.options.map((o) => [o.id, o.kind, o.chargeCents]), Object.entries(PRICES).map(([id, [, c]]) => [id, 'once', c]));
  assert.equal(checkout.config.hasDiscount, false);
  assert.equal(checkout.config.guarantee, '');
  assert.equal(checkout.config.custom, null);
  assert.equal(checkout.config.requireAccount, true);
  assert.equal(checkout.view({ query: 'option=studio-year' }).selected, 'studio-year');
  assert.equal(checkout.view({ query: 'option=lifetime' }).selected, 't1000');
  assert.equal(checkout.view({ query: 'option=t2750' }).total, 'USD 25.00');
});

test('the assets are the package files, as one script with no imports', () => {
  assert.match(String(CHECKOUT_ASSETS['/assets/checkout.css'].body), /\.pfc/);
  assert.doesNotMatch(String(CHECKOUT_ASSETS['/assets/checkout.js'].body), /^\s*import\s/m);
});

test('pay() starts the existing checkout for the signed-in account and the chosen pack', async () => {
  for (const pack of Object.keys(PACKS)) {
    const { checkout, calls } = wired();
    const res = await formPost(checkout, { option: pack });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), 'https://coinpayportal.com/checkout/cs_test1');
    assert.deepEqual(calls, [['acc_1', pack]]);
  }
  // Nothing in the form decides who pays or how much.
  const { checkout, calls } = wired();
  await formPost(checkout, { option: 't1000', email: 'someone-else@example.com', account: 'acc_9', quantity: '9', amount: '1' });
  assert.deepEqual(calls, [['acc_1', 't1000']]);
  const coded = await formPost(checkout, { option: 't1000', code: 'FREE' });
  assert.equal(coded.status, 303);
  assert.match(coded.headers.get('location'), /error=invalid_code/);
  assert.equal(calls.length, 1);
});

test('signed out, another site, an unknown pack: nothing is started', async () => {
  const { checkout, calls } = wired();
  const out = await formPost(checkout, { option: 't2750' }, { cookie: '' });
  assert.equal(out.status, 303);
  assert.equal(out.headers.get('location'), `/api/v1/coinpay/oauth/start?next=${encodeURIComponent('/checkout?option=t2750')}`);
  assert.equal(checkout.signInUrl('option=t2750'), out.headers.get('location'));

  const foreign = await formPost(checkout, { option: 't2750' }, { origin: 'https://evil.example' });
  assert.equal(foreign.status, 303);
  assert.match(foreign.headers.get('location'), /error=bad_origin/);

  const unknown = await formPost(checkout, { option: 'lifetime' });
  assert.match(unknown.headers.get('location'), /error=invalid_option/);
  assert.equal(calls.length, 0);
});

test('a price that is not the pack price is refused before anything is started', async () => {
  // The page shows the price the options were built with; the guard reads what would be charged now.
  const packs = { starter: { credits: 100, usd: 5 } };
  const { checkout, calls } = wired({ packs });
  assert.equal((await formPost(checkout, { option: 'starter' })).headers.get('location'), 'https://coinpayportal.com/checkout/cs_test1');
  assert.equal(calls.length, 1);
  packs.starter.usd = 6;
  const res = await formPost(checkout, { option: 'starter' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/checkout?option=starter&error=payment_unavailable');
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------- the app
// A fake CoinPay: OAuth token + userinfo through the injected fetch, checkout sessions over HTTP.
async function start() {
  const sessions = [];
  const cp = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/api/checkout/sessions') return res.writeHead(404).end('{}');
      const id = `cs_page${sessions.length + 1}`;
      sessions.push({ body: JSON.parse(raw), key: req.headers['idempotency-key'] });
      res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ id, url: `https://coinpayportal.com/checkout/${id}` }));
    });
  });
  await new Promise((r) => cp.listen(0, '127.0.0.1', r));
  const coinpayFetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/api/oauth/token')) return Response.json({ access_token: 'cp_at', token_type: 'Bearer' });
    if (u.endsWith('/api/oauth/userinfo')) return Response.json({ sub: 'cp-user-1', email: 'ada@example.com', name: 'Ada' });
    return fetch(url, init);
  };
  const db = openDb(':memory:');
  const env = { PUBLIC_URL: 'http://127.0.0.1', COINPAY_OAUTH_CLIENT_ID: 'cid', COINPAY_OAUTH_CLIENT_SECRET: 'sek', COINPAY_WEBHOOK_SECRET: 'whs', COINPAY_API_KEY: 'cp_test_key', COINPAY_API_URL: `http://127.0.0.1:${cp.address().port}` };
  const server = createServer(await createApp({ env, db, ai, fetch: coinpayFetch }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, base, sessions, close: () => (server.close(), cp.close()) };
}

async function signIn(base, returnTo = 'return_to=/') {
  const s = await fetch(`${base}/api/v1/coinpay/oauth/start?${returnTo}`, { redirect: 'manual' });
  const state = new URL(s.headers.get('location')).searchParams.get('state');
  const cb = await fetch(`${base}/api/v1/coinpay/oauth/callback?code=c1&state=${state}`, { redirect: 'manual', headers: { cookie: `ai_cp_state=${state}` } });
  return { cookie: cb.headers.getSetCookie().find((c) => c.startsWith('ai_sid=')).split(';')[0], location: cb.headers.get('location') };
}

const pagePost = (base, fields, headers = {}) =>
  fetch(`${base}/checkout`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, referer: `${base}/checkout`, ...headers }, body: new URLSearchParams(fields) });

test('signed out: the page and the form both go to sign-in and come back with the pack', async () => {
  const app = await start();
  try {
    const next = `/api/v1/coinpay/oauth/start?next=${encodeURIComponent('/checkout?option=t2750')}`;
    const page = await fetch(`${app.base}/checkout?option=t2750`, { redirect: 'manual' });
    assert.equal(page.status, 302);
    assert.equal(page.headers.get('location'), next);
    const posted = await pagePost(app.base, { option: 't2750' });
    assert.equal(posted.status, 303);
    assert.equal(posted.headers.get('location'), next);
    assert.equal((await signIn(app.base, `next=${encodeURIComponent('/checkout?option=t2750')}`)).location, '/checkout?option=t2750');
    assert.equal((await signIn(app.base, `next=${encodeURIComponent('//evil.example/x')}`)).location, '/');
    assert.equal(app.sessions.length, 0);

    const home = await (await fetch(`${app.base}/`)).text();
    for (const pack of Object.keys(PACKS)) assert.ok(home.includes(`href="/checkout?option=${pack}"`), pack);
    assert.doesNotMatch(home, /data-pack/);
    assert.doesNotMatch(await (await fetch(`${app.base}/app.js`)).text(), /credits\/checkout/);
  } finally {
    app.close();
  }
});

test('signed in: the page renders as a plain form with our own assets and the footers', async () => {
  const app = await start();
  try {
    const { cookie } = await signIn(app.base);
    const res = await fetch(`${app.base}/checkout?option=studio-year`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const html = await res.text();
    assert.match(html, /<form class="pfc-main" method="post" action="\/checkout">/);
    assert.match(html, /Buying as <strong>ada@example\.com<\/strong>/);
    assert.match(html, /<input type="radio" name="option" value="studio-year" checked required>/);
    assert.match(html, /400 credits · Free plan/);
    assert.match(html, /site-footer/);
    assert.match(html, /<link rel="stylesheet" href="\/assets\/checkout\.css\?v=[0-9a-f]+">/);
    assert.match(html, /<script type="module" src="\/assets\/checkout\.js\?v=[0-9a-f]+"><\/script>/);
    const section = html.slice(html.indexOf('<section class="pfc"'), html.indexOf('</section>'));
    assert.doesNotMatch(section, /<script|<style|type="email"|name="code"/);
    assert.doesNotMatch(html.slice(0, html.indexOf('</main>')), /<script|<style| style="/);
    // The page's files arrive as themselves: the package's two, and the site stylesheet that themes them.
    for (const [path, type, starts] of [['/assets/checkout.css', 'text/css', '/* @profullstack/checkout'], ['/assets/checkout.js', 'text/javascript', ''], ['/style.css', 'text/css', ':root']]) {
      const a = await fetch(`${app.base}${path}`);
      assert.equal(a.status, 200);
      assert.ok(a.headers.get('content-type').startsWith(type));
      const text = await a.text();
      assert.ok(text.startsWith(starts) && !text.startsWith('{"type":"Buffer"'), path);
    }
    assert.match(await (await fetch(`${app.base}/style.css`)).text(), /\.pfc \{ --pfc-accent: var\(--accent\)/);
    const icon = await fetch(`${app.base}/icon-192.png`);
    assert.deepEqual([...new Uint8Array(await icon.arrayBuffer()).slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  } finally {
    app.close();
  }
});

test('the page opens the same CoinPay session as POST /api/v1/credits/checkout, for every pack', async () => {
  const app = await start();
  try {
    const { cookie } = await signIn(app.base);
    const account = app.db.accountBySub('cp-user-1');
    for (const [pack, [credits, cents]] of Object.entries(PRICES)) {
      app.sessions.length = 0;
      const api = await fetch(`${app.base}/api/v1/credits/checkout`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ pack }) });
      assert.equal(api.status, 200);
      const answer = await api.json();
      assert.equal(answer.url, 'https://coinpayportal.com/checkout/cs_page1');

      const page = await pagePost(app.base, { option: pack, email: 'someone-else@example.com', quantity: '5', amount: '1' }, { cookie });
      assert.equal(page.status, 303);
      assert.equal(page.headers.get('location'), 'https://coinpayportal.com/checkout/cs_page2');

      const [viaApi, viaPage] = app.sessions.map((s) => s.body);
      const id = (b) => b.metadata.checkout_id;
      assert.equal(id(viaApi), answer.id);
      assert.match(id(viaPage), /^chk_/);
      assert.equal(app.sessions[1].key, `autoinfluencer-${id(viaPage)}`);
      // Only the per-purchase checkout id may differ.
      assert.deepEqual({ ...viaPage, metadata: { ...viaPage.metadata, checkout_id: id(viaApi) } }, viaApi);
      assert.deepEqual(viaPage, {
        amount: cents / 100,
        currency: 'USD',
        description: PACKS[pack].plan ? `autoinfluencer: ${PACKS[pack].name}` : `autoinfluencer: ${credits} credits`,
        customer_email: 'ada@example.com',
        account_id: account.id,
        property: 'influencer.marketing.pit.world',
        metadata: { checkout_id: id(viaPage), account_id: account.id, pack },
        success_url: 'http://127.0.0.1/?paid=1',
        cancel_url: 'http://127.0.0.1/',
        expires_in_minutes: 120,
      });
      // The grant the webhook will make is the one recorded for the page's purchase.
      const row = app.db.checkout(id(viaPage));
      assert.deepEqual([row.account_id, row.pack, row.credits], [account.id, pack, credits]);
    }
  } finally {
    app.close();
  }
});

test('a form posted from another site is refused, signed in or not', async () => {
  const app = await start();
  try {
    const { cookie } = await signIn(app.base);
    for (const headers of [{ cookie, origin: 'https://evil.example' }, { origin: 'https://evil.example' }, { cookie, origin: 'null' }]) {
      const res = await pagePost(app.base, { option: 't1000' }, headers);
      assert.equal(res.status, 403);
    }
    const unknown = await pagePost(app.base, { option: 'lifetime' }, { cookie });
    assert.equal(unknown.status, 303);
    assert.equal(unknown.headers.get('location'), '/checkout?option=lifetime&error=invalid_option');
    assert.equal(app.sessions.length, 0);
    assert.equal((await fetch(`${app.base}/checkout`, { method: 'DELETE' })).status, 405);
  } finally {
    app.close();
  }
});
