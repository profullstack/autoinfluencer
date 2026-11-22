import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp, isPaid } from '../src/server.js';
import { openDb } from '../src/db.js';

const persona = {
  name: 'Ada', niche: 'dev tools', audience: 'developers', voice: 'plain', pillars: ['tips'], platforms: ['bluesky'],
};
const goodAi = { generateObject: async (req) => ({ object: req.schema({ posts: [{ platform: 'bluesky', text: 'Key the CI cache on the lockfile hash.' }] }), provider: 'mock', model: 'm' }) };
const deadAi = { generateObject: async () => { throw new Error('no nodes'); } };

// Fake CoinPay: token + userinfo.
const coinpayFetch = async (url, init) => {
  const u = String(url);
  if (u.endsWith('/api/oauth/token')) {
    const body = new URLSearchParams(String(init.body));
    assert.equal(body.get('client_secret'), 'sek');
    assert.ok(body.get('code_verifier'));
    return Response.json({ access_token: 'cp_at', token_type: 'Bearer' });
  }
  if (u.endsWith('/api/oauth/userinfo')) return Response.json({ sub: 'cp-user-1', email: 'unverified@example.com', name: 'Ada' });
  return fetch(url, init);
};

async function start(ai, extraEnv = {}) {
  const db = openDb(':memory:');
  const env = { PUBLIC_URL: 'http://127.0.0.1', COINPAY_OAUTH_CLIENT_ID: 'cid', COINPAY_OAUTH_CLIENT_SECRET: 'sek', COINPAY_WEBHOOK_SECRET: 'whs', JOB_WAIT_MS: '200', ...extraEnv };
  const handler = await createApp({ env, db, ai, fetch: coinpayFetch });
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, base, close: () => server.close() };
}

async function signIn(base) {
  const s = await fetch(`${base}/api/v1/coinpay/oauth/start?return_to=/x`, { redirect: 'manual' });
  assert.equal(s.status, 302);
  const loc = new URL(s.headers.get('location'));
  assert.equal(loc.pathname, '/api/oauth/authorize');
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  const state = loc.searchParams.get('state');
  const cb = await fetch(`${base}/api/v1/coinpay/oauth/callback?code=c1&state=${state}`, { redirect: 'manual', headers: { cookie: `ai_cp_state=${state}` } });
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get('location'), '/x');
  const sid = cb.headers.getSetCookie().find((c) => c.startsWith('ai_sid='));
  assert.ok(sid);
  return sid.split(';')[0];
}

const post = (base, path, body, headers = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('paid vs free calls', () => {
  assert.equal(isPaid('draft', {}), true);
  assert.equal(isPaid('draft', { mode: 'brief' }), false);
  assert.equal(isPaid('calendar', {}), false);
  assert.equal(isPaid('calendar', { withIdeas: true }), true);
  assert.equal(isPaid('lint', {}), false);
});

test('pages, discovery and the MCP OAuth challenge', async () => {
  const app = await start(goodAi);
  try {
    const home = await (await fetch(`${app.base}/`)).text();
    assert.match(home, /Sign in with CoinPay/);
    assert.doesNotMatch(home, /<!--FOOTERS-->/);
    assert.match(home, /site-footer/);
    const meta = await (await fetch(`${app.base}/.well-known/oauth-authorization-server`)).json();
    assert.ok(meta.device_authorization_endpoint);
    const r = await post(app.base, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate'), /resource_metadata=/);
    assert.equal((await fetch(`${app.base}/api/v1/me`)).status, 401);
  } finally {
    app.close();
  }
});

test('CoinPay sign-in binds by sub; free tier, refunds and 402', async () => {
  const app = await start(goodAi);
  try {
    const sid = await signIn(app.base);
    const again = await signIn(app.base);
    assert.notEqual(sid, again);
    assert.equal(app.db.raw.prepare('select count(*) n from accounts').get().n, 1);

    const me = await (await fetch(`${app.base}/api/v1/me`, { headers: { cookie: sid } })).json();
    assert.equal(me.free_left, 3);

    const save = await fetch(`${app.base}/api/v1/persona`, { method: 'PUT', headers: { cookie: sid, 'content-type': 'application/json' }, body: JSON.stringify(persona) });
    assert.equal(save.status, 200);

    const brief = await (await post(app.base, '/api/draft', { topic: 'ci', mode: 'brief' }, { cookie: sid })).json();
    assert.equal(brief.mode, 'brief');

    for (let i = 0; i < 3; i++) {
      const d = await (await post(app.base, '/api/draft', { topic: 'ci' }, { cookie: sid })).json();
      assert.equal(d.mode, 'ai', JSON.stringify(d));
      assert.ok(d.posts[0].text.includes('(AI-assisted)'));
    }
    const out = await post(app.base, '/api/draft', { topic: 'ci' }, { cookie: sid });
    assert.equal(out.status, 402);
    assert.match((await out.json()).error, /no free generations/);

    const acc = app.db.accountBySub('cp-user-1');
    assert.equal(app.db.addCredits(acc.id, 5, 'evt_1'), true);
    assert.equal(app.db.addCredits(acc.id, 5, 'evt_1'), false);
    assert.equal(app.db.balance(acc.id).credits, 5);
    assert.equal((await post(app.base, '/api/draft', { topic: 'ci' }, { cookie: sid })).status, 200);
    assert.equal(app.db.balance(acc.id).credits, 4);
  } finally {
    app.close();
  }
});

test('a generation that falls back to a brief is refunded', async () => {
  const app = await start(deadAi);
  try {
    const sid = await signIn(app.base);
    const d = await (await post(app.base, '/api/draft', { topic: 'ci', persona }, { cookie: sid })).json();
    assert.equal(d.mode, 'brief');
    assert.equal(app.db.balance(app.db.accountBySub('cp-user-1').id).free_left, 3);
  } finally {
    app.close();
  }
});

test('slow generations become jobs you poll', async () => {
  const slow = { generateObject: async (req) => { await new Promise((r) => setTimeout(r, 500)); return goodAi.generateObject(req); } };
  const app = await start(slow);
  try {
    const sid = await signIn(app.base);
    const first = await (await post(app.base, '/api/draft', { topic: 'ci', persona }, { cookie: sid })).json();
    assert.equal(first.job.status, 'running');
    await new Promise((r) => setTimeout(r, 600));
    const done = await (await post(app.base, '/api/job_status', { id: first.job.id }, { cookie: sid })).json();
    assert.equal(done.job.status, 'done');
    assert.equal(done.job.result.mode, 'ai');
  } finally {
    app.close();
  }
});

test('device flow gives the CLI a bearer that works on /mcp', async () => {
  const app = await start(goodAi);
  try {
    const sid = await signIn(app.base);
    const dev = await (await fetch(`${app.base}/oauth/device_authorization`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'client_id=autoinfluencer-cli' })).json();
    assert.ok(dev.user_code);
    const page = await (await fetch(`${app.base}/oauth/device`, { headers: { cookie: sid } })).text();
    const csrf = JSON.parse(page.match(/var C=("[^"]+")/)[1]);
    const ok = await post(app.base, '/oauth/device', { user_code: dev.user_code, action: 'approve', csrf }, { cookie: sid });
    assert.equal(ok.status, 200);
    const tok = await (await fetch(`${app.base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: dev.device_code, client_id: 'autoinfluencer-cli' }) })).json();
    assert.match(tok.access_token, /^aio_/);
    const h = { authorization: `Bearer ${tok.access_token}`, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' };
    const list = await (await post(app.base, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, h)).json();
    const names = list.result.tools.map((t) => t.name);
    for (const n of ['draft', 'job_status', 'persona_save', 'balance']) assert.ok(names.includes(n), n);
    assert.equal((await post(app.base, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { ...h, authorization: 'Bearer aio_bogus' })).status, 401);
  } finally {
    app.close();
  }
});

test('the package CLI client signs in by device code and runs tools remotely', async () => {
  const { login, callRemote } = await import('../../src/remote.js');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const app = await start(goodAi);
  try {
    const sid = await signIn(app.base);
    const env = { AUTOINFLUENCER_HOME: mkdtempSync(join(tmpdir(), 'ai-remote-')) };
    const fastFetch = (url, init) => fetch(url, init);
    const auth = await login({
      url: app.base,
      env,
      fetch: fastFetch,
      onCode: async (d) => {
        const page = await (await fetch(`${app.base}/oauth/device`, { headers: { cookie: sid } })).text();
        const csrf = JSON.parse(page.match(/var C=("[^"]+")/)[1]);
        await post(app.base, '/oauth/device', { user_code: d.user_code, action: 'approve', csrf }, { cookie: sid });
      },
    });
    assert.match(auth.access_token, /^aio_/);
    await callRemote('persona_save', { persona }, { env });
    const d = await callRemote('draft', { topic: 'ci' }, { env });
    assert.equal(d.mode, 'ai');
    const bal = await callRemote('balance', {}, { env });
    assert.equal(bal.free_left, 2);
  } finally {
    app.close();
  }
});

test('anonymous callers get free tools; paid tools answer 402; bad webhooks are refused', async () => {
  const app = await start(goodAi);
  try {
    assert.equal((await post(app.base, '/api/lint', { posts: [{ platform: 'x', text: 'hi' }] })).status, 200);
    assert.equal((await post(app.base, '/api/draft', { topic: 'ci', persona })).status, 402);
    const wh = await fetch(`${app.base}/api/v1/coinpay/webhook`, { method: 'POST', headers: { 'x-coinpay-signature': 't=1,v1=00' }, body: '{}' });
    assert.equal(wh.status, 401);
  } finally {
    app.close();
  }
});
