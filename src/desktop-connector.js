import { hostname, platform, arch, homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DEFAULT_URL } from './remote.js';

/**
 * The desktop side of the two-way channel between a desktop environment and the hosted app.
 *
 *   desktop -> app  an outbound HTTPS long-poll (POST /api/v1/desktop/poll) with the desktop's
 *                   token: no ports opened, works behind NAT. The same token calls every tool
 *                   as the account, so agents on this computer can use the app too.
 *   app -> desktop  jobs come back on that poll (publish a post, open a page, record an app);
 *                   results go to POST /api/v1/desktop/result.
 *
 * Jobs run through the W3BS Agentic Desktop Layer (https://w3bs.org/desktop): its broker
 * serves MCP on 127.0.0.1:7801/mcp and drives the agent browser by DevTools (snapshot, then
 * click and fill by element uid). Sign-ins, CAPTCHAs and payments go to the person at the
 * desktop with human_step; they are never typed or solved from here.
 */

export const BROKER_URL = 'http://127.0.0.1:7801/mcp';
export const AGENT = 'autoinfluencer';
export const SETUP = [
  'curl -fsSL https://w3bs.org/desktop/install.sh | sh',
  `w3bs desktop agents add ${AGENT} --preset broad`,
  'w3bs desktop browser launch',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The agent token `w3bs desktop agents add autoinfluencer` saved. */
export async function brokerToken(env = process.env) {
  if (env.W3BS_DESKTOP_TOKEN) return env.W3BS_DESKTOP_TOKEN.trim();
  const dir = env.W3BS_DESKTOP_CONFIG_DIR
    || (process.platform === 'win32' ? join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'w3bs', 'desktop', 'config') : join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'w3bs', 'desktop'));
  const file = join(dir, 'tokens', `${env.W3BS_DESKTOP_AGENT || AGENT}.token`);
  return existsSync(file) ? (await readFile(file, 'utf8')).trim() : null;
}

/** A small MCP client for the broker's Streamable HTTP endpoint (JSON responses). */
export class Broker {
  constructor({ url = BROKER_URL, token, fetch: f = globalThis.fetch } = {}) {
    this.url = url;
    this.token = token;
    this.f = f;
    this.session = null;
    this.id = 0;
  }

  async rpc(method, params, notify = false) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${this.token}` };
    if (this.session) headers['mcp-session-id'] = this.session;
    const body = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++this.id, method, params };
    const r = await this.f(this.url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) });
    const sid = r.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    if (notify) return null;
    const text = await r.text();
    if (r.status === 401) throw new Error(`the W3BS desktop broker refused the agent token (run: w3bs desktop agents add ${AGENT} --preset broad)`);
    if (!r.ok) throw new Error(`desktop broker ${r.status}: ${text.slice(0, 200)}`);
    const json = text.trim().startsWith('{') ? JSON.parse(text) : JSON.parse(text.split('\n').filter((l) => l.startsWith('data:')).pop().slice(5));
    if (json.error) throw new Error(json.error.message ?? 'broker error');
    return json.result;
  }

  async open() {
    if (this.session) return;
    await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'autoinfluencer-connector', version: '0.3.0' } });
    await this.rpc('notifications/initialized', {}, true);
  }

  /** Call a broker tool; returns parsed JSON text content, plus any images. */
  async tool(name, args = {}) {
    await this.open();
    const res = await this.rpc('tools/call', { name, arguments: args });
    const texts = (res?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text);
    const images = (res?.content ?? []).filter((c) => c.type === 'image').map((c) => ({ type: c.mimeType || 'image/png', base64: c.data }));
    let data = texts.join('\n');
    try {
      data = JSON.parse(data);
    } catch {
      /* plain text */
    }
    if (res?.isError) {
      const err = new Error(typeof data === 'string' ? data : data?.message ?? JSON.stringify(data));
      err.data = data;
      throw err;
    }
    return { data, images, text: texts.join('\n') };
  }

  async status() {
    try {
      const s = await this.tool('desktop_status');
      const b = await this.tool('browser_status').catch((e) => ({ data: { error: e.message } }));
      return { broker: true, enabled: s.data?.enabled ?? s.data?.state === 'enabled', browser: !b.data?.error && b.data?.supported !== false, browser_detail: b.data };
    } catch (e) {
      return { broker: false, error: e.message };
    }
  }
}

/** Where each network's composer opens with the text already in it. */
export function composeUrl(job, env = process.env) {
  const p = job.platform;
  const text = job.link && !String(job.text).includes(job.link) ? `${job.text}\n\n${job.link}` : job.text;
  const q = encodeURIComponent;
  const title = job.title || String(job.text).split('\n')[0].slice(0, 280);
  switch (p) {
    case 'bluesky': return `https://bsky.app/intent/compose?text=${q(text)}`;
    case 'x': return `https://x.com/intent/post?text=${q(text)}`;
    case 'threads': return `https://www.threads.net/intent/post?text=${q(text)}`;
    case 'linkedin': return `https://www.linkedin.com/feed/?shareActive=true&text=${q(text)}`;
    case 'mastodon': return `https://${job.instance || env.AUTOINFLUENCER_MASTODON || 'mastodon.social'}/share?text=${q(text)}`;
    case 'reddit': return job.link ? `https://old.reddit.com/r/${q(job.subreddit || 'test')}/submit?url=${q(job.link)}&title=${q(title)}` : `https://old.reddit.com/r/${q(job.subreddit || 'test')}/submit?selftext=true&title=${q(title)}&text=${q(job.text)}`;
    case 'hackernews': return job.link ? `https://news.ycombinator.com/submitlink?u=${q(job.link)}&t=${q(title)}` : `https://news.ycombinator.com/submitlink?t=${q(title)}`;
    case 'telegram': return `https://t.me/share/url?url=${q(job.link || '')}&text=${q(job.text)}`;
    case 'facebook': return job.link ? `https://www.facebook.com/sharer/sharer.php?u=${q(job.link)}` : 'https://www.facebook.com/';
    default: return null; // instagram, tiktok, youtube: no web composer that takes text
  }
}

const SUBMIT = {
  bluesky: /^(publish post|post)$/i,
  x: /^post(all)?$/i,
  threads: /^post$/i,
  linkedin: /^post$/i,
  mastodon: /^(publish!?|post|toot!?)$/i,
  reddit: /^(submit|post)$/i,
  hackernews: /^submit$/i,
  facebook: /^(post|share now|post to facebook)$/i,
};

/** `uid=42 button "Post"` lines from a browser_snapshot outline. */
export function findButton(outline, re) {
  for (const line of String(outline).split('\n')) {
    const m = line.match(/uid=(\d+)\s+(button|link|menuitem)\s+"([^"]*)"/);
    if (m && re.test(m[3].trim()) && !/disabled/.test(line)) return Number(m[1]);
  }
  return null;
}
const loginWall = (outline) => /\b(sign in|log in|login|create account)\b/i.test(String(outline)) && !/\b(compose|what's up|what’s happening|start a post)\b/i.test(String(outline));
const outlineOf = (r) => (typeof r.data === 'string' ? r.data : r.data?.outline ?? r.data?.snapshot ?? r.text ?? '');
const pageUrl = (r) => r.data?.url ?? (typeof r.data === 'string' ? r.data.match(/https?:\/\/\S+/)?.[0] : null) ?? null;

async function human(broker, kind, message) {
  const h = await broker.tool('human_step', { kind, message });
  let status = h.data?.status;
  const id = h.data?.human_step ?? h.data?.id;
  for (let i = 0; status === 'pending' && i < 10; i++) {
    await sleep(15_000);
    status = (await broker.tool('human_step_status', { human_step: id })).data?.status;
  }
  if (status !== 'done') throw new Error(`the person at the desktop did not finish the ${kind} step (${status ?? 'no answer'})`);
  await broker.tool('task_begin', { description: 'autoinfluencer: continue after the person\'s step' });
}

/** Run one job on this desktop. Returns { ok, result?, error?, frames? }. */
export async function runJob(job, { broker, env = process.env, log = () => {} }) {
  const p = job.payload ?? {};
  if (job.type === 'publish') return publish(p, { broker, env, log });
  if (job.type === 'capture') return capture(p, { broker, log });
  if (job.type === 'open') {
    await broker.tool('task_begin', { description: `autoinfluencer: open ${p.url}` });
    try {
      await broker.tool('browser_new_page', { url: p.url });
      return { ok: true, result: { url: p.url } };
    } finally {
      await broker.tool('task_end', {}).catch(() => {});
    }
  }
  return { ok: false, error: `this connector does not know job type "${job.type}" (update it: npx -y @profullstack/autoinfluencer@latest)` };
}

async function publish(p, { broker, env, log }) {
  const url = composeUrl(p, env);
  await broker.tool('task_begin', { description: `autoinfluencer: post on ${p.platform}: "${String(p.text).slice(0, 80)}"` });
  try {
    if (!url) {
      // No web composer: hand the post to the person and wait for them.
      await human(broker, 'other', `Post this on ${p.platform} by hand, then press Done:\n\n${p.text}${p.link ? `\n\n${p.link}` : ''}`);
      return { ok: true, result: { url: null, by: 'person' } };
    }
    await broker.tool('browser_new_page', { url });
    await sleep(3500);
    let snap = await broker.tool('browser_snapshot', { max_lines: 2500 });
    let uid = findButton(outlineOf(snap), SUBMIT[p.platform] ?? /^(post|publish|submit|share)$/i);
    if (!uid && loginWall(outlineOf(snap))) {
      log(`  ${p.platform}: signed out, asking the person to sign in`);
      await human(broker, 'login', `Sign in to ${p.platform} in the agent browser, then press Done. autoinfluencer will post right after.`);
      await broker.tool('browser_navigate', { url });
      await sleep(3500);
      snap = await broker.tool('browser_snapshot', { max_lines: 2500 });
      uid = findButton(outlineOf(snap), SUBMIT[p.platform] ?? /^(post|publish|submit|share)$/i);
    }
    if (!uid) {
      if (env.AUTOINFLUENCER_DESKTOP_DRIVER === 'claude') return driveWithClaude(p, url);
      return { ok: false, error: `could not find the ${p.platform} post button on the page (the composer is open in the agent browser; set AUTOINFLUENCER_DESKTOP_DRIVER=claude to let an agent finish)` };
    }
    await broker.tool('browser_click', { uid });
    await sleep(4000);
    const after = await broker.tool('browser_pages').catch(() => null);
    const current = Array.isArray(after?.data) ? after.data.find((x) => x.selected || x.active) ?? after.data[after.data.length - 1] : after?.data?.pages?.at?.(-1);
    return { ok: true, result: { url: current?.url && current.url !== url ? current.url : null, platform: p.platform } };
  } finally {
    await broker.tool('task_end', {}).catch(() => {});
  }
}

async function capture(p, { broker, log }) {
  const frames = [];
  await broker.tool('task_begin', { description: `autoinfluencer: record ${p.url} for ads` });
  try {
    await broker.tool('browser_new_page', { url: p.url });
    await sleep(3000);
    let snap = await broker.tool('browser_snapshot', { max_lines: 1500 });
    if (loginWall(outlineOf(snap)) && (p.steps ?? []).length === 0) {
      await human(broker, 'login', `Sign in to ${new URL(p.url).host} in the agent browser (a demo account), then press Done.`);
    }
    const shot = async () => {
      const s = await broker.tool('browser_screenshot', { full_page: false });
      frames.push(...s.images);
    };
    await shot();
    for (const step of p.steps ?? []) {
      snap = await broker.tool('browser_snapshot', { max_lines: 2500 });
      const re = new RegExp(step.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const uid = findButton(outlineOf(snap), re);
      if (!uid) {
        log(`  capture: no element "${step}"`);
        continue;
      }
      await broker.tool('browser_click', { uid });
      await sleep(2500);
      await shot();
    }
    await broker.tool('browser_scroll', { dy: 900 }).catch(() => {});
    await sleep(800);
    await shot();
    return { ok: frames.length > 0, frames, result: { url: pageUrl(snap) ?? p.url, frames: frames.length }, error: frames.length ? undefined : 'no screenshots came back' };
  } finally {
    await broker.tool('task_end', {}).catch(() => {});
  }
}

/** Optional: let Claude Code finish a post through the same broker (w3bs-desktop MCP). */
function driveWithClaude(p, url) {
  const prompt = `The ${p.platform} composer is open in the agent browser at ${url} with this text already filled in. Using only the w3bs-desktop browser_* tools: take a browser_snapshot, make sure the text is there, click the button that publishes it once, and report the post's URL. If you hit a sign-in or CAPTCHA, call human_step. Never post anything else.\n\nText:\n${p.text}`;
  return new Promise((resolve) => {
    const child = spawn('claude', ['-p', prompt, '--allowedTools', 'mcp__w3bs-desktop__*'], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.on('error', (e) => resolve({ ok: false, error: `claude driver: ${e.message}` }));
    child.on('close', (code) => resolve(code === 0 ? { ok: true, result: { url: out.match(/https?:\/\/\S+/)?.[0] ?? null, by: 'claude' } } : { ok: false, error: `claude driver exited ${code}` }));
  });
}

/**
 * Keep this computer connected as a desktop environment until `signal` aborts.
 * `onEvent({ type, ... })` reports connected / job / result / error.
 */
export async function connect({ url = process.env.AUTOINFLUENCER_URL || DEFAULT_URL, token = process.env.AUTOINFLUENCER_DESKTOP_TOKEN, brokerUrl = process.env.W3BS_DESKTOP_MCP || BROKER_URL, env = process.env, fetch: f = globalThis.fetch, onEvent = () => {}, signal } = {}) {
  if (!token?.startsWith('dk_')) throw new Error('a desktop token (dk_…) is needed: make one with desktop_add in the app, CLI or your assistant');
  url = url.replace(/\/$/, '');
  const bt = await brokerToken(env);
  const broker = bt ? new Broker({ url: brokerUrl, token: bt, fetch: f }) : null;
  let info = await describe(broker);
  let backoff = 2000;
  let first = true;
  let lastInfo = Date.now();
  while (!signal?.aborted) {
    try {
      if (Date.now() - lastInfo > 5 * 60_000) {
        info = await describe(broker);
        lastInfo = Date.now();
      }
      const r = await f(`${url}/api/v1/desktop/poll`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ info, wait_ms: 9000 }), signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]) });
      if (r.status === 401) throw Object.assign(new Error('this desktop token was revoked or never existed'), { fatal: true });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `poll failed (${r.status})`);
      if (first) {
        onEvent({ type: 'connected', desktop: j.desktop, info });
        first = false;
      }
      backoff = 2000;
      if (!j.job) continue;
      onEvent({ type: 'job', job: j.job });
      let out;
      if (!broker) out = { ok: false, error: `the W3BS desktop layer is not set up on this computer: ${SETUP.join(' && ')}` };
      else {
        try {
          out = await runJob(j.job, { broker, env, log: (m) => onEvent({ type: 'log', message: m }) });
        } catch (e) {
          out = { ok: false, error: e.message };
          broker.session = null; // a fresh MCP session next time
        }
      }
      await f(`${url}/api/v1/desktop/result`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ id: j.job.id, ...out }) });
      onEvent({ type: 'result', job: j.job, ok: out.ok, error: out.error, result: out.result });
    } catch (e) {
      if (e.fatal) throw e;
      if (signal?.aborted) break;
      onEvent({ type: 'error', message: e.message, retry_in_ms: backoff });
      await sleep(backoff);
      backoff = Math.min(60_000, backoff * 2);
    }
  }
}

async function describe(broker) {
  const s = broker ? await broker.status() : { broker: false, error: 'no agent token (w3bs desktop agents add autoinfluencer)' };
  return { hostname: hostname(), platform: `${platform()}-${arch()}`, node: process.version, broker: s.broker, browser: !!s.browser, enabled: s.enabled ?? null, note: s.error ?? null };
}
