import { readFile, writeFile, mkdir, rm, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homeDir } from './persona.js';

/**
 * The hosted app (https://influencer.marketing.pit.world) from the CLI: OAuth 2.1 device
 * flow sign-in (the browser side signs in with CoinPay), then every tool over HTTPS with a
 * bearer, polling job_status for generations that outlast the edge's request window.
 */
export const DEFAULT_URL = 'https://influencer.marketing.pit.world';
export const CLI_CLIENT_ID = 'autoinfluencer-cli';

const authPath = (env = process.env) => join(homeDir(env), 'auth.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function readAuth(env = process.env) {
  const p = authPath(env);
  return existsSync(p) ? JSON.parse(await readFile(p, 'utf8')) : null;
}

async function saveAuth(auth, env = process.env) {
  await mkdir(homeDir(env), { recursive: true });
  const p = authPath(env);
  await writeFile(p, JSON.stringify(auth, null, 2) + '\n', { mode: 0o600 });
  await chmod(p, 0o600).catch(() => {});
}

export async function logout(env = process.env) {
  const auth = await readAuth(env);
  if (auth?.refresh_token) {
    await fetch(`${auth.url}/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: auth.refresh_token, client_id: CLI_CLIENT_ID }),
    }).catch(() => {});
  }
  await rm(authPath(env), { force: true });
  return { signedOut: true };
}

/** Device flow. `onCode({ user_code, verification_uri })` shows the code to the person. */
export async function login({ url = process.env.AUTOINFLUENCER_URL || DEFAULT_URL, onCode, env = process.env, fetch: f = globalThis.fetch } = {}) {
  url = url.replace(/\/$/, '');
  const r = await f(`${url}/oauth/device_authorization`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLI_CLIENT_ID, scope: 'influencer' }),
  });
  const dev = await r.json();
  if (!r.ok) throw new Error(dev.error_description || dev.error || `device authorization failed (${r.status})`);
  onCode?.(dev);
  let interval = (dev.interval ?? 5) * 1000;
  const deadline = Date.now() + (dev.expires_in ?? 900) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const t = await f(`${url}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: dev.device_code, client_id: CLI_CLIENT_ID }),
    });
    const tok = await t.json();
    if (t.ok && tok.access_token) {
      const auth = { url, access_token: tok.access_token, refresh_token: tok.refresh_token, expires_at: Date.now() + (tok.expires_in ?? 3600) * 1000 };
      await saveAuth(auth, env);
      return auth;
    }
    if (tok.error === 'slow_down') interval += 5000;
    else if (tok.error !== 'authorization_pending') throw new Error(tok.error_description || tok.error || 'sign-in failed');
  }
  throw new Error('the code expired; run login again');
}

async function bearer(env, f) {
  const auth = await readAuth(env);
  if (!auth) return null;
  if (auth.expires_at - 60_000 > Date.now()) return auth;
  if (!auth.refresh_token) return null;
  const t = await f(`${auth.url}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: auth.refresh_token, client_id: CLI_CLIENT_ID }),
  });
  const tok = await t.json();
  if (!t.ok || !tok.access_token) throw new Error('your sign-in expired; run "autoinfluencer login"');
  const next = { ...auth, access_token: tok.access_token, refresh_token: tok.refresh_token ?? auth.refresh_token, expires_at: Date.now() + (tok.expires_in ?? 3600) * 1000 };
  await saveAuth(next, env);
  return next;
}

/** Run a tool on the hosted app. Waits for jobs; 402 explains how to pay. */
export async function callRemote(tool, args = {}, { env = process.env, fetch: f = globalThis.fetch, onWait } = {}) {
  const auth = await bearer(env, f);
  const url = auth?.url ?? (env.AUTOINFLUENCER_URL || DEFAULT_URL).replace(/\/$/, '');
  const headers = { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth.access_token}` } : {}) };
  const post = async (name, body) => {
    const r = await f(`${url}/api/${name}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 402) throw new Error(`${j.error ?? 'payment required'} (plans and credits: ${url}/pricing)`);
    if (r.status === 401) throw new Error('not signed in: run "autoinfluencer login"');
    if (!r.ok) throw new Error(j.error ?? `${name} failed (${r.status})`);
    return j;
  };
  let res = await post(tool, args);
  while (res?.job?.status === 'running') {
    onWait?.(res.job.id);
    await sleep(3000);
    res = await post('job_status', { id: res.job.id });
    if (res.job.status === 'failed') throw new Error(res.job.error ?? 'generation failed');
    if (res.job.status === 'done') return res.job.result;
  }
  return res;
}
