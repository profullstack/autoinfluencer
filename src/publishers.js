import { createHmac, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homeDir } from './persona.js';

/**
 * Publishers send one post somewhere. Every one takes the same item
 * ({platform, text, title?, subreddit?}) and returns a small result object.
 *
 *   stdout   – print it (the default: nothing leaves the machine until you choose)
 *   webhook  – POST JSON to your URL, signed per Standard Webhooks when a secret is set
 *   autopost – Crawlproof social accounts (https://crawlproof.com/social), AUTOPOST_TOKEN
 *   myna     – the myna CLI (https://mynaposter.com), paced by myna itself
 */

export async function loadConfig(env = process.env) {
  const path = env.AUTOINFLUENCER_CONFIG || join(homeDir(env), 'config.json');
  const file = existsSync(path) ? JSON.parse(await readFile(path, 'utf8')) : {};
  return {
    publisher: env.AUTOINFLUENCER_PUBLISHER || file.publisher || 'stdout',
    webhook: {
      url: env.AUTOINFLUENCER_WEBHOOK_URL || file.webhook?.url,
      secret: env.AUTOINFLUENCER_WEBHOOK_SECRET || file.webhook?.secret,
    },
    autopost: {
      token: env.AUTOPOST_TOKEN || file.autopost?.token,
      baseUrl: env.AUTOPOST_URL || file.autopost?.baseUrl || 'https://crawlproof.com',
      accounts: file.autopost?.accounts ?? {},
    },
    myna: { bin: env.MYNA_BIN || file.myna?.bin || 'myna', accounts: file.myna?.accounts ?? {} },
  };
}

/** Standard Webhooks signature headers (https://www.standardwebhooks.com). */
export function signWebhook(secret, body, { id = `msg_${randomUUID()}`, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const key = String(secret).startsWith('whsec_')
    ? Buffer.from(String(secret).slice(6), 'base64')
    : Buffer.from(String(secret));
  const sig = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return { 'webhook-id': id, 'webhook-timestamp': String(timestamp), 'webhook-signature': `v1,${sig}` };
}

export function createPublisher(config, { fetch: f = globalThis.fetch, log = (s) => process.stdout.write(s) } = {}) {
  const name = config.publisher;
  if (name === 'stdout') {
    return async (item) => {
      log(`--- ${item.platform}${item.title ? ` | ${item.title}` : ''}\n${item.text}\n`);
      return { publisher: 'stdout' };
    };
  }
  if (name === 'webhook') {
    if (!config.webhook.url) throw new Error('webhook publisher needs AUTOINFLUENCER_WEBHOOK_URL or config.webhook.url');
    return async (item) => {
      const body = JSON.stringify({ type: 'autoinfluencer.post', data: item });
      const headers = { 'content-type': 'application/json' };
      if (config.webhook.secret) Object.assign(headers, signWebhook(config.webhook.secret, body));
      const res = await f(config.webhook.url, { method: 'POST', headers, body });
      if (!res.ok) throw new Error(`webhook ${res.status}`);
      return { publisher: 'webhook', status: res.status };
    };
  }
  if (name === 'autopost') {
    const { token, baseUrl } = config.autopost;
    if (!token) throw new Error('autopost publisher needs AUTOPOST_TOKEN (crawlproof.com/social/api-tokens)');
    const api = async (path, init = {}) => {
      const res = await f(`${baseUrl.replace(/\/$/, '')}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`autopost ${res.status}: ${json.error ?? res.statusText}`);
      return json;
    };
    let accounts;
    return async (item) => {
      let accountId = config.autopost.accounts[item.platform];
      if (!accountId) {
        accounts ??= (await api('/api/sp/v1/accounts')).accounts ?? [];
        accountId = accounts.find((a) => a.platform === item.platform && a.status !== 'revoked')?.id;
      }
      if (!accountId) throw new Error(`no connected ${item.platform} account on Crawlproof`);
      const r = await api('/api/sp/v1/posts', {
        method: 'POST',
        body: JSON.stringify({ account_id: accountId, text: item.text, subreddit: item.subreddit, title: item.title }),
      });
      return { publisher: 'autopost', url: r.web_url, id: r.post_id };
    };
  }
  if (name === 'myna') {
    return (item) =>
      new Promise((resolve, reject) => {
        const target = config.myna.accounts[item.platform] ?? item.platform;
        const args = ['post', target];
        if (item.title) args.push('--title', item.title);
        if (item.subreddit) args.push('--subreddit', item.subreddit);
        const child = spawn(config.myna.bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (err += d));
        child.on('error', reject);
        child.on('close', (code) =>
          code === 0 ? resolve({ publisher: 'myna', output: out.trim() }) : reject(new Error(`myna exited ${code}: ${err.trim() || out.trim()}`)),
        );
        child.stdin.end(item.text);
      });
  }
  throw new Error(`unknown publisher "${name}" (stdout, webhook, autopost, myna)`);
}
