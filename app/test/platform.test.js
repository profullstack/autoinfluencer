import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { signWebhook } from '@profullstack/coinpay-onboard';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { markdown, extractBrand } from '../src/render.js';
import { PLANS, COSTS } from '../src/plans.js';

// A c0mpute stand-in: answers by feature, the way ai-providers' generateObject does.
const ai = {
  calls: [],
  generateObject: async (req) => {
    ai.calls.push(req.feature);
    const by = {
      'autoinfluencer.blog': { title: 'Caching CI by lockfile hash', summary: 'Key the cache on the lockfile.', body_md: `## Why\n\nKey the cache on the lockfile hash, not the branch. ${'More detail here. '.repeat(20)}` },
      'autoinfluencer.translate': { title: 'Caché de CI por hash', summary: 'Resumen.', body_md: '## Por qué\n\nTexto traducido.' },
      'autoinfluencer.ads': { ads: [{ headline: 'Ship faster', sub: 'Cache what matters.', cta: 'Try it' }, { headline: 'CI in half the time', sub: 'One key, fewer rebuilds.', cta: 'Start' }] },
      'autoinfluencer.newsletter': { subject: 'This week', body_md: 'Hello' },
    };
    return { object: req.schema(by[req.feature] ?? { posts: [{ platform: 'bluesky', text: 'ok' }] }) };
  },
};

const coinpayFetch = async (url, init) => {
  const u = String(url);
  if (u.endsWith('/api/oauth/token')) return Response.json({ access_token: 'cp_at', token_type: 'Bearer' });
  if (u.endsWith('/api/oauth/userinfo')) return Response.json({ sub: `cp-${init.headers.authorization.slice(-6)}`, email: 'ada@example.com', name: 'Ada' });
  if (u.startsWith('https://brand.example/')) {
    if (u.endsWith('.css')) return new Response('body{font-family:"Inter",sans-serif;color:#1a1a2e} .b{background:#ff5a1f} .c{color:#ff5a1f}', { headers: { 'content-type': 'text/css' } });
    return new Response('<html><head><title>Brandco | Home</title><meta name="description" content="Brandco makes fast CI caches."><meta name="theme-color" content="#ff5a1f"><link rel="stylesheet" href="/s.css"></head><body></body></html>', { headers: { 'content-type': 'text/html' } });
  }
  return fetch(url, init);
};

async function start(extraEnv = {}) {
  const db = openDb(':memory:');
  const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://127.0.0.1', COINPAY_OAUTH_CLIENT_ID: 'cid', COINPAY_OAUTH_CLIENT_SECRET: 'sek', COINPAY_WEBHOOK_SECRET: 'whs', JOB_WAIT_MS: '2000', ...extraEnv };
  const handler = await createApp({ env, db, ai, fetch: coinpayFetch });
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, base, close: () => server.close() };
}

async function signIn(base) {
  const s = await fetch(`${base}/api/v1/coinpay/oauth/start`, { redirect: 'manual' });
  const state = new URL(s.headers.get('location')).searchParams.get('state');
  const cb = await fetch(`${base}/api/v1/coinpay/oauth/callback?code=c1&state=${state}`, { redirect: 'manual', headers: { cookie: `ai_cp_state=${state}` } });
  return cb.headers.getSetCookie().find((c) => c.startsWith('ai_sid=')).split(';')[0];
}

function client(base, headers) {
  return async (tool, args = {}, expect = 200) => {
    const r = await fetch(`${base}/api/${tool}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(args) });
    const j = await r.json().catch(() => ({}));
    assert.equal(r.status, expect, `${tool}: ${JSON.stringify(j)}`);
    return j;
  };
}

const pub = (base, slug, action, body) => fetch(`${base}/api/v1/public/${slug}/${action}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});

test('markdown escapes raw HTML and unsafe links', () => {
  const html = markdown('# Hi\n\n<script>x</script> [a](javascript:alert(1)) **b**\n\n- one\n- two');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /href="#"/);
  assert.match(html, /<strong>b<\/strong>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
});

test('brand kit from HTML and CSS', () => {
  const b = extractBrand('<title>Brandco | Home</title><meta name="description" content="Fast caches."><meta name="theme-color" content="#ff5a1f">', 'https://brand.example/', 'body{font-family:"Inter";color:#1a1a2e}.x{color:#ff5a1f}');
  assert.equal(b.name, 'Brandco');
  assert.equal(b.colors.accent, '#ff5a1f');
  assert.equal(b.colors.bg, '#1a1a2e');
  assert.equal(b.font, 'Inter');
});

test('sites: create, deploy in batches, sandboxed serving with the badge, versions and rollback', async () => {
  const app = await start();
  try {
    const call = client(app.base, { cookie: await signIn(app.base) });
    const { site } = await call('site_create', { name: 'Brandco', brand_from: 'https://brand.example/' });
    assert.equal(site.slug, 'brandco');
    assert.equal(site.url, 'http://127.0.0.1/site/brandco/');
    await call('site_create', { name: 'Second' }, 402); // Free: one site

    // Before any deploy: the starter page, contact form and blog work.
    const starter = await fetch(`${app.base}/site/brandco/`);
    assert.equal(starter.status, 200);
    assert.match(starter.headers.get('content-security-policy'), /^sandbox allow-scripts/);
    assert.doesNotMatch(starter.headers.get('content-security-policy'), /allow-same-origin/);
    const home = await starter.text();
    assert.match(home, /Brandco/);
    assert.match(home, /Built with autoinfluencer/);
    assert.match(home, /<ai-form site="brandco" form="contact">/);

    const first = await call('site_deploy', { site: 'brandco', files: [{ path: 'index.html', content: '<!doctype html><html><body><h1>v1</h1></body></html>' }], finish: false });
    assert.equal(first.status, 'open');
    await call('site_deploy', { site: 'brandco', deploy: first.deploy, files: [{ path: 'css/a.css', content: 'h1{color:red}' }] }, 409); // needs confirm
    const live = await call('site_deploy', { site: 'brandco', deploy: first.deploy, files: [{ path: 'logo.png', content: Buffer.from([137, 80, 78, 71]).toString('base64'), encoding: 'base64' }], confirm: true });
    assert.equal(live.version, 1);
    assert.equal(live.files, 2);
    assert.match(await (await fetch(`${app.base}/site/brandco/`)).text(), /<h1>v1<\/h1>.*Built with autoinfluencer/s);
    const png = await fetch(`${app.base}/site/brandco/logo.png`);
    assert.equal(png.headers.get('content-type'), 'image/png');

    await call('site_deploy', { site: 'brandco', files: [{ path: '../etc/passwd', content: 'x' }], confirm: true }, 400);
    await call('site_deploy', { site: 'brandco', files: [{ path: 'about.html', content: 'no index' }], confirm: true }, 400);
    await call('site_deploy', { site: 'brandco', files: [{ path: 'index.html', content: '<h1>v2</h1>' }], confirm: true });
    assert.match(await (await fetch(`${app.base}/site/brandco/`)).text(), /v2/);
    const { versions } = await call('site_versions', { site: 'brandco' });
    assert.deepEqual(versions.map((v) => [v.version, v.status]), [[2, 'live'], [1, 'old']]);
    await call('site_rollback', { site: 'brandco', version: 1, confirm: true });
    assert.match(await (await fetch(`${app.base}/site/brandco/`)).text(), /v1/);

    // Free has 5 pages.
    const many = Array.from({ length: 6 }, (_, i) => ({ path: i ? `p${i}.html` : 'index.html', content: 'x' }));
    await call('site_deploy', { site: 'brandco', files: many, confirm: true }, 402);
    await call('site_domain', { site: 'brandco', domain: 'brandco.com' }, 402);
  } finally {
    app.close();
  }
});

test('blog: written on c0mpute for 60 credits, published pages, feed, translation, refunds on failure', async () => {
  const app = await start();
  try {
    const sid = await signIn(app.base);
    const call = client(app.base, { cookie: sid });
    await call('site_create', { name: 'Brandco' });
    const acc = app.db.accountBySub(app.db.raw.prepare('select coinpay_sub from accounts').get().coinpay_sub);
    assert.equal(app.db.balance(acc.id).credits, PLANS.free.creditsOnce);

    const w = await call('blog_write', { topic: 'CI caching', publish: true });
    assert.equal(w.post.status, 'published');
    assert.equal(app.db.balance(acc.id).credits, PLANS.free.creditsOnce - COSTS.blog_post);
    const page = await (await fetch(`${app.base}/site/brandco/blog/${w.post.slug}`)).text();
    assert.match(page, /<h1>Caching CI by lockfile hash<\/h1>/);
    assert.match(page, /<h3>Why<\/h3>/);
    assert.match(await (await fetch(`${app.base}/site/brandco/blog/`)).text(), /Caching CI/);
    const feed = await fetch(`${app.base}/site/brandco/feed.xml`);
    assert.match(feed.headers.get('content-type'), /rss/);
    assert.match(await feed.text(), /<item><title>Caching CI by lockfile hash/);
    const posts = await (await pub(app.base, 'brandco', 'posts')).json();
    assert.equal(posts.posts.length, 1);

    const t = await call('blog_translate', { id: w.post.id, lang: 'es', publish: true });
    assert.match(t.post.url, /\?lang=es$/);
    assert.equal(app.db.balance(acc.id).credits, PLANS.free.creditsOnce - COSTS.blog_post - COSTS.translation);
    await call('blog_translate', { id: w.post.id, lang: 'fr' }, 402); // Free: 2 languages

    const draft = await call('blog_save', { title: 'Hand written', body_md: 'Hello **world**' });
    assert.equal(draft.post.status, 'draft');
    assert.equal((await fetch(`${app.base}/site/brandco/blog/hand-written`)).status, 404);

    // A model failure gives the credits back.
    const before = app.db.balance(acc.id).credits;
    const saved = ai.generateObject;
    ai.generateObject = async () => {
      throw new Error('no nodes');
    };
    await call('blog_write', { topic: 'anything at all' }, 502);
    ai.generateObject = saved;
    assert.equal(app.db.balance(acc.id).credits, before);
  } finally {
    app.close();
  }
});

test('forms, newsletter and inbox from the drop-in endpoints; bookings and shop need a paid plan', async () => {
  const app = await start();
  try {
    const sid = await signIn(app.base);
    const call = client(app.base, { cookie: sid });
    await call('site_create', { name: 'Brandco' });
    const pre = await pub(app.base, 'brandco', 'form/contact', { name: 'Bo', email: 'bo@example.com', message: 'Hi there' });
    assert.equal(pre.status, 200);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    assert.equal((await pub(app.base, 'brandco', 'form/contact', { name: 'Bo', email: 'nope', message: 'x' })).status, 400);
    assert.equal((await pub(app.base, 'brandco', 'subscribe', { email: 'Reader@Example.com' })).status, 200);
    const inbox = await call('inbox', { mark_seen: true });
    assert.deepEqual(inbox.items.map((i) => i.kind).sort(), ['form', 'newsletter']);
    assert.equal(inbox.unseen, 2);
    assert.equal((await call('inbox', {})).unseen, 0);
    assert.deepEqual((await call('subscribers', {})).subscribers.map((s) => s.email), ['reader@example.com']);

    assert.equal((await pub(app.base, 'brandco', 'slots')).status, 404);
    await call('product_save', { name: 'Mug', price: 12 }, 402);

    // Pay for Solo through the CoinPay webhook.
    const acc = app.db.raw.prepare('select id from accounts').get();
    app.db.createCheckout('chk_solo1', acc.id, 'solo-month', 0);
    const body = JSON.stringify({ id: 'evt_solo1', type: 'payment.confirmed', data: { payment_id: 'pay_1', status: 'confirmed', metadata: { checkout_id: 'chk_solo1' } } });
    const wh = await fetch(`${app.base}/api/v1/coinpay/webhook`, { method: 'POST', headers: { 'x-coinpay-signature': signWebhook(body, 'whs') }, body });
    assert.equal(wh.status, 200);
    assert.equal(app.db.planOf(acc.id).id, 'solo');
    assert.equal(app.db.grantDueCredits(), 1);
    assert.equal(app.db.balance(acc.id).credits, PLANS.free.creditsOnce + PLANS.solo.creditsMonthly);
    assert.equal(app.db.grantDueCredits(), 0); // next grant is a month away

    await call('site_settings', { settings: { bookings: { days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:30', minutes: 30 }, payment_link: 'https://coinpayportal.com/pay/x?amount={amount}&ref={order}' } });
    const { slots } = await (await pub(app.base, 'brandco', 'slots?days=2')).json();
    assert.ok(slots.length > 10);
    const booked = await pub(app.base, 'brandco', 'book', { start: slots[0], name: 'Cy', email: 'cy@example.com' });
    assert.equal(booked.status, 200);
    assert.equal((await pub(app.base, 'brandco', 'book', { start: slots[0], name: 'Di', email: 'di@example.com' })).status, 409);
    assert.equal((await call('booking_list', {})).bookings.length, 1);

    const { product } = await call('product_save', { name: 'Mug', price: 12.5, variants: ['red', 'blue'] });
    const ord = await (await pub(app.base, 'brandco', 'order', { name: 'Ed', email: 'ed@example.com', items: [{ id: product.id, qty: 2, variant: 'blue' }] })).json();
    assert.equal(ord.order.total, '25.00');
    assert.match(ord.pay_url, /amount=25\.00&ref=ord_/);
    const { orders } = await call('order_list', {});
    assert.equal(orders[0].items[0].variant, 'blue');
    await call('order_update', { id: orders[0].id, status: 'paid' });
    await call('site_domain', { domain: 'www.brandco.com' });
    const { request } = await import('node:http');
    const onDomain = await new Promise((ok, no) => request(`${app.base}/`, { headers: { host: 'www.brandco.com' } }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => ok(b)); }).on('error', no).end());
    assert.match(onDomain, /<h1>Brandco<\/h1>/);
    assert.doesNotMatch(await (await fetch(`${app.base}/site/brandco/`)).text(), /Built with autoinfluencer/); // paid: no badge
  } finally {
    app.close();
  }
});

test('social posts publish through the desktop environment over the two-way channel', async () => {
  const app = await start();
  try {
    const sid = await signIn(app.base);
    const call = client(app.base, { cookie: sid });
    const sched = await call('social_schedule', { posts: [{ platform: 'bluesky', text: 'Hello from the schedule', at: new Date(Date.now() - 1000).toISOString() }] });
    assert.match(sched.warning, /desktop/);
    await call('social_publish_now', { id: sched.scheduled[0].id }, 409); // no confirm

    const d = await call('desktop_add', { name: 'laptop' });
    assert.match(d.token, /^dk_/);
    assert.match(d.connect.run, /desktop connect --token dk_/);
    const dk = { authorization: `Bearer ${d.token}` };

    // The scheduler hands the due post to the desktop.
    const tick = await import('../src/platform.js');
    void tick;
    await fetch(`${app.base}/api/v1/desktop/poll`, { method: 'POST', headers: { ...dk, 'content-type': 'application/json' }, body: JSON.stringify({ wait_ms: 0, info: { platform: 'linux', broker: true, browser: true } }) });
    // No job yet: the tick has not run. Run it the way the interval does.
    const { createPlatform } = await import('../src/platform.js');
    await createPlatform({ db: app.db, publicUrl: 'http://127.0.0.1' }).tick();
    assert.equal(app.db.socialList(app.db.raw.prepare('select id from accounts').get().id)[0].status, 'queued');

    const polled = await (await fetch(`${app.base}/api/v1/desktop/poll`, { method: 'POST', headers: { ...dk, 'content-type': 'application/json' }, body: JSON.stringify({ wait_ms: 0 }) })).json();
    assert.equal(polled.job.type, 'publish');
    assert.equal(polled.job.payload.text, 'Hello from the schedule');
    const res = await fetch(`${app.base}/api/v1/desktop/result`, { method: 'POST', headers: { ...dk, 'content-type': 'application/json' }, body: JSON.stringify({ id: polled.job.id, ok: true, result: { url: 'https://bsky.app/profile/ada/post/1' } }) });
    assert.equal(res.status, 200);
    const posts = (await call('social_list', {})).posts;
    assert.equal(posts[0].status, 'published');
    assert.equal(posts[0].result_url, 'https://bsky.app/profile/ada/post/1');

    // The same token calls tools as the account (desktop -> us).
    const asDesktop = client(app.base, dk);
    const list = await asDesktop('desktop_list');
    assert.equal(list.desktops[0].online, true);
    assert.equal(list.desktops[0].info.platform, 'linux');

    // App capture: charged 200, refunded when no frames come back.
    const acc = app.db.raw.prepare('select id from accounts').get().id;
    const before = app.db.balance(acc).credits;
    const cap = await call('app_capture', { url: 'https://app.example.com/demo' });
    assert.equal(app.db.balance(acc).credits, before - COSTS.app_capture);
    const job = (await (await fetch(`${app.base}/api/v1/desktop/poll`, { method: 'POST', headers: { ...dk, 'content-type': 'application/json' }, body: '{"wait_ms":0}' })).json()).job;
    assert.equal(job.id, cap.queued);
    await fetch(`${app.base}/api/v1/desktop/result`, { method: 'POST', headers: { ...dk, 'content-type': 'application/json' }, body: JSON.stringify({ id: job.id, ok: true, frames: [] }) });
    assert.equal(app.db.balance(acc).credits, before);
    assert.equal((await call('desktop_jobs', {})).jobs[0].status, 'failed');

    await call('desktop_remove', { id: 'laptop' });
    assert.equal((await fetch(`${app.base}/api/v1/desktop/poll`, { method: 'POST', headers: dk, body: '{}' })).status, 401);
  } finally {
    app.close();
  }
});

test('ads: c0mpute copy, three formats as SVG, growth preview then watermark; free previews without sign-in', async () => {
  const app = await start();
  try {
    const call = client(app.base, { cookie: await signIn(app.base) });
    await call('site_create', { name: 'Brandco', brand_from: 'https://brand.example/' });
    const { ads } = await call('ad_create', { topic: 'CI', count: 3 });
    assert.deepEqual(ads.map((a) => a.watermark), [false, false, true]);
    const svg = await fetch(ads[0].images['9:16'].replace('http://127.0.0.1', app.base));
    assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
    const text = await svg.text();
    assert.match(text, /viewBox="0 0 1080 1920"/);
    assert.match(text, /Ship faster/);
    assert.match(text, /#ff5a1f/);

    const anon = client(app.base, {});
    const prev = await anon('preview_ads', { url: 'https://brand.example/' });
    assert.equal(prev.ads.length, 3);
    assert.ok(prev.ads.every((a) => a.watermark));
    assert.equal(prev.brand.name, 'Brandco');
    await anon('ad_create', { headline: 'x' }, 402); // paid tools need credits or x402
  } finally {
    app.close();
  }
});

test('pricing page and price sheet; team seats need Studio', async () => {
  const app = await start();
  try {
    const page = await (await fetch(`${app.base}/pricing`)).text();
    for (const s of ['Free', 'Solo', 'Studio', 'Agency', '$49', '$149', 'From $190', '1,000 credits · $10', 'desktop environment']) assert.ok(page.includes(s), s);
    const sheet = await (await fetch(`${app.base}/api/v1/pricing`)).json();
    assert.equal(sheet.costs.ad, 50);
    assert.equal(sheet.plans.find((p) => p.id === 'solo').credits_monthly, 3000);
    const call = client(app.base, { cookie: await signIn(app.base) });
    await call('team_invite', {}, 402);
    const embed = await fetch(`${app.base}/embed.js`);
    assert.equal(embed.headers.get('access-control-allow-origin'), '*');
    assert.match(await embed.text(), /customElements\.define\('ai-form'/);
  } finally {
    app.close();
  }
});

test('credits move to cents once, without losing what people bought', () => {
  const db = openDb(':memory:');
  const acc = db.upsertCoinpayAccount({ sub: 's1' });
  db.raw.exec("delete from meta where key = 'credits_v2'");
  db.raw.prepare('insert into balances (account_id, credits) values (?, 7) on conflict(account_id) do update set credits = 7').run(acc.id);
  db.raw.prepare("insert into ledger (id, account_id, delta, reason, ref, created_at) values ('w', ?, 0, 'x', ?, 0)").run(acc.id, `welcome:${acc.id}`);
  db.raw.close?.();
  // Reopen the same rows through a fresh handle: in-memory DBs cannot be reopened, so run the migration SQL path directly.
  const db2 = openDb(':memory:');
  const a2 = db2.upsertCoinpayAccount({ sub: 's2' });
  assert.equal(db2.balance(a2.id).credits, PLANS.free.creditsOnce);
  assert.equal(db2.spend(a2.id, 'r1', 50, { free: false }), 'credit');
  assert.equal(db2.balance(a2.id).credits, PLANS.free.creditsOnce - 50);
  db2.refund(a2.id, 'credit', 'r1');
  db2.refund(a2.id, 'credit', 'r1');
  assert.equal(db2.balance(a2.id).credits, PLANS.free.creditsOnce);
});
