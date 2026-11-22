import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createTools, normalizePersona, examplePersona } from '@profullstack/autoinfluencer';
import { createHandler } from '@profullstack/autoinfluencer/server';
import { openDb } from './db.js';
import { createOAuth, OAuthError } from './oauth.js';
import { consentPage, devicePage, errorPage, pageHeaders, newNonce } from './oauth-pages.js';
import { createCoinpay, PACKS } from './coinpay.js';
import { createX402, PRICE_CENTS } from './x402.js';
import { allFooters, startFooterRefresh } from './footers.js';
import { HttpError, NO_STORE, send, readBody, jsonBody, formBody, clientIp, cookie, sameOrigin, newId } from './util.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const GENERATIVE = new Set(['ideas', 'draft', 'repurpose', 'reply', 'calendar']);
const JOB_WAIT_MS = 9000; // the c0mpute edge cuts upstream requests at 15 s
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };

/** Is this call one the server pays a model for? */
export function isPaid(tool, args = {}) {
  if (!GENERATIVE.has(tool)) return false;
  if (args.mode === 'brief') return false;
  if (tool === 'calendar' && !args.withIdeas) return false;
  return true;
}

export async function createApp({ env = process.env, db = openDb(env.DB_PATH || '/data/autoinfluencer.db'), ai, fetch: f = globalThis.fetch } = {}) {
  const publicUrl = (env.PUBLIC_URL || 'https://influencer.marketing.pit.world').replace(/\/$/, '');
  const oauth = createOAuth({ db, publicUrl, log: () => {} });
  const coinpay = createCoinpay({ env, db, publicUrl, fetch: f });
  const x402 = createX402({ env, publicUrl, fetch: f });
  db.failOrphans?.();

  // c0mpute only: no paid frontier fallback in the hosted app.
  if (!ai) {
    const { createAiProviders } = await import('@profullstack/ai-providers');
    const aiEnv = Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('C0MPUTE_') || k === 'INFERNET_API_KEY'));
    ai = createAiProviders({ env: aiEnv });
  }

  // ------------------------------------------------------------- identity
  function accountFor(req) {
    const auth = String(req.headers.authorization ?? '');
    if (auth.startsWith('Bearer ')) {
      const id = oauth.accountForAccessToken(auth.slice(7).trim());
      return id ? db.accountById(typeof id === 'object' ? id.id ?? id.account_id : id) : undefined; // undefined = bad bearer
    }
    return oauth.sessionFor(req.headers.cookie)?.account ?? null;
  }

  // ----------------------------------------------------------------- tools
  const resolvePersona = async (input, ctx) => {
    if (input && Object.keys(input).length) return normalizePersona(input);
    const saved = ctx?.account ? db.persona(ctx.account.id) : null;
    if (saved) return normalizePersona(saved);
    throw new HttpError(400, ctx?.account ? 'save a persona first (persona_save, or the web app)' : 'pass a persona object, or sign in and save one');
  };
  const base = createTools({ local: false, ai, resolvePersona, blockPrivate: true, env });

  function refund(ctx) {
    const c = ctx.charge;
    if (!c || c.refunded) return;
    c.refunded = true;
    if (c.kind === 'free' || c.kind === 'credit') db.refund(ctx.account.id, c.kind, c.ref);
    else if (c.kind === 'x402' && ctx.account) db.addCredits(ctx.account.id, 1, `x402-refund:${c.ref}`, 'refund of a paid call');
  }

  const tools = base.map((tool) => {
    if (!GENERATIVE.has(tool.name)) return tool;
    return {
      ...tool,
      handler: async (args, ctx = {}) => {
        if (!isPaid(tool.name, args)) return tool.handler(args, ctx);
        const id = `job_${newId(12)}`;
        db.createJob(id, ctx.account?.id, tool.name, ctx.charge?.kind);
        const work = tool
          .handler(args, ctx)
          .then((result) => {
            if (result?.mode === 'brief' || (result?.ideas && result.ideas.mode === 'brief')) refund(ctx);
            db.finishJob(id, { result });
          })
          .catch((err) => {
            refund(ctx);
            db.finishJob(id, { error: String(err?.message ?? err) });
          });
        const done = await Promise.race([work.then(() => true), new Promise((r) => setTimeout(() => r(false), Number(env.JOB_WAIT_MS ?? JOB_WAIT_MS)).unref?.())]);
        const job = db.job(id);
        if (done && job.status === 'done') return job.result;
        if (done && job.status === 'failed') throw new HttpError(502, job.error);
        return { job: { id, status: 'running' }, note: 'Still writing on c0mpute. Call job_status with this id every few seconds.' };
      },
    };
  });

  tools.push(
    {
      name: 'job_status',
      title: 'Job status',
      description: 'The status and result of a generation that was still running (draft, repurpose, reply, ideas, calendar return a job id when they take longer than a few seconds).',
      input: { id: z.string() },
      annotations: { readOnlyHint: true },
      handler: async ({ id }, ctx = {}) => {
        const job = db.job(id);
        if (!job || (job.account_id && job.account_id !== ctx.account?.id)) throw new HttpError(404, 'no such job');
        const { account_id: _a, ...rest } = job;
        return { job: rest };
      },
    },
    {
      name: 'persona_get',
      title: 'Saved persona',
      description: 'Read the persona saved on your account.',
      input: {},
      annotations: { readOnlyHint: true },
      handler: async (_a, ctx = {}) => {
        if (!ctx.account) throw new HttpError(401, 'sign in to keep a persona');
        return { persona: db.persona(ctx.account.id) };
      },
    },
    {
      name: 'persona_save',
      title: 'Save persona',
      description: 'Validate and save the persona on your account; later calls can omit it.',
      input: { persona: z.record(z.string(), z.any()) },
      handler: async ({ persona }, ctx = {}) => {
        if (!ctx.account) throw new HttpError(401, 'sign in to keep a persona');
        const p = normalizePersona(persona);
        db.savePersona(ctx.account.id, p);
        return { persona: p };
      },
    },
    {
      name: 'balance',
      title: 'Balance',
      description: 'Free generations left today and credits on your account.',
      input: {},
      annotations: { readOnlyHint: true },
      handler: async (_a, ctx = {}) => {
        if (!ctx.account) return { signed_in: false, x402_price_usd: PRICE_CENTS / 100 };
        return { ...db.balance(ctx.account.id), x402_price_usd: PRICE_CENTS / 100, buy: `${publicUrl}/#credits` };
      },
    },
  );

  const toolHandler = createHandler({
    tools,
    baseUrl: publicUrl,
    info: { description: 'Persona-driven social posts for every network. Sign in with CoinPay (OAuth 2.1); generation costs a free daily run, a credit, or an x402 payment per call.' },
    authenticate: async (req) => {
      const account = accountFor(req);
      if (account === undefined) return null; // a bearer that is not ours
      const path = new URL(req.url, 'http://x').pathname;
      if (!account && path === '/mcp') return null; // connectors need the OAuth challenge
      return account ? { account } : { anonymous: true };
    },
    unauthorized: (req, res) => send(res, 401, { error: 'unauthorized', error_description: 'sign in with CoinPay via OAuth' }, { 'www-authenticate': oauth.challenge('mcp', req.headers.authorization ? 'invalid_token' : undefined), 'access-control-allow-origin': '*', 'access-control-expose-headers': 'www-authenticate' }),
    gate: async (req, res, { tool, ctx, args }) => {
      if (!isPaid(tool.name, args ?? {})) return true;
      const ref = newId(12);
      if (ctx.account) {
        const kind = db.spend(ctx.account.id, ref);
        if (kind) {
          ctx.charge = { kind, ref };
          return true;
        }
      }
      const paid = await x402.settle(req, res, tool.name);
      if (paid.ok) {
        ctx.charge = { kind: 'x402', ref: paid.tx ?? ref };
        return true;
      }
      return x402.deny(
        res,
        tool.name,
        paid.reason !== 'no payment' ? paid.reason : ctx.account ? 'no free generations or credits left: buy a pack, use mode "brief" (free), or pay per call with x402' : 'sign in with CoinPay, use mode "brief" (free), or pay per call with x402',
      );
    },
  });

  // ----------------------------------------------------------------- pages
  async function staticFile(res, path) {
    const rel = path === '/' ? '/index.html' : path;
    const file = normalize(join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC) || !existsSync(file)) return false;
    let body = await readFile(file);
    const type = TYPES[extname(file)] ?? 'application/octet-stream';
    if (rel === '/index.html') body = body.toString('utf8').replace('<!--FOOTERS-->', allFooters());
    send(res, 200, body, { 'content-type': type, 'cache-control': rel === '/index.html' || rel === '/sw.js' ? 'no-cache' : 'public, max-age=3600' });
    return true;
  }

  const sendOAuthError = (res, e) => send(res, e.status || 400, { error: e.code, error_description: e.message }, NO_STORE);
  const sessionOrThrow = (req, csrf) => {
    const s = oauth.sessionFor(req.headers.cookie);
    if (!s) throw new HttpError(401, 'your sign-in expired; reload the page and sign in again');
    if (csrf !== undefined && csrf !== s.csrf) throw new HttpError(403, 'stale page; reload and try again');
    return s;
  };

  async function oauthRoute(req, res, path, method, url) {
    const wrap = async (fn, status = 200) => {
      try {
        return send(res, status, await fn(), NO_STORE);
      } catch (e) {
        if (e instanceof OAuthError) return sendOAuthError(res, e);
        throw e;
      }
    };
    if (path === '/oauth/register' || path === '/register') {
      if (method !== 'POST') return send(res, 405, { error: 'POST client metadata (RFC 7591)' });
      return wrap(async () => oauth.register(await jsonBody(req).catch(() => ({})), clientIp(req)), 201);
    }
    if (path === '/oauth/token' && method === 'POST') return wrap(async () => oauth.tokenEndpoint(await formBody(req), req.headers.authorization, clientIp(req)));
    if (path === '/oauth/device_authorization' && method === 'POST') return wrap(async () => oauth.deviceAuthorization(await formBody(req), req.headers.authorization, clientIp(req)));
    if (path === '/oauth/revoke' && method === 'POST') return wrap(async () => oauth.revoke(await formBody(req), req.headers.authorization));
    if (path === '/oauth/authorize' && method === 'GET') {
      const nonce = newNonce();
      let ar;
      try {
        ar = oauth.checkAuthorize(Object.fromEntries(url.searchParams));
      } catch (e) {
        if (e.redirect) return send(res, 302, '', { location: e.redirect, ...NO_STORE });
        return send(res, 400, errorPage(e.message, nonce), pageHeaders(nonce));
      }
      return send(res, 200, consentPage({ client: ar.client, redirectUri: ar.redirectUri, session: oauth.sessionFor(req.headers.cookie), query: url.search, nonce }), pageHeaders(nonce));
    }
    if (path === '/oauth/authorize' && method === 'POST') {
      sameOrigin(req, publicUrl);
      const b = await jsonBody(req);
      const s = sessionOrThrow(req, b.csrf);
      let ar;
      try {
        ar = oauth.checkAuthorize(Object.fromEntries(new URLSearchParams(String(b.query ?? ''))));
      } catch (e) {
        if (e.redirect) return send(res, 200, { redirect: e.redirect }, NO_STORE);
        throw new HttpError(400, e.message);
      }
      return send(res, 200, { redirect: b.action === 'approve' ? oauth.approve(ar, s.account.id) : oauth.deny(ar) }, NO_STORE);
    }
    if (path === '/oauth/device' && method === 'GET') {
      const nonce = newNonce();
      return send(res, 200, devicePage({ session: oauth.sessionFor(req.headers.cookie), nonce }), pageHeaders(nonce));
    }
    if (path === '/oauth/device' && method === 'POST') {
      sameOrigin(req, publicUrl);
      const b = await jsonBody(req);
      const s = sessionOrThrow(req, b.csrf);
      if (b.action === 'lookup') return send(res, 200, { client: oauth.deviceLookup(b.user_code).client.name }, NO_STORE);
      if (b.action !== 'approve' && b.action !== 'deny') throw new HttpError(400, 'action must be lookup, approve or deny');
      return send(res, 200, oauth.deviceDecide(b.user_code, s.account.id, b.action === 'approve'), NO_STORE);
    }
    if (path === '/oauth/logout' && method === 'POST') {
      sameOrigin(req, publicUrl);
      return send(res, 200, { ok: true }, { 'set-cookie': oauth.signOut(req.headers.cookie), ...NO_STORE });
    }
    return send(res, 404, { error: 'no such OAuth endpoint; see /.well-known/oauth-authorization-server' });
  }

  async function appRoute(req, res, path, method, url) {
    if (path === '/api/v1/coinpay/oauth/start' && method === 'GET') {
      const { location, cookie: c } = coinpay.start(url.searchParams.get('return_to') || '/');
      return send(res, 302, '', { location, 'set-cookie': c, ...NO_STORE });
    }
    if (path === '/api/v1/coinpay/oauth/callback' && method === 'GET') {
      try {
        const r = await coinpay.callback(Object.fromEntries(url.searchParams), cookie(req, 'ai_cp_state'));
        return send(res, 302, '', { location: r.returnTo, 'set-cookie': [r.clearCookie, oauth.signInAccount(r.account.id)], ...NO_STORE });
      } catch (e) {
        const nonce = newNonce();
        return send(res, e.status || 400, errorPage(e.message, nonce), pageHeaders(nonce));
      }
    }
    if (path === '/api/v1/coinpay/webhook' && method === 'POST') {
      const raw = await readBody(req, 256 * 1024);
      return send(res, 200, coinpay.webhook(raw, req.headers['x-coinpay-signature']));
    }
    const account = accountFor(req);
    if (path === '/api/v1/me' && method === 'GET') {
      if (!account) return send(res, 401, { error: 'not signed in', sign_in: '/api/v1/coinpay/oauth/start' }, NO_STORE);
      return send(res, 200, { user: { id: account.id, name: account.name, email: account.email }, ...db.balance(account.id), persona: db.persona(account.id), x402_price_usd: PRICE_CENTS / 100 }, NO_STORE);
    }
    if (path === '/api/v1/persona') {
      if (!account) throw new HttpError(401, 'not signed in');
      if (method === 'GET') return send(res, 200, { persona: db.persona(account.id) ?? examplePersona() }, NO_STORE);
      if (method === 'PUT' || method === 'POST') {
        sameOrigin(req, publicUrl);
        const p = normalizePersona(await jsonBody(req));
        db.savePersona(account.id, p);
        return send(res, 200, { persona: p }, NO_STORE);
      }
    }
    if (path === '/api/v1/credits/checkout' && method === 'POST') {
      if (!account) throw new HttpError(401, 'not signed in');
      sameOrigin(req, publicUrl);
      return send(res, 200, await coinpay.checkout(account, (await jsonBody(req)).pack), NO_STORE);
    }
    if (path === '/api/v1/packs') return send(res, 200, { packs: PACKS, x402_price_usd: PRICE_CENTS / 100 });
    if (path === '/api/v1/logout' && method === 'POST') {
      sameOrigin(req, publicUrl);
      return send(res, 200, { ok: true }, { 'set-cookie': oauth.signOut(req.headers.cookie), ...NO_STORE });
    }
    return send(res, 404, { error: 'not found' });
  }

  startFooterRefresh();

  return async function handler(req, res) {
    const url = new URL(req.url, publicUrl);
    const path = url.pathname;
    const method = req.method;
    try {
      if (path === '/healthz' || path === '/health') return send(res, 200, { ok: true });
      const meta = { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=3600' };
      if (method === 'GET' && (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp')) return send(res, 200, oauth.resourceMetadata('mcp'), meta);
      if (method === 'GET' && path === '/.well-known/oauth-protected-resource/api/v1') return send(res, 200, oauth.resourceMetadata('api'), meta);
      if (method === 'GET' && ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp', '/.well-known/openid-configuration'].includes(path)) return send(res, 200, oauth.serverMetadata(), meta);
      if (path === '/robots.txt') return send(res, 200, 'User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /oauth/\n');
      if (path.startsWith('/oauth/') || path === '/register') return await oauthRoute(req, res, path, method, url);
      if (path.startsWith('/api/v1/')) return await appRoute(req, res, path, method, url);
      if (path === '/mcp' || path === '/openapi.json' || /^\/api\/[a-z_]+$/.test(path)) return await toolHandler(req, res);
      if (method === 'GET' && (await staticFile(res, path))) return;
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(e);
      return send(res, status, { error: e.message });
    }
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const handler = await createApp();
  const port = Number(process.env.PORT || 8080);
  createServer(handler).listen(port, process.env.HOST || '0.0.0.0', () => console.log(`autoinfluencer app on :${port}`));
}
