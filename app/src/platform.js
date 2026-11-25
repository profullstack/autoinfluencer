// The platform: every feature is a tool, so each one is at once an MCP tool, a REST call
// (POST /api/<name>), an OpenAPI operation, a CLI command (`autoinfluencer call <name>`), a
// TUI screen and a PWA panel.
//
// Where the work runs:
//   - writing (blog posts, translations, ad copy, newsletters) on the c0mpute network through
//     @profullstack/ai-providers, and reels through c0mpute's promo video pipeline;
//   - anything that needs a real browser (posting to a network, recording a web app) on the
//     account's desktop environment through the W3BS Agentic Desktop Layer (w3bs.org/desktop),
//     over a two-way channel the desktop opens to us (see desktop jobs below).
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { COSTS, PLANS, PAID_PLANS, TOPUPS, creditsIn, planFor, pricing } from './plans.js';
import { AD_FORMATS, adSvg, brandOf, extractBrand, slugify, templateCopy } from './render.js';
import { HttpError, newId } from './util.js';

export const DESKTOP_TOKEN_PREFIX = 'dk_';
const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const RESERVED = new Set(['www', 'api', 'app', 'admin', 'mcp', 'oauth', 'static', 'assets', 'cdn', 'mail', 'blog', 'help', 'support', 'status', 'pricing']);
const NETWORKS = ['x', 'bluesky', 'mastodon', 'threads', 'linkedin', 'reddit', 'hackernews', 'facebook', 'instagram', 'tiktok', 'youtube', 'telegram'];
const TYPES = { html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', txt: 'text/plain; charset=utf-8', xml: 'application/xml', webmanifest: 'application/manifest+json', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wasm: 'application/wasm', map: 'application/json' };
export const typeFor = (path) => TYPES[String(path).split('.').pop().toLowerCase()] ?? 'application/octet-stream';
const isHtml = (path) => /\.html?$/i.test(path);

/** A clean site path: relative, no dot segments or hidden files, at most 8 levels. */
export function cleanPath(p) {
  const s = String(p ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = s.split('/');
  if (!s || parts.length > 8 || s.length > 300 || parts.some((x) => !x || x === '.' || x === '..' || x.startsWith('.'))) throw new HttpError(400, `bad file path "${String(p).slice(0, 80)}"`);
  return s;
}

export function createPlatform({ db, ai, publicUrl, env = process.env, fetch: f = globalThis.fetch }) {
  const c0mputeUrl = (env.C0MPUTE_URL || 'https://c0mpute.com').replace(/\/$/, '');

  // ------------------------------------------------------------- helpers
  const need = (ctx) => {
    if (!ctx?.account) throw new HttpError(401, 'sign in with CoinPay first (autoinfluencer login, or the web app)');
    return ctx.account;
  };
  /** The workspace an account works in: its own, or the owner's when it holds a team seat. */
  const owner = (ctx) => {
    const a = need(ctx);
    const id = db.ownerOf(a.id);
    return id === a.id ? a : db.accountById(id) ?? a;
  };
  const plan = (ctx) => db.planOf(owner(ctx).id);
  const site = (ctx, ref) => {
    const o = owner(ctx);
    const s = db.sites(o.id).find((x) => x.slug === ref || x.id === ref) ?? (ref ? null : db.sites(o.id)[0]);
    if (!s) throw new HttpError(404, ref ? `no site "${ref}" in your workspace (site_list)` : 'create a site first (site_create)');
    return s;
  };
  const siteUrl = (s) => (s.domain ? `https://${s.domain}/` : `${publicUrl}/site/${s.slug}/`);
  const confirmed = (args, what) => {
    if (args.confirm !== true) throw new HttpError(409, `${what}: ask the person, then call again with confirm: true`);
  };
  const generate = async ({ system, user, validate, feature }) => {
    if (!ai) throw new HttpError(503, 'c0mpute is not configured on this server');
    const res = await ai.generateObject({ system, user, schema: validate, feature: `autoinfluencer.${feature}`, temperature: 0.7, maxTokens: 3000, timeoutMs: Number(env.AUTOINFLUENCER_TIMEOUT_MS ?? 120000) });
    return res.object;
  };
  const persona = (ctx) => db.persona(owner(ctx).id);
  const notify = async (s, event, data) => {
    const hook = s.settings?.notify_webhook;
    if (!hook || !/^https:\/\//.test(hook)) return;
    f(hook, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'autoinfluencer-webhook' }, body: JSON.stringify({ event, site: s.slug, at: new Date().toISOString(), data }), signal: AbortSignal.timeout(8000) }).catch(() => {});
  };

  // ------------------------------------------------------------- brand kit
  async function readBrand(url) {
    let u;
    try {
      u = new URL(/^https?:\/\//.test(url) ? url : `https://${url}`);
    } catch {
      throw new HttpError(400, 'not a URL');
    }
    if (!/^https?:$/.test(u.protocol) || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[)/.test(u.hostname) || /\.(local|internal)$/.test(u.hostname)) throw new HttpError(400, 'public http(s) URLs only');
    const get = async (href, max) => {
      const r = await f(href, { headers: { 'user-agent': 'autoinfluencer-brandkit/1 (+https://influencer.marketing.pit.world)', accept: 'text/html,text/css,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new HttpError(502, `${href} answered ${r.status}`);
      return (await r.text()).slice(0, max);
    };
    const html = await get(u.href, 600_000);
    const first = extractBrand(html, u.href);
    let css = '';
    for (const sheet of first.stylesheets) css += await get(new URL(sheet, u.href).href, 300_000).catch(() => '');
    const { stylesheets: _s, ...brand } = extractBrand(html, u.href, css);
    brand.logoData = brand.logo ? await logoData(brand.logo) : null;
    return brand;
  }
  async function logoData(href) {
    try {
      const r = await f(href, { signal: AbortSignal.timeout(8000) });
      const type = r.headers.get('content-type') ?? '';
      if (!r.ok || !/^image\//.test(type)) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      return buf.length <= 200_000 ? `data:${type.split(';')[0]};base64,${buf.toString('base64')}` : null;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------- ads
  const adUrls = (id) => Object.fromEntries(Object.keys(AD_FORMATS).map((fmt) => [fmt, `${publicUrl}/ad/${id}/${fmt.replace(':', 'x')}.svg`]));
  const adOut = (a) => ({ id: a.id, copy: a.copy, watermark: a.watermark, images: adUrls(a.id), created_at: a.created_at });
  const validateCopy = (v) => {
    const list = Array.isArray(v?.ads) ? v.ads : Array.isArray(v) ? v : [v];
    const ok = list.filter((x) => x && typeof x.headline === 'string' && x.headline.trim()).map((x) => ({ headline: String(x.headline).slice(0, 90), sub: String(x.sub ?? '').slice(0, 160), cta: String(x.cta ?? 'Learn more').slice(0, 24) }));
    if (!ok.length) throw new Error('no ad copy in the answer');
    return { ads: ok };
  };

  // ------------------------------------------------------------- desktop jobs
  /** Send work to the account's desktop environment. */
  function toDesktop(ctx, type, payload, { desktop, charge, socialId } = {}) {
    const o = owner(ctx);
    const d = db.pickDesktop(o.id, desktop);
    if (!d) throw new HttpError(409, 'add a desktop environment first (desktop_add), then run the connector on it');
    return { desktop: d, job: db.queueJob(d.id, o.id, type, payload, { charge, socialId }) };
  }

  function refund(accountId, charge) {
    if (charge?.kind === 'credit' || charge?.kind === 'free') db.refund(accountId, charge.kind, charge.ref);
    else if (charge?.kind === 'x402' && charge.cost) db.addCredits(accountId, charge.cost, `x402-refund:${charge.ref}`, 'refund of a paid call');
  }

  /** The desktop reported back. */
  function desktopResult(d, { id, ok, result, error, frames }) {
    const job = db.dJob(id);
    if (!job || job.desktop_id !== d.id) throw new HttpError(404, 'no such job for this desktop');
    if (job.status !== 'running') return { ok: true, already: job.status };
    let out = result ?? null;
    if (job.type === 'capture') {
      const urls = [];
      for (const fr of (Array.isArray(frames) ? frames : []).slice(0, 40)) {
        const buf = Buffer.from(String(fr.base64 ?? ''), 'base64');
        if (buf.length < 100 || buf.length > 6_000_000) continue;
        urls.push(`${publicUrl}/f/${db.addAsset(job.account_id, fr.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', buf)}`);
      }
      out = { ...(result ?? {}), frames: urls };
      if (!urls.length) ok = false;
      if (!ok) refund(job.account_id, job.charge);
    }
    const done = db.finishDJob(id, { ok: !!ok, result: out, error: ok ? null : String(error ?? 'the desktop returned nothing usable (refunded)').slice(0, 500) });
    if (job.social_id) db.setSocial(job.social_id, ok ? { status: 'published', result_url: out?.url ?? null, error: null } : { status: 'failed', error: String(error ?? 'failed').slice(0, 500) });
    return { ok: true, job: { id: done.id, status: done.status } };
  }

  // ------------------------------------------------------------- scheduler
  async function tick() {
    for (const p of db.dueSocial()) {
      const d = db.pickDesktop(p.account_id, p.desktop_id);
      if (!d) {
        db.setSocial(p.id, { status: 'needs_desktop', error: 'no desktop environment: add one (desktop_add) and run the connector, then social_publish_now' });
        continue;
      }
      db.queueJob(d.id, p.account_id, 'publish', { platform: p.platform, text: p.text, title: p.title, link: p.link, subreddit: p.subreddit }, { socialId: p.id });
      db.setSocial(p.id, { status: 'queued', desktop_id: d.id });
    }
    for (const j of db.staleDJobs()) {
      db.finishDJob(j.id, { ok: false, error: 'the desktop went quiet for 15 minutes (refunded)' });
      refund(j.account_id, j.charge);
      if (j.social_id) db.setSocial(j.social_id, { status: 'failed', error: 'the desktop went quiet' });
    }
    for (const r of db.pendingReels()) await pollReel(r).catch(() => {});
    db.grantDueCredits();
    db.dropStaleStaging();
  }
  let timer;
  const start = () => {
    timer = setInterval(() => tick().catch((e) => console.error('[tick]', e)), Number(env.TICK_MS ?? 20000));
    timer.unref?.();
  };
  const stop = () => clearInterval(timer);

  // ------------------------------------------------------------- reels (c0mpute promo video)
  async function c0mpute(path, init = {}) {
    const key = env.C0MPUTE_PROMO_KEY || env.C0MPUTE_API_KEY;
    if (!key) throw new HttpError(503, 'c0mpute is not configured on this server');
    const r = await f(`${c0mputeUrl}${path}`, { ...init, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok && r.status !== 202) throw new HttpError(r.status === 429 ? 429 : 502, j.error ?? `c0mpute answered ${r.status}`);
    return j;
  }
  async function pollReel(r) {
    if (!r.promo_id) {
      try {
        const j = await c0mpute('/api/v1/promo', { method: 'POST', body: JSON.stringify(JSON.parse(r.video ?? '{}')) });
        db.setReel(r.id, { promo_id: j.id, status: 'pending', video: null });
      } catch (e) {
        db.setReel(r.id, { status: 'failed', error: `c0mpute: ${e.message} (refunded)` });
        refund(r.account_id, r.charge);
      }
      return;
    }
    const j = await c0mpute(`/api/v1/promo/${encodeURIComponent(r.promo_id)}`);
    if (j.status === 'done') db.setReel(r.id, { status: 'done', video: `${publicUrl}/r/${r.id}.mp4` });
    else if (j.status === 'failed') {
      db.setReel(r.id, { status: 'failed', error: `${j.error ?? 'the promo pipeline failed'} (refunded)` });
      refund(r.account_id, r.charge);
    } else db.setReel(r.id, { status: 'pending' });
  }
  const reelOut = (r) => ({ id: r.id, url: r.url, status: r.status === 'starting' ? 'pending' : r.status, video: r.status === 'done' ? `${publicUrl}/r/${r.id}.mp4` : null, error: r.error ?? undefined, created_at: r.created_at });


  function finishDeploy(s, p, v, files, args) {
    let cur = db.putFiles(v.id, files);
    const pages = db.versionFiles(v.id).filter((x) => isHtml(x.path)).length;
    const over = cur.files > p.limits.filesPerDeploy ? `${cur.files} files (${p.name} allows ${p.limits.filesPerDeploy})` : cur.bytes > p.limits.deployMb * 1_048_576 ? `${(cur.bytes / 1_048_576).toFixed(1)} MB (${p.name} allows ${p.limits.deployMb} MB)` : pages > p.limits.pages ? `${pages} pages (${p.name} allows ${p.limits.pages})` : null;
    if (over) throw new HttpError(402, `this deploy is over the plan: ${over}. Upgrade with plan_checkout.`);
    if (args.finish === false) return { deploy: v.id, files: cur.files, bytes: cur.bytes, status: 'open', next: 'send the next batch with this deploy id; finish with finish: true' };
    if (!db.versionFiles(v.id).some((x) => x.path === 'index.html')) throw new HttpError(400, 'a site needs an index.html at its root');
    cur = db.goLive(s.id, v.id, p.limits.versions);
    return { live: true, version: cur.version, files: cur.files, bytes: cur.bytes, url: siteUrl(s), rollback: `site_rollback with version ${cur.version - 1}` };
  }

  // ------------------------------------------------------------- tools
  const S = z.string().max(80).optional().describe('Site slug or id (default: your first site)');
  const T = (name, title, description, input, handler, extra = {}) => ({ name, title, description, input, handler, ...extra });
  const RO = { annotations: { readOnlyHint: true } };

  const tools = [
    // ---- plan, credits, team
    T('plan_get', 'Plan and credits', 'Your plan, its limits, credits, what they buy, and the price sheet.', {}, async (_a, ctx) => {
      const o = owner(ctx);
      const p = db.planOf(o.id);
      const b = db.balance(o.id);
      return { plan: { id: p.id, name: p.name, interval: p.interval, period_end: p.period_end ? new Date(p.period_end).toISOString() : null, limits: p.limits }, credits: b.credits, free_generations_left_today: b.free_left, credits_buy: creditsIn(b.credits), workspace: o.id === ctx.account.id ? 'own' : `team seat in ${o.name || o.id}`, pricing: pricing(), upgrade: `${publicUrl}/pricing` };
    }, RO),
    T('plan_checkout', 'Upgrade or top up', 'A CoinPay checkout link for a plan (solo or studio, by month or year) or a credit top-up (t1000, t2750, t6000, t13000). Paid in crypto. Agency plans: talk to us.', {
      option: z.enum([...PAID_PLANS.flatMap((p) => [`${p}-month`, `${p}-year`]), ...Object.keys(TOPUPS)]),
    }, async ({ option }, ctx) => {
      need(ctx);
      return { url: `${publicUrl}/checkout?option=${option}`, note: 'Open this link to pay with CoinPay. The plan or credits apply as soon as the payment confirms.' };
    }, RO),
    T('credits_history', 'Credit history', 'Recent credit purchases, grants, spends and refunds.', {}, async (_a, ctx) => ({ ledger: db.ledger(owner(ctx).id).map((l) => ({ ...l, at: new Date(l.created_at).toISOString() })) }), RO),
    T('team_invite', 'Invite a teammate', 'A one-time link (7 days) that gives another CoinPay account a seat in your workspace: same sites, credits and desktops.', {}, async (_a, ctx) => {
      const o = owner(ctx);
      if (o.id !== ctx.account.id) throw new HttpError(403, 'only the workspace owner invites');
      const p = db.planOf(o.id);
      if (db.members(o.id).length + 1 >= p.limits.seats) throw new HttpError(402, `${p.name} has ${p.limits.seats} seat(s); Studio has 3 (plan_checkout)`);
      const token = `inv_${randomBytes(18).toString('base64url')}`;
      db.addInvite(hashToken(token), o.id);
      return { link: `${publicUrl}/join?t=${token}`, expires_in_days: 7 };
    }),
    T('team_list', 'Team', 'Who has a seat in your workspace.', {}, async (_a, ctx) => {
      const o = owner(ctx);
      return { owner: { id: o.id, name: o.name }, members: db.members(o.id), seats: db.planOf(o.id).limits.seats };
    }, RO),
    T('team_remove', 'Remove a teammate', 'Take a seat back (owner), or leave a workspace (yourself).', { account_id: z.string() }, async ({ account_id }, ctx) => {
      const o = owner(ctx);
      if (account_id !== ctx.account.id && o.id !== ctx.account.id) throw new HttpError(403, 'only the owner removes others');
      if (db.ownerOf(account_id) !== o.id) throw new HttpError(404, 'not in this workspace');
      db.leave(account_id);
      return { removed: account_id };
    }),

    // ---- brand kit
    T('brand_read', 'Read a brand kit', 'Read the brand kit (name, colours, font, logo, tagline) from any website. Pass site to save it to one of your sites. Free.', { url: z.string().max(2048), site: S }, async ({ url, site: ref }, ctx) => {
      if (ctx?.account && db.hit(`brand:${ctx.account.id}`) > 60) throw new HttpError(429, 'brand reads are limited to 60 a day');
      const brand = await readBrand(url);
      if (ref) db.updateSite(site(ctx, ref).id, { brand });
      const { logoData: _l, ...shown } = brand;
      return { brand: shown, saved_to: ref ?? null };
    }),
    T('brand_save', 'Save a brand kit', 'Set a site\'s brand kit by hand: name, tagline, colors {bg, fg, accent}, font, logo URL.', {
      site: S,
      brand: z.object({ name: z.string().max(60).optional(), tagline: z.string().max(160).optional(), colors: z.object({ bg: z.string().optional(), fg: z.string().optional(), accent: z.string().optional() }).partial().optional(), font: z.string().max(60).optional(), logo: z.string().max(2048).optional() }),
    }, async ({ site: ref, brand }, ctx) => {
      const s = site(ctx, ref);
      const colors = Object.fromEntries(Object.entries(brand.colors ?? {}).filter(([, v]) => /^#[0-9a-f]{3,8}$/i.test(v ?? '')));
      const next = { ...(s.brand ?? {}), ...brand, colors: { ...(s.brand?.colors ?? {}), ...colors } };
      if (brand.logo && brand.logo !== s.brand?.logo) next.logoData = await logoData(brand.logo);
      const { logoData: _l, ...shown } = db.updateSite(s.id, { brand: next }).brand;
      return { brand: shown };
    }),

    // ---- sites
    T('site_create', 'Create a site', 'A new site (one brand) in your workspace, live at once on a free address. Deploy pages with site_deploy; a starter page, blog and contact form work before that.', {
      name: z.string().min(1).max(80),
      slug: z.string().max(40).optional().describe('Lowercase letters, digits and dashes; becomes the address'),
      brand_from: z.string().max(2048).optional().describe('A website to read the brand kit from'),
    }, async ({ name, slug, brand_from }, ctx) => {
      const o = owner(ctx);
      const p = db.planOf(o.id);
      if (db.sites(o.id).length >= p.limits.sites) throw new HttpError(402, `${p.name} includes ${p.limits.sites} site(s); Studio has 3 brands (plan_checkout)`);
      const want = slugify(slug || name).slice(0, 40).replace(/-+$/, '');
      if (!SLUG.test(want) || RESERVED.has(want)) throw new HttpError(400, `"${want}" cannot be a site address`);
      let final = want;
      for (let i = 2; db.siteBySlug(final); i++) final = `${want.slice(0, 36)}-${i}`;
      let s = db.createSite(o.id, { slug: final, name });
      db.saveForm(s.id, { slug: 'contact', name: 'Contact', fields: [{ name: 'name', label: 'Name', type: 'text', required: true }, { name: 'email', label: 'Email', type: 'email', required: true }, { name: 'message', label: 'Message', type: 'textarea', required: true }] });
      if (brand_from) s = db.updateSite(s.id, { brand: await readBrand(brand_from).catch(() => null) });
      return { site: { slug: s.slug, name: s.name, url: siteUrl(s) }, next: 'site_deploy to upload your pages, blog_write for a first post, social_schedule to plan posts' };
    }),
    T('site_list', 'Sites', 'Your sites with their addresses, live version and plan limits.', {}, async (_a, ctx) => {
      const o = owner(ctx);
      return { sites: db.sites(o.id).map((s) => ({ slug: s.slug, name: s.name, url: siteUrl(s), free_url: `${publicUrl}/site/${s.slug}/`, domain: s.domain, live_version: s.live_version, brand: s.brand ? { name: s.brand.name, colors: s.brand.colors } : null })), limits: db.planOf(o.id).limits };
    }, RO),
    T('site_get', 'Site details', 'One site: its files in the live version, forms, languages and settings.', { site: S }, async ({ site: ref }, ctx) => {
      const s = site(ctx, ref);
      const live = db.versions(s.id).find((v) => v.status === 'live');
      const { logoData: _l, ...brand } = s.brand ?? {};
      return { site: { slug: s.slug, name: s.name, url: siteUrl(s), domain: s.domain, settings: s.settings, brand }, live: live ? { version: live.version, files: db.versionFiles(live.id) } : null, forms: db.forms(s.id).map((x) => x.slug), languages: db.siteLanguages(s.id) };
    }, RO),
    T('site_deploy', 'Deploy a site', 'Upload a built site (your dist/ folder) as a new version and make it live. Big sites go in several calls: pass back the deploy id with finish: false until the last batch. Text as utf8, binary as base64. Every deploy is a version you can roll back to. Ask the person first; send confirm: true.', {
      site: S,
      files: z.array(z.object({ path: z.string(), content: z.string(), encoding: z.enum(['utf8', 'base64']).optional(), type: z.string().max(100).optional() })).max(500),
      deploy: z.string().max(40).optional().describe('The deploy id from an earlier batch'),
      finish: z.boolean().optional().describe('false to keep the deploy open for more batches (default true)'),
      note: z.string().max(200).optional(),
      confirm: z.boolean().optional(),
    }, async (args, ctx) => {
      const s = site(ctx, args.site);
      const p = db.planOf(owner(ctx).id);
      if (args.finish !== false) confirmed(args, 'site_deploy makes these files live');
      const files = args.files.map((x) => {
        const path = cleanPath(x.path);
        const body = Buffer.from(x.content, x.encoding === 'base64' ? 'base64' : 'utf8');
        return { path, type: x.type && /^[a-z]+\/[\w.+-]+/.test(x.type) ? x.type : typeFor(path), body };
      });
      const v = db.stagingVersion(s.id, args.deploy);
      if (!v) throw new HttpError(404, 'that deploy is closed or unknown; start a new one without deploy');
      // A deploy that fails is dropped whole, so it never takes a version number or keeps files.
      try {
        return finishDeploy(s, p, v, files, args);
      } catch (e) {
        db.dropVersion(v.id);
        throw e;
      }
    }),
    T('site_versions', 'Site versions', 'Deployed versions kept for rollback.', { site: S }, async ({ site: ref }, ctx) => {
      const s = site(ctx, ref);
      return { versions: db.versions(s.id).map((v) => ({ ...v, created_at: new Date(v.created_at).toISOString() })) };
    }, RO),
    T('site_rollback', 'Roll back a site', 'Make an earlier version live again (confirm: true).', { site: S, version: z.number().int(), confirm: z.boolean().optional() }, async (args, ctx) => {
      const s = site(ctx, args.site);
      const v = db.versionByNumber(s.id, args.version);
      if (!v) throw new HttpError(404, `version ${args.version} is not kept (site_versions)`);
      confirmed(args, `site_rollback makes version ${args.version} live`);
      db.goLive(s.id, v.id, db.planOf(owner(ctx).id).limits.versions);
      return { live: true, version: v.version, url: siteUrl(s) };
    }),
    T('site_domain', 'Use your own domain', 'Serve a site on your own domain (Solo and up). Returns the DNS records to add. Pass domain null to remove it.', { site: S, domain: z.string().max(253).nullable() }, async ({ site: ref, domain }, ctx) => {
      const s = site(ctx, ref);
      if (domain === null) return { site: db.updateSite(s.id, { domain: null }).slug, domain: null };
      const p = db.planOf(owner(ctx).id);
      if (!p.limits.domain) throw new HttpError(402, 'your own domain needs Solo or up (plan_checkout)');
      const d = domain.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d) || d.endsWith(new URL(publicUrl).hostname)) throw new HttpError(400, 'not a domain you can point here');
      const taken = db.siteByDomain(d);
      if (taken && taken.id !== s.id) throw new HttpError(409, 'that domain is on another site');
      db.updateSite(s.id, { domain: d });
      const app = env.C0MPUTE_APP_ID || 'see /api/v1/pricing';
      return { domain: d, dns: [{ type: 'CNAME', name: d, value: 'gateway.c0mpute.com' }, { type: 'TXT', name: `_c0mpute-app.${d}`, value: `app=${app}` }], note: 'This app runs on the c0mpute network. Once both records resolve, c0mpute routes the domain here and issues its certificate; a blog-only setup uses blog.yourdomain.com the same way.' };
    }),
    T('site_settings', 'Site settings', 'Bookings hours, shop payment link, notification webhook.', {
      site: S,
      settings: z.object({
        bookings: z.object({ days: z.array(z.number().int().min(0).max(6)).optional(), start: z.string().regex(/^\d\d:\d\d$/).optional(), end: z.string().regex(/^\d\d:\d\d$/).optional(), minutes: z.number().int().min(10).max(240).optional(), utc_offset_minutes: z.number().int().min(-720).max(840).optional(), timezone_label: z.string().max(40).optional() }).optional(),
        payment_link: z.string().max(500).optional().describe('Your CoinPay payment link; {amount} and {order} are filled in'),
        notify_webhook: z.string().max(500).optional().describe('https URL that gets every form, booking, sign-up and order as JSON'),
        currency: z.string().length(3).optional(),
      }),
    }, async ({ site: ref, settings }, ctx) => {
      const s = site(ctx, ref);
      for (const k of ['payment_link', 'notify_webhook']) if (settings[k] && !/^https:\/\//.test(settings[k])) throw new HttpError(400, `${k} must be an https URL`);
      return { settings: db.updateSite(s.id, { settings: { ...s.settings, ...settings } }).settings };
    }),
    T('site_delete', 'Delete a site', 'Delete a site, its versions, blog, forms, inbox and shop (confirm: true).', { site: z.string(), confirm: z.boolean().optional() }, async (args, ctx) => {
      const s = site(ctx, args.site);
      confirmed(args, `site_delete removes ${s.slug} for good`);
      db.deleteSite(s.id);
      return { deleted: s.slug };
    }),
    T('site_publish_c0mpute', 'Mirror a site to c0mpute hosting', 'Push the live version\'s text files to c0mpute hosting (self-healing copies on the peer-to-peer network) with your own c0mpute key (c0k_…, from c0mpute.com/chat). The key is used for this call only, never stored. Text files only, 1 MiB, 200 files.', {
      site: S,
      c0mpute_key: z.string().startsWith('c0k_'),
      name: z.string().max(63).optional(),
    }, async ({ site: ref, c0mpute_key, name }, ctx) => {
      const s = site(ctx, ref);
      const live = db.versions(s.id).find((v) => v.status === 'live');
      if (!live) throw new HttpError(409, 'deploy the site first');
      const files = db
        .versionFileBodies(live.id)
        .filter((x) => /^(text\/|application\/(json|xml|manifest)|image\/svg)/.test(x.type))
        .slice(0, 200)
        .map((x) => ({ path: x.path, type: x.type.split(';')[0], text: Buffer.from(x.body).toString('utf8') }));
      const r = await f(`${c0mputeUrl}/api/v1/hosting/pushes`, { method: 'POST', headers: { authorization: `Bearer ${c0mpute_key}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: slugify(name || s.slug).slice(0, 63), files }), signal: AbortSignal.timeout(30000) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok && r.status !== 202) throw new HttpError(r.status === 401 ? 401 : 502, `c0mpute hosting: ${j.error ?? r.status}`);
      return { push: j.push ?? j, files: files.length, poll: `${c0mputeUrl}${j.poll ?? ''}`, note: 'It goes live in a minute or two at https://gateway.c0mpute.com/s/<site_id>/ (poll with your key).' };
    }),

    // ---- blog
    T('blog_write', 'Write a blog post', `Write a blog post in the persona's voice on c0mpute (${COSTS.blog_post} credits) and save it as a draft, or publish: true.`, {
      site: S, topic: z.string().min(3).max(500), lang: z.string().min(2).max(8).optional(), words: z.number().int().min(300).max(2000).optional(), publish: z.boolean().optional(),
    }, async ({ site: ref, topic, lang = 'en', words = 800, publish }, ctx) => {
      const s = site(ctx, ref);
      const p = persona(ctx) ?? {};
      const brand = brandOf(s, p);
      const out = await generate({
        feature: 'blog',
        system: `You write blog posts for ${brand.name}${p.niche ? ` (${p.niche})` : ''}. Voice: ${p.voice ?? 'plain, specific, useful'}. Audience: ${p.audience ?? 'the site\'s readers'}. Never invent facts, numbers, customers or quotes; say what is general advice. No clickbait. Write in language "${lang}". Answer as JSON: {"title": string, "summary": string (one sentence), "body_md": string (Markdown, about ${words} words, ## subheadings)}.`,
        user: `Topic: ${topic}${p.cta ? `\nEnd with this call to action where it fits: ${p.cta}` : ''}`,
        validate: (v) => {
          if (!v?.title || !v?.body_md || String(v.body_md).length < 200) throw new Error('need title and body_md');
          return { title: String(v.title).slice(0, 140), summary: String(v.summary ?? '').slice(0, 300), body_md: String(v.body_md) };
        },
      });
      let slug = slugify(out.title);
      for (let i = 2; db.postBySlug(s.id, slug, lang)?.lang === lang; i++) slug = `${slugify(out.title).slice(0, 55)}-${i}`;
      const post = db.savePost(s.id, { ...out, slug, lang, status: publish ? 'published' : 'draft' });
      return { post: { id: post.id, title: post.title, slug: post.slug, status: post.status, url: `${siteUrl(s)}blog/${post.slug}` }, body_md: post.body_md };
    }, { cost: () => COSTS.blog_post, slow: true }),
    T('blog_save', 'Save a blog post', 'Create or edit a post you wrote yourself (Markdown). status: draft or published.', {
      site: S, id: z.string().optional(), title: z.string().min(1).max(140), body_md: z.string().min(1).max(200_000), slug: z.string().max(60).optional(), lang: z.string().min(2).max(8).optional(), summary: z.string().max(300).optional(), status: z.enum(['draft', 'published']).optional(),
    }, async (a, ctx) => {
      const s = site(ctx, a.site);
      if (a.id && db.post(a.id)?.site_id !== s.id) throw new HttpError(404, 'no such post on this site');
      const lang = a.lang ?? 'en';
      const langs = new Set([...db.siteLanguages(s.id), lang]);
      const lim = db.planOf(owner(ctx).id).limits.languages;
      if (langs.size > lim) throw new HttpError(402, `your plan allows ${lim} site languages`);
      const post = db.savePost(s.id, { id: a.id, title: a.title, body_md: a.body_md, slug: slugify(a.slug || a.title), lang, summary: a.summary, status: a.status ?? 'draft' });
      return { post: { id: post.id, slug: post.slug, status: post.status, url: `${siteUrl(s)}blog/${post.slug}` } };
    }),
    T('blog_list', 'Blog posts', 'Posts on a site, newest first.', { site: S, status: z.enum(['draft', 'published']).optional() }, async ({ site: ref, status }, ctx) => {
      const s = site(ctx, ref);
      return { posts: db.posts(s.id, { status }).map((p) => ({ ...p, url: `${siteUrl(s)}blog/${p.slug}` })) };
    }, RO),
    T('blog_get', 'Read a blog post', 'One post with its Markdown.', { site: S, id: z.string() }, async ({ site: ref, id }, ctx) => {
      const s = site(ctx, ref);
      const p = db.post(id);
      if (!p || p.site_id !== s.id) throw new HttpError(404, 'no such post');
      return { post: p };
    }, RO),
    T('blog_delete', 'Delete a blog post', 'Delete a post.', { site: S, id: z.string() }, async ({ site: ref, id }, ctx) => {
      const s = site(ctx, ref);
      if (db.post(id)?.site_id !== s.id) throw new HttpError(404, 'no such post');
      db.deletePost(id);
      return { deleted: id };
    }),
    T('blog_translate', 'Translate a blog post', `Translate a post into another language on c0mpute (${COSTS.translation} credits); it is saved next to the original with the same slug.`, { site: S, id: z.string(), lang: z.string().min(2).max(8), publish: z.boolean().optional() }, async ({ site: ref, id, lang, publish }, ctx) => {
      const s = site(ctx, ref);
      const src = db.post(id);
      if (!src || src.site_id !== s.id) throw new HttpError(404, 'no such post');
      const langs = new Set([...db.siteLanguages(s.id), lang]);
      const lim = db.planOf(owner(ctx).id).limits.languages;
      if (langs.size > lim) throw new HttpError(402, `your plan allows ${lim} site languages`);
      const out = await generate({
        feature: 'translate',
        system: `Translate this blog post into language "${lang}". Keep the Markdown structure, links and code exactly. Answer as JSON: {"title": string, "summary": string, "body_md": string}.`,
        user: JSON.stringify({ title: src.title, summary: src.summary, body_md: src.body_md }),
        validate: (v) => {
          if (!v?.title || !v?.body_md) throw new Error('need title and body_md');
          return { title: String(v.title), summary: String(v.summary ?? ''), body_md: String(v.body_md) };
        },
      });
      const existing = db.postBySlug(s.id, src.slug, lang);
      const post = db.savePost(s.id, { id: existing?.lang === lang ? existing.id : undefined, ...out, slug: src.slug, lang, source_id: src.id, status: publish ? 'published' : 'draft' });
      return { post: { id: post.id, lang, status: post.status, url: `${siteUrl(s)}blog/${post.slug}?lang=${lang}` } };
    }, { cost: () => COSTS.translation, slow: true }),
    T('newsletter_write', 'Draft a newsletter', `Draft a newsletter issue from the site's recent posts on c0mpute (${COSTS.newsletter} credits). Returns subject and Markdown; send it with your mail tool to the list from subscribers.`, { site: S, topic: z.string().max(300).optional() }, async ({ site: ref, topic }, ctx) => {
      const s = site(ctx, ref);
      const recent = db.posts(s.id, { status: 'published' }).slice(0, 5).map((p) => ({ title: p.title, summary: p.summary, url: `${siteUrl(s)}blog/${p.slug}` }));
      const p = persona(ctx) ?? {};
      const out = await generate({
        feature: 'newsletter',
        system: `You write a short newsletter issue for ${brandOf(s, p).name}. Voice: ${p.voice ?? 'plain and warm'}. Only link to the URLs given. No invented facts. Answer as JSON: {"subject": string, "body_md": string}.`,
        user: JSON.stringify({ topic: topic ?? 'what is new', recent }),
        validate: (v) => {
          if (!v?.subject || !v?.body_md) throw new Error('need subject and body_md');
          return { subject: String(v.subject).slice(0, 120), body_md: String(v.body_md) };
        },
      });
      return { ...out, recipients: db.subscribers(s.id).filter((x) => x.status === 'subscribed').length };
    }, { cost: () => COSTS.newsletter, slow: true }),

    // ---- forms, inbox, newsletter list, bookings
    T('form_save', 'Create or edit a form', 'A form your pages embed with <ai-form site="…" form="…">. Messages land in inbox.', {
      site: S, slug: z.string().regex(/^[a-z0-9-]{1,40}$/), name: z.string().max(80),
      fields: z.array(z.object({ name: z.string().regex(/^[a-z0-9_]{1,40}$/), label: z.string().max(80), type: z.enum(['text', 'email', 'tel', 'textarea', 'number', 'date', 'select', 'checkbox']).optional(), required: z.boolean().optional(), options: z.array(z.string().max(80)).max(30).optional() })).min(1).max(30),
    }, async ({ site: ref, slug, name, fields }, ctx) => {
      const s = site(ctx, ref);
      const lim = db.planOf(owner(ctx).id).limits.forms;
      if (!db.form(s.id, slug) && db.countForms(s.id) >= lim) throw new HttpError(402, `your plan allows ${lim} forms`);
      const fm = db.saveForm(s.id, { slug, name, fields });
      return { form: fm, embed: `<ai-form site="${s.slug}" form="${slug}"></ai-form>\n<script type="module" src="${publicUrl}/embed.js"></script>` };
    }),
    T('form_list', 'Forms', 'Forms on a site.', { site: S }, async ({ site: ref }, ctx) => ({ forms: db.forms(site(ctx, ref).id) }), RO),
    T('form_delete', 'Delete a form', 'Delete a form (its messages stay in the inbox).', { site: S, slug: z.string() }, async ({ site: ref, slug }, ctx) => {
      db.deleteForm(site(ctx, ref).id, slug);
      return { deleted: slug };
    }),
    T('inbox', 'Inbox', 'Form messages, booking requests, newsletter sign-ups and orders, newest first.', { site: S, kind: z.enum(['form', 'booking', 'newsletter', 'order']).optional(), mark_seen: z.boolean().optional(), limit: z.number().int().min(1).max(500).optional() }, async ({ site: ref, kind, mark_seen, limit }, ctx) => {
      const s = site(ctx, ref);
      const items = db.inbox(s.id, { kind, limit });
      if (mark_seen) db.markSeen(s.id, items.map((i) => i.id));
      return { items: items.map((i) => ({ ...i, at: new Date(i.created_at).toISOString() })), unseen: items.filter((i) => !i.seen).length };
    }),
    T('subscribers', 'Newsletter list', 'Who signed up for the newsletter.', { site: S }, async ({ site: ref }, ctx) => ({ subscribers: db.subscribers(site(ctx, ref).id) }), RO),
    T('booking_list', 'Bookings', 'Upcoming bookings.', { site: S }, async ({ site: ref }, ctx) => {
      const s = site(ctx, ref);
      return { bookings: db.bookings(s.id, Date.now() - 86_400_000).map((b) => ({ ...b, start: new Date(b.start_at).toISOString(), end: new Date(b.end_at).toISOString() })), settings: s.settings.bookings ?? null };
    }, RO),
    T('booking_update', 'Confirm or cancel a booking', 'Set a booking to confirmed, cancelled or done.', { site: S, id: z.string(), status: z.enum(['confirmed', 'cancelled', 'done']) }, async ({ site: ref, id, status }, ctx) => {
      const s = site(ctx, ref);
      db.setBooking(s.id, id, status);
      return { booking: db.booking(id) };
    }),

    // ---- shop
    T('product_save', 'Add or edit a product', 'A product in the site\'s shop (Solo and up). Price in the currency\'s main unit, e.g. 19.99.', {
      site: S, id: z.string().optional(), name: z.string().min(1).max(120), price: z.number().min(0).max(1_000_000), currency: z.string().length(3).optional(), description: z.string().max(4000).optional(), category: z.string().max(60).optional(), variants: z.array(z.string().max(60)).max(30).optional(), image: z.string().max(2048).optional(), active: z.boolean().optional(),
    }, async (a, ctx) => {
      const s = site(ctx, a.site);
      if (!db.planOf(owner(ctx).id).limits.shop) throw new HttpError(402, 'the shop needs Solo or up (plan_checkout)');
      if (a.id && db.product(a.id)?.site_id !== s.id) throw new HttpError(404, 'no such product');
      const p = db.saveProduct(s.id, { id: a.id, name: a.name, price_cents: Math.round(a.price * 100), currency: (a.currency ?? s.settings.currency ?? 'USD').toUpperCase(), description: a.description, category: a.category, variants: a.variants, image: a.image, active: a.active });
      return { product: p, embed: `<ai-shop site="${s.slug}"></ai-shop>` };
    }),
    T('product_list', 'Products', 'Products in the shop.', { site: S }, async ({ site: ref }, ctx) => ({ products: db.products(site(ctx, ref).id) }), RO),
    T('product_delete', 'Delete a product', 'Remove a product.', { site: S, id: z.string() }, async ({ site: ref, id }, ctx) => {
      db.deleteProduct(site(ctx, ref).id, id);
      return { deleted: id };
    }),
    T('order_list', 'Orders', 'Shop orders, newest first.', { site: S }, async ({ site: ref }, ctx) => ({ orders: db.orders(site(ctx, ref).id) }), RO),
    T('order_update', 'Update an order', 'Mark an order paid, ready, shipped, done or cancelled.', { site: S, id: z.string(), status: z.enum(['paid', 'ready', 'shipped', 'done', 'cancelled']) }, async ({ site: ref, id, status }, ctx) => {
      const s = site(ctx, ref);
      db.setOrder(s.id, id, status);
      return { order: db.order(id) };
    }),

    // ---- social
    T('social_schedule', 'Schedule posts', 'Schedule posts (or save drafts) for any network. At the set time your desktop environment publishes them in a real browser through the W3BS desktop layer. Free.', {
      posts: z.array(z.object({ platform: z.enum(NETWORKS), text: z.string().min(1).max(40_000), at: z.string().optional().describe('ISO time; default now + 5 minutes'), title: z.string().max(300).optional(), link: z.string().max(2048).optional(), subreddit: z.string().max(60).optional() })).min(1).max(100),
      site: S, desktop: z.string().optional(), draft: z.boolean().optional(),
    }, async ({ posts, site: ref, desktop, draft }, ctx) => {
      const o = owner(ctx);
      const s = ref ? site(ctx, ref) : null;
      const out = posts.map((p) => {
        const at = p.at ? Date.parse(p.at) : Date.now() + 5 * 60_000;
        if (!Number.isFinite(at)) throw new HttpError(400, `bad time "${p.at}"`);
        return db.schedule(o.id, { ...p, at, site_id: s?.id, desktop_id: desktop ? db.pickDesktop(o.id, desktop)?.id : null, status: draft ? 'draft' : 'scheduled' });
      });
      const hasDesktop = db.desktops(o.id).length > 0;
      return { scheduled: out.map((p) => ({ id: p.id, platform: p.platform, at: new Date(p.at).toISOString(), status: p.status })), ...(hasDesktop ? {} : { warning: 'no desktop environment yet: add one with desktop_add so these can publish' }) };
    }),
    T('social_list', 'Scheduled posts', 'Scheduled, queued, published, failed and draft posts.', { status: z.enum(['draft', 'scheduled', 'queued', 'published', 'failed', 'needs_desktop']).optional() }, async ({ status }, ctx) => ({ posts: db.socialList(owner(ctx).id, status).map((p) => ({ ...p, at: new Date(p.at).toISOString() })) }), RO),
    T('social_cancel', 'Cancel a scheduled post', 'Turn a scheduled post back into a draft.', { id: z.string() }, async ({ id }, ctx) => {
      const p = db.socialPost(id);
      if (!p || p.account_id !== owner(ctx).id) throw new HttpError(404, 'no such post');
      if (!['scheduled', 'needs_desktop', 'failed'].includes(p.status)) throw new HttpError(409, `it is ${p.status}`);
      return { post: db.setSocial(id, { status: 'draft' }) };
    }),
    T('social_publish_now', 'Publish a post now', 'Send a post to your desktop environment to publish right away. Needs the person\'s go-ahead: confirm: true.', { id: z.string(), desktop: z.string().optional(), confirm: z.boolean().optional() }, async (args, ctx) => {
      const p = db.socialPost(args.id);
      if (!p || p.account_id !== owner(ctx).id) throw new HttpError(404, 'no such post');
      if (p.status === 'published') throw new HttpError(409, 'already published');
      confirmed(args, `social_publish_now posts to ${p.platform} now`);
      const { desktop, job } = toDesktop(ctx, 'publish', { platform: p.platform, text: p.text, title: p.title, link: p.link, subreddit: p.subreddit }, { desktop: args.desktop, socialId: p.id });
      db.setSocial(p.id, { status: 'queued', desktop_id: desktop.id });
      return { queued: true, desktop: desktop.name, online: desktop.online, job: job.id };
    }),

    // ---- ads and reels
    T('ad_create', 'Make static ads', `Static ads in your brand, each in 1:1, 4:5 and 9:16 (${COSTS.ad} credits each). Copy is written on c0mpute unless you give the headline. Free plan: the first 2 are clean (growth preview), then watermarked.`, {
      site: S, topic: z.string().max(500).optional(), headline: z.string().max(90).optional(), sub: z.string().max(160).optional(), cta: z.string().max(24).optional(), count: z.number().int().min(1).max(6).optional(),
    }, async (a, ctx) => {
      const o = owner(ctx);
      const s = site(ctx, a.site);
      const p = db.planOf(o.id);
      const brand = brandOf(s, persona(ctx));
      const n = a.count ?? 1;
      let copies;
      if (a.headline) copies = [{ headline: a.headline, sub: a.sub ?? '', cta: a.cta ?? 'Learn more' }];
      else {
        const pr = persona(ctx) ?? {};
        copies = (
          await generate({
            feature: 'ads',
            system: `You write static ad copy for ${brand.name}. ${brand.tagline ? `What it is: ${brand.tagline}.` : ''} Voice: ${pr.voice ?? 'clear and confident'}. Never invent numbers, awards, customers or prices. Headline at most 8 words, sub at most 20 words, CTA at most 3 words. Answer as JSON: {"ads": [{"headline", "sub", "cta"}]} with ${n} different angles.`,
            user: a.topic ?? `Ads for ${brand.name}`,
            validate: validateCopy,
          })
        ).ads;
      }
      const made = [];
      for (let i = 0; i < n; i++) {
        const watermark = p.limits.watermark && db.countAds(o.id, false) >= 2;
        made.push(adOut(db.addAd(o.id, s.id, copies[i % copies.length], brand, watermark)));
      }
      return { ads: made };
    }, { cost: (a) => COSTS.ad * (a.count ?? 1), slow: true }),
    T('ad_list', 'Ads', 'Ads you made, with their image links.', {}, async (_a, ctx) => ({ ads: db.ads(owner(ctx).id).map(adOut) }), RO),
    T('preview_ads', 'Free preview ads', 'Paste any website: read its brand kit and get 3 watermarked preview ads. Free, no sign-in.', { url: z.string().max(2048) }, async ({ url }, ctx) => {
      const key = ctx?.account ? `prev:${ctx.account.id}` : `prev:ip:${ctx?.ip ?? 'x'}`;
      if (db.hit(key) > 5) throw new HttpError(429, 'previews are limited to 5 a day; sign in to make real ads');
      const brand = await readBrand(url);
      const anon = ctx?.account ? owner(ctx).id : 'anonymous';
      return { brand: { name: brand.name, colors: brand.colors, font: brand.font, tagline: brand.tagline }, ads: [0, 1, 2].map((i) => adOut(db.addAd(anon, null, templateCopy(brand, i), brand, true))), next: `${publicUrl}/pricing` };
    }),
    T('reel_create', 'Make a reel', `A short video of your website made by c0mpute's promo pipeline (${COSTS.reel} credits; 5 to 15 minutes; refunded if it fails). Free plan: one reel in the growth preview.`, {
      url: z.string().max(2048).optional().describe('Default: your site'), site: S, style: z.enum(['pixar', 'anime', 'claymation', 'flat', 'watercolor', 'comic', 'cinematic']).optional(), vertical: z.boolean().optional(), brief: z.string().max(2000).optional(),
    }, async (a, ctx) => {
      const o = owner(ctx);
      const url = a.url ?? siteUrl(site(ctx, a.site));
      const r = db.addReel(o.id, url, ctx.charge ? { ...ctx.charge, cost: COSTS.reel } : null);
      db.setReel(r.id, { status: 'starting', video: JSON.stringify({ url, style: a.style, vertical: a.vertical ?? true, brief: a.brief }) });
      await pollReel(db.reel(r.id)).catch(() => {});
      return { reel: reelOut(db.reel(r.id)), next: 'reel_status with this id every minute or so' };
    }, {
      cost: () => COSTS.reel,
      precheck: (_a, ctx) => {
        const o = owner(ctx);
        if (!db.planOf(o.id).limits.reels && db.countReels(o.id) >= 1) throw new HttpError(402, 'your growth-preview reel is used; reels come with Solo and up (plan_checkout)');
      },
    }),
    T('reel_status', 'Reel status', 'Where a reel is; the video link when done.', { id: z.string().optional() }, async ({ id }, ctx) => {
      const o = owner(ctx);
      if (!id) return { reels: db.reels(o.id).map(reelOut) };
      const r = db.reel(id);
      if (!r || r.account_id !== o.id) throw new HttpError(404, 'no such reel');
      if (r.status === 'pending' || r.status === 'starting') await pollReel(r).catch(() => {});
      return { reel: reelOut(db.reel(id)) };
    }, RO),

    // ---- desktop environments
    T('desktop_add', 'Add a desktop environment', 'Register a computer (laptop, workstation or headless box) that does the browser work: publishing posts and app captures. Returns a token, shown once, and the command that connects it. The computer opens a two-way channel to us, so no ports are opened, and drives its browser through the W3BS Agentic Desktop Layer.', {
      name: z.string().min(1).max(60), kind: z.enum(['w3bs', 'headless', 'ssh-tunnel']).optional(),
    }, async ({ name, kind = 'w3bs' }, ctx) => {
      const o = owner(ctx);
      if (db.desktops(o.id).length >= 10) throw new HttpError(409, 'ten desktops is the limit; remove one first');
      const token = `${DESKTOP_TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
      const d = db.addDesktop(o.id, name, kind, hashToken(token));
      return {
        desktop: d,
        token,
        connect: {
          setup: ['curl -fsSL https://w3bs.org/desktop/install.sh | sh', 'w3bs desktop agents add autoinfluencer --preset broad', 'w3bs desktop browser launch'],
          run: `npx -y @profullstack/autoinfluencer desktop connect --token ${token}`,
          desktop_app: 'Or in the autoinfluencer desktop app: Agents → Connect this computer, paste the token.',
        },
        how_it_works: 'The connector long-polls us over HTTPS (desktop → us), receives jobs on the same channel (us → desktop), runs them through the local W3BS desktop broker (127.0.0.1:7801/mcp, the agent browser), and posts results back. The token also lets agents on that computer call every tool here as you. The person at the desktop approves the agent once and can stop it any time.',
      };
    }),
    T('desktop_list', 'Desktop environments', 'Your desktops, whether each is connected now, and what it reported (OS, broker, browser).', {}, async (_a, ctx) => ({ desktops: db.desktops(owner(ctx).id).map((d) => ({ ...d, last_seen: d.last_seen ? new Date(d.last_seen).toISOString() : null })) }), RO),
    T('desktop_remove', 'Remove a desktop environment', 'Revoke a desktop\'s token; its queued jobs fail.', { id: z.string() }, async ({ id }, ctx) => {
      const d = db.pickDesktop(owner(ctx).id, id);
      if (!d) throw new HttpError(404, 'no such desktop');
      db.deleteDesktop(d.id);
      return { removed: d.name };
    }),
    T('desktop_jobs', 'Desktop jobs', 'Jobs sent to your desktops and their results.', { limit: z.number().int().min(1).max(200).optional() }, async ({ limit }, ctx) => ({ jobs: db.dJobs(owner(ctx).id, limit).map(({ charge: _c, ...j }) => ({ ...j, created_at: new Date(j.created_at).toISOString() })) }), RO),
    T('desktop_open', 'Open a page on a desktop', 'Open a URL in the agent browser on your desktop environment (to sign in to a network once, say). Free.', { url: z.string().url(), desktop: z.string().optional() }, async ({ url, desktop }, ctx) => {
      const { desktop: d, job } = toDesktop(ctx, 'open', { url }, { desktop });
      return { queued: job.id, desktop: d.name, online: d.online };
    }),
    T('app_capture', 'Record your web app', `Open your web app on your desktop environment and capture real screens for ads (${COSTS.app_capture} credits, refunded if nothing usable comes back). Sign-ins are handed to the person at the desktop, never typed from here.`, {
      url: z.string().url(), steps: z.array(z.string().max(200)).max(12).optional().describe('Link or button texts to click, in order'), desktop: z.string().optional(),
    }, async ({ url, steps, desktop }, ctx) => {
      const { desktop: d, job } = toDesktop(ctx, 'capture', { url, steps: steps ?? [] }, { desktop, charge: ctx.charge ? { ...ctx.charge, cost: COSTS.app_capture } : null });
      return { queued: job.id, desktop: d.name, online: d.online, next: 'desktop_jobs shows the frames when it is done' };
    }, { cost: () => COSTS.app_capture }),
  ];

  return { tools, tick, start, stop, desktopResult, readBrand, refund, siteUrl, hashToken, adUrls, c0mpute, notify };
}
