// The two-way channel end to end: the real app, the package's desktop connector, and a
// stand-in for the W3BS desktop broker (MCP over HTTP on loopback).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { createPlatform } from '../src/platform.js';
import { connect, composeUrl, findButton, Broker } from '../../src/desktop-connector.js';
import { loadTools, groupTools } from '../../src/tui.js';

const coinpayFetch = async (url, init) => {
  const u = String(url);
  if (u.endsWith('/api/oauth/token')) return Response.json({ access_token: 'cp_at', token_type: 'Bearer' });
  if (u.endsWith('/api/oauth/userinfo')) return Response.json({ sub: 'cp-desk', email: 'ada@example.com', name: 'Ada' });
  return fetch(url, init);
};

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

/** A fake broker: records tool calls, shows a composer with a Post button. */
function fakeBroker() {
  const calls = [];
  const handler = async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    if (req.headers.authorization !== 'Bearer agent-token') {
      res.writeHead(401);
      return res.end('{}');
    }
    const msg = JSON.parse(raw);
    if (!msg.id) {
      res.writeHead(202);
      return res.end();
    }
    let result;
    if (msg.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'w3bs-desktop' } };
    else if (msg.method === 'tools/call') {
      const { name, arguments: a } = msg.params;
      calls.push([name, a]);
      const data = {
        desktop_status: { enabled: true },
        browser_status: { supported: true, product: 'TronBrowser' },
        browser_snapshot: { outline: 'uid=3 textbox "Post text" value="Hello"\nuid=7 button "Post"' },
        browser_pages: [{ id: 'p1', url: 'https://bsky.app/profile/ada/post/abc', selected: true }],
      }[name] ?? { ok: true };
      result = name === 'browser_screenshot' ? { content: [{ type: 'image', mimeType: 'image/png', data: Buffer.alloc(400, 1).toString('base64') }] } : { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  };
  return { calls, handler };
}

test('compose URLs and finding the post button', () => {
  assert.equal(composeUrl({ platform: 'bluesky', text: 'hi there' }), 'https://bsky.app/intent/compose?text=hi%20there');
  assert.match(composeUrl({ platform: 'x', text: 'a', link: 'https://e.com' }), /intent\/post\?text=a%0A%0Ahttps%3A%2F%2Fe\.com/);
  assert.match(composeUrl({ platform: 'reddit', text: 'body', subreddit: 'fleetcoding', title: 'T' }), /old\.reddit\.com\/r\/fleetcoding\/submit\?selftext=true&title=T/);
  assert.equal(composeUrl({ platform: 'instagram', text: 'x' }), null);
  assert.equal(findButton('uid=1 link "Home"\nuid=9 button "Post" disabled\nuid=12 button "Post"', /^post$/i), 12);
});

test('a scheduled post goes to the desktop, is published through the W3BS broker, and comes back with its URL', async () => {
  const db = openDb(':memory:');
  const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://127.0.0.1', COINPAY_OAUTH_CLIENT_ID: 'cid', COINPAY_OAUTH_CLIENT_SECRET: 'sek', COINPAY_WEBHOOK_SECRET: 'whs' };
  const app = await listen(await createApp({ env, db, ai: { generateObject: async () => ({}) }, fetch: coinpayFetch }));
  const broker = fakeBroker();
  const b = await listen(broker.handler);
  const ac = new AbortController();
  try {
    const s = await fetch(`${app.base}/api/v1/coinpay/oauth/start`, { redirect: 'manual' });
    const state = new URL(s.headers.get('location')).searchParams.get('state');
    const cb = await fetch(`${app.base}/api/v1/coinpay/oauth/callback?code=c&state=${state}`, { redirect: 'manual', headers: { cookie: `ai_cp_state=${state}` } });
    const cookie = cb.headers.getSetCookie().find((c) => c.startsWith('ai_sid=')).split(';')[0];
    const call = async (tool, args) => (await fetch(`${app.base}/api/${tool}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(args) })).json();

    const { token } = await call('desktop_add', { name: 'bonita' });
    await call('social_schedule', { posts: [{ platform: 'bluesky', text: 'Hello from the desktop layer', at: new Date(Date.now() - 1000).toISOString() }] });
    await createPlatform({ db, publicUrl: 'http://127.0.0.1' }).tick();

    const events = [];
    const done = new Promise((resolve) => {
      connect({ url: app.base, token, brokerUrl: `${b.base}/mcp`, env: { W3BS_DESKTOP_TOKEN: 'agent-token' }, signal: ac.signal, onEvent: (e) => (events.push(e), e.type === 'result' && resolve(e)) }).catch(() => {});
    });
    const result = await done;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result.url, 'https://bsky.app/profile/ada/post/abc');
    assert.equal(events[0].type, 'connected');
    assert.equal(events[0].info.broker, true);

    const names = broker.calls.map(([n]) => n);
    assert.deepEqual(names.filter((n) => !['desktop_status', 'browser_status'].includes(n)), ['task_begin', 'browser_new_page', 'browser_snapshot', 'browser_click', 'browser_pages', 'task_end']);
    assert.equal(broker.calls.find(([n]) => n === 'browser_new_page')[1].url, 'https://bsky.app/intent/compose?text=Hello%20from%20the%20desktop%20layer');
    assert.deepEqual(broker.calls.find(([n]) => n === 'browser_click')[1], { uid: 7 });

    const posts = (await call('social_list', {})).posts;
    assert.equal(posts[0].status, 'published');
    assert.equal(posts[0].result_url, 'https://bsky.app/profile/ada/post/abc');
    const desk = (await call('desktop_list', {})).desktops[0];
    assert.equal(desk.online, true);
    assert.equal(desk.info.broker, true);
  } finally {
    ac.abort();
    app.server.close();
    b.server.close();
  }
});

test('the broker client sends the agent token and keeps its MCP session', async () => {
  const broker = fakeBroker();
  const b = await listen(broker.handler);
  try {
    const c = new Broker({ url: `${b.base}/mcp`, token: 'agent-token' });
    const s = await c.status();
    assert.equal(s.broker, true);
    assert.equal(c.session, 'sess-1');
    const bad = new Broker({ url: `${b.base}/mcp`, token: 'nope' });
    assert.equal((await bad.status()).broker, false);
  } finally {
    b.server.close();
  }
});

test('the TUI and `autoinfluencer tools` see every platform tool, grouped by feature', async () => {
  const db = openDb(':memory:');
  const app = await listen(await createApp({ env: { NODE_ENV: 'test', PUBLIC_URL: 'http://127.0.0.1' }, db, ai: { generateObject: async () => ({}) } }));
  try {
    const tools = await loadTools(app.base);
    const groups = Object.fromEntries(groupTools(tools).map((g) => [g.name, g.tools.map((t) => t.name)]));
    assert.ok(groups.Sites.includes('site_deploy'));
    assert.ok(groups['Desktop environments'].includes('app_capture'));
    assert.ok(groups['Social schedule'].includes('social_publish_now'));
    assert.ok(groups['Write posts'].includes('draft'));
    assert.equal(groups.Other, undefined);
  } finally {
    app.server.close();
  }
});
