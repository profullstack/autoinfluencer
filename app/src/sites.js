// Public HTTP for what people build here: their sites (on /site/<slug>/ and their own domains),
// blog pages and feed, ads, capture frames, reels, the drop-in components' endpoints
// (forms, newsletter, bookings, shop, blog feed) and the desktop connector's channel.
import { createHash } from 'node:crypto';
import { AD_FORMATS, adSvg, blogIndexPage, blogPostPage, brandOf, feedXml, starterHome, withBadge } from './render.js';
import { DESKTOP_TOKEN_PREFIX } from './platform.js';
import { HttpError, NO_STORE, send, readBody, clientIp } from './util.js';

// User content is served from our origin, so it runs in a CSP sandbox without
// allow-same-origin: an opaque origin that cannot read our cookies or call our API as the visitor.
const SANDBOX = "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-top-navigation-by-user-activation";
const USER_HEADERS = { 'content-security-policy': SANDBOX, 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin' };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-max-age': '86400' };
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
const ipHash = (req) => createHash('sha256').update(`aiv1:${clientIp(req)}`).digest('hex').slice(0, 24);

async function json(req, limit = 32 * 1024) {
  const raw = await readBody(req, limit);
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    // Plain HTML forms post url-encoded bodies.
    return Object.fromEntries(new URLSearchParams(raw));
  }
}

export function createSites({ db, platform, publicUrl, env = process.env, fetch: f = globalThis.fetch }) {
  const appHost = new URL(publicUrl).host;

  // --------------------------------------------------------------- site pages
  function serveSite(req, res, s, rest, url) {
    const plan = db.planOf(s.account_id);
    const base = s.domain && req.headers.host?.split(':')[0] === s.domain ? '' : `${publicUrl}/site/${s.slug}`;
    const brand = brandOf(s, db.persona(s.account_id));
    const html = (body) => send(res, 200, plan.limits.badge ? withBadge(body, publicUrl) : body, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60', ...USER_HEADERS });
    const path = decodeURIComponent(rest).replace(/^\/+/, '');
    const lang = url.searchParams.get('lang') || undefined;

    // A deployed file wins over the built-in pages.
    const candidates = path === '' ? ['index.html'] : path.endsWith('/') ? [`${path}index.html`] : [path, `${path}.html`, `${path}/index.html`];
    for (const c of candidates) {
      const file = db.liveFile(s.id, c);
      if (file) {
        if (/^text\/html/.test(file.type)) return html(Buffer.from(file.body).toString('utf8'));
        return send(res, 200, Buffer.from(file.body), { 'content-type': file.type, 'cache-control': 'public, max-age=300', ...USER_HEADERS });
      }
    }
    const published = db.posts(s.id, { status: 'published', lang: lang ?? 'en' });
    if (path === '' ) return html(starterHome({ site: s, brand, posts: published, base, publicUrl }));
    if (path === 'blog' || path === 'blog/') return html(blogIndexPage({ site: s, brand, posts: published, base, publicUrl, lang }));
    if (path === 'feed.xml') return send(res, 200, feedXml({ site: s, brand, posts: published, base: base || `https://${s.domain}` }), { 'content-type': 'application/rss+xml; charset=utf-8', 'cache-control': 'public, max-age=300' });
    const m = path.match(/^blog\/([a-z0-9-]+)\/?$/);
    if (m) {
      const post = db.postBySlug(s.id, m[1], lang ?? 'en');
      if (post && post.status === 'published') {
        const others = db.posts(s.id, { status: 'published' }).filter((p) => p.slug === post.slug && p.lang !== post.lang);
        return html(blogPostPage({ site: s, brand, post, base, publicUrl, others }));
      }
    }
    const nf = db.liveFile(s.id, '404.html');
    return send(res, 404, nf ? Buffer.from(nf.body).toString('utf8') : '<!doctype html><title>Not found</title><p>Not found.</p>', { 'content-type': 'text/html; charset=utf-8', ...USER_HEADERS });
  }

  // --------------------------------------------------------------- public API (drop-in components)
  function slotsFor(s, fromMs, days) {
    const b = { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', minutes: 30, utc_offset_minutes: 0, ...(s.settings.bookings ?? {}) };
    const off = b.utc_offset_minutes * 60_000;
    const step = b.minutes * 60_000;
    const [sh, sm] = b.start.split(':').map(Number);
    const [eh, em] = b.end.split(':').map(Number);
    const out = [];
    const day0 = new Date(fromMs + off);
    day0.setUTCHours(0, 0, 0, 0);
    for (let d = 0; d < days; d++) {
      const local = new Date(day0.getTime() + d * 86_400_000);
      if (!b.days.includes(local.getUTCDay())) continue;
      const dayStart = local.getTime() + (sh * 60 + sm) * 60_000 - off;
      const dayEnd = local.getTime() + (eh * 60 + em) * 60_000 - off;
      const taken = db.bookingsBetween(s.id, dayStart, dayEnd);
      for (let t = dayStart; t + step <= dayEnd; t += step) {
        if (t < Date.now() + 3_600_000) continue;
        if (taken.some((x) => x.start_at < t + step && x.end_at > t)) continue;
        out.push(new Date(t).toISOString());
      }
    }
    return { slots: out.slice(0, 200), minutes: b.minutes, timezone: b.timezone_label ?? `UTC${b.utc_offset_minutes >= 0 ? '+' : ''}${b.utc_offset_minutes / 60}` };
  }

  async function publicApi(req, res, slug, action, method, url) {
    if (method === 'OPTIONS') return send(res, 204, '', CORS);
    const s = db.siteBySlug(slug);
    if (!s) return send(res, 404, { error: 'no such site' }, CORS);
    const plan = db.planOf(s.account_id);
    const ip = ipHash(req);
    const limited = () => db.hit(`pub:${s.id}:${ip}`) > 40;
    const ok = (body, status = 200) => send(res, status, body, { ...CORS, ...NO_STORE });

    if (method === 'GET' && action === 'posts') {
      const lim = Math.min(20, Number(url.searchParams.get('limit')) || 5);
      const base = s.domain ? `https://${s.domain}` : `${publicUrl}/site/${s.slug}`;
      return ok({ posts: db.posts(s.id, { status: 'published', lang: url.searchParams.get('lang') || 'en' }).slice(0, lim).map((p) => ({ title: p.title, summary: p.summary, url: `${base}/blog/${p.slug}`, published_at: new Date(p.published_at).toISOString() })) });
    }
    if (method === 'GET' && action.startsWith('form/')) {
      const fm = db.form(s.id, action.slice(5));
      return fm ? ok({ form: { slug: fm.slug, name: fm.name, fields: fm.fields } }) : ok({ error: 'no such form' }, 404);
    }
    if (method === 'GET' && action === 'products') {
      if (!plan.limits.shop) return ok({ products: [], currency: 'USD' });
      return ok({ products: db.products(s.id, { active: true }).map(({ site_id: _s, active: _a, ...p }) => p), currency: s.settings.currency ?? 'USD', pay: s.settings.payment_link ? 'coinpay' : 'arranged' });
    }
    if (method === 'GET' && action === 'slots') {
      if (!plan.limits.bookings) return ok({ error: 'bookings are not on for this site' }, 404);
      const from = Date.parse(url.searchParams.get('from') ?? '') || Date.now();
      return ok(slotsFor(s, from, Math.min(31, Number(url.searchParams.get('days')) || 7)));
    }
    if (method !== 'POST') return ok({ error: 'not found' }, 404);
    const b = await json(req);
    if (b._hp) return ok({ ok: true }); // honeypot: bots fill every field
    if (limited()) return ok({ error: 'too many submissions from your network today' }, 429);

    if (action.startsWith('form/')) {
      const fm = db.form(s.id, action.slice(5));
      if (!fm) return ok({ error: 'no such form' }, 404);
      const data = {};
      for (const fld of fm.fields) {
        const v = b[fld.name];
        const str = typeof v === 'string' ? v.trim().slice(0, 5000) : v === true || v === 'on' ? 'yes' : '';
        if (fld.required && !str) return ok({ error: `${fld.label} is required` }, 400);
        if (fld.type === 'email' && str && !EMAIL.test(str)) return ok({ error: `${fld.label} is not an email` }, 400);
        if (str) data[fld.name] = str;
      }
      const id = db.addSubmission(s.id, 'form', fm.slug, data, ip);
      platform.notify?.(s, 'form', { form: fm.slug, data });
      return ok({ ok: true, id, message: 'Thanks, your message was sent.' });
    }
    if (action === 'subscribe') {
      const email = String(b.email ?? '').trim().toLowerCase();
      if (!EMAIL.test(email)) return ok({ error: 'that is not an email' }, 400);
      db.subscribe(s.id, email);
      db.addSubmission(s.id, 'newsletter', 'subscribe', { email }, ip);
      return ok({ ok: true, message: 'You are on the list.' });
    }
    if (action === 'unsubscribe') {
      db.unsubscribe(s.id, String(b.email ?? '').trim().toLowerCase());
      return ok({ ok: true });
    }
    if (action === 'book') {
      if (!plan.limits.bookings) return ok({ error: 'bookings are not on for this site' }, 404);
      const start = Date.parse(b.start ?? '');
      const name = String(b.name ?? '').trim().slice(0, 120);
      const email = String(b.email ?? '').trim().toLowerCase();
      if (!name || !EMAIL.test(email)) return ok({ error: 'name and email are required' }, 400);
      const { slots, minutes } = slotsFor(s, start - 86_400_000, 3);
      if (!Number.isFinite(start) || !slots.includes(new Date(start).toISOString())) return ok({ error: 'that time is no longer free' }, 409);
      const bk = db.addBooking(s.id, { start_at: start, end_at: start + minutes * 60_000, name, email, note: String(b.note ?? '').slice(0, 2000) });
      db.addSubmission(s.id, 'booking', bk.id, { name, email, start: new Date(start).toISOString(), note: bk.note }, ip);
      return ok({ ok: true, booking: { id: bk.id, start: new Date(bk.start_at).toISOString(), status: bk.status }, message: 'Booked. You will hear back to confirm.' });
    }
    if (action === 'order') {
      if (!plan.limits.shop) return ok({ error: 'the shop is not on for this site' }, 404);
      const name = String(b.name ?? '').trim().slice(0, 120);
      const email = String(b.email ?? '').trim().toLowerCase();
      if (!name || !EMAIL.test(email)) return ok({ error: 'name and email are required' }, 400);
      const items = [];
      let total = 0;
      let currency = null;
      for (const it of Array.isArray(b.items) ? b.items.slice(0, 50) : []) {
        const p = db.product(String(it.id ?? ''));
        if (!p || p.site_id !== s.id || !p.active) return ok({ error: 'an item is no longer for sale' }, 409);
        const qty = Math.max(1, Math.min(99, Number(it.qty) || 1));
        const variant = it.variant && p.variants.includes(it.variant) ? it.variant : null;
        if (currency && currency !== p.currency) return ok({ error: 'one currency per order' }, 400);
        currency = p.currency;
        items.push({ id: p.id, name: p.name, variant, qty, price_cents: p.price_cents });
        total += p.price_cents * qty;
      }
      if (!items.length) return ok({ error: 'the basket is empty' }, 400);
      const order = db.addOrder(s.id, { items, total_cents: total, currency, name, email, note: String(b.note ?? '').slice(0, 2000) });
      db.addSubmission(s.id, 'order', order.id, { name, email, total: (total / 100).toFixed(2), currency, items: items.map((i) => `${i.qty}× ${i.name}${i.variant ? ` (${i.variant})` : ''}`) }, ip);
      platform.notify?.(s, 'order', order);
      const link = s.settings.payment_link;
      const pay = link ? link.replace('{amount}', (total / 100).toFixed(2)).replace('{order}', order.id) : null;
      return ok({ ok: true, order: { id: order.id, total: (total / 100).toFixed(2), currency }, pay_url: pay, message: pay ? 'Order placed. Pay with CoinPay to finish.' : 'Order placed. The shop will contact you about payment.' });
    }
    return ok({ error: 'not found' }, 404);
  }

  // --------------------------------------------------------------- desktop connector channel
  function desktopFor(req) {
    const auth = String(req.headers.authorization ?? '');
    const tok = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!tok.startsWith(DESKTOP_TOKEN_PREFIX)) return null;
    return db.desktopByToken(platform.hashToken(tok));
  }

  async function desktopApi(req, res, action, method) {
    const d = desktopFor(req);
    if (!d) return send(res, 401, { error: 'desktop token missing or revoked (desktop_add makes one)' }, NO_STORE);
    if (method !== 'POST') return send(res, 405, { error: 'POST' });
    const b = await json(req, action === 'result' ? 64 * 1024 * 1024 : 64 * 1024);
    if (action === 'poll') {
      db.seeDesktop(d.id, b.info && typeof b.info === 'object' ? b.info : null);
      // Long-poll inside the edge's 15 s window: hand over a job as soon as one is queued.
      const until = Date.now() + Math.min(10_000, Number(b.wait_ms ?? 9000));
      for (;;) {
        const job = db.claimJob(d.id);
        if (job) return send(res, 200, { desktop: { id: d.id, name: d.name }, job: { id: job.id, type: job.type, payload: job.payload } }, NO_STORE);
        if (Date.now() >= until || req.destroyed) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      db.seeDesktop(d.id);
      return send(res, 200, { desktop: { id: d.id, name: d.name }, job: null }, NO_STORE);
    }
    if (action === 'result') {
      db.seeDesktop(d.id);
      return send(res, 200, platform.desktopResult(d, b), NO_STORE);
    }
    if (action === 'progress') {
      db.seeDesktop(d.id);
      return send(res, 200, { ok: true }, NO_STORE);
    }
    return send(res, 404, { error: 'unknown desktop action' });
  }

  // --------------------------------------------------------------- router
  /** Returns true when it answered. */
  return async function route(req, res, url) {
    const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim().toLowerCase();
    const path = url.pathname;
    const method = req.method;

    if (host && host !== appHost && !host.startsWith('127.0.0.1') && !host.startsWith('localhost')) {
      const s = db.siteByDomain(host.split(':')[0]);
      if (s) {
        serveSite(req, res, s, path, url);
        return true;
      }
    }
    let m = path.match(/^\/site\/([a-z0-9-]+)(\/.*)?$/);
    if (m && (method === 'GET' || method === 'HEAD')) {
      const s = db.siteBySlug(m[1]);
      if (!s) {
        send(res, 404, 'No such site.', USER_HEADERS);
        return true;
      }
      if (m[2] === undefined) {
        send(res, 301, '', { location: `/site/${m[1]}/` });
        return true;
      }
      serveSite(req, res, s, m[2], url);
      return true;
    }
    m = path.match(/^\/api\/v1\/public\/([a-z0-9-]+)\/([a-z]+(?:\/[a-z0-9-]+)?)$/);
    if (m) {
      await publicApi(req, res, m[1], m[2], method, url);
      return true;
    }
    m = path.match(/^\/api\/v1\/desktop\/(poll|result|progress)$/);
    if (m) {
      await desktopApi(req, res, m[1], method);
      return true;
    }
    m = path.match(/^\/ad\/(ad_[\w-]+)\/(1x1|4x5|9x16)\.svg$/);
    if (m && method === 'GET') {
      const a = db.ad(m[1]);
      if (!a) return send(res, 404, 'no such ad'), true;
      const fmt = m[2].replace('x', ':');
      send(res, 200, adSvg(a, AD_FORMATS[fmt] ? fmt : '1:1', a.brand.logoData ?? null), { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400', ...USER_HEADERS });
      return true;
    }
    m = path.match(/^\/f\/(f_[\w-]+)$/);
    if (m && method === 'GET') {
      const a = db.asset(m[1]);
      if (!a) return send(res, 404, 'not found'), true;
      send(res, 200, Buffer.from(a.body), { 'content-type': a.type, 'cache-control': 'public, max-age=31536000, immutable', ...USER_HEADERS });
      return true;
    }
    m = path.match(/^\/r\/(reel_[\w-]+)\.mp4$/);
    if (m && method === 'GET') {
      const r = db.reel(m[1]);
      if (!r || r.status !== 'done' || !r.promo_id) return send(res, 404, 'not ready'), true;
      const c = (env.C0MPUTE_URL || 'https://c0mpute.com').replace(/\/$/, '');
      const up = await f(`${c}/api/v1/promo/${encodeURIComponent(r.promo_id)}/video`, { headers: { authorization: `Bearer ${env.C0MPUTE_PROMO_KEY || env.C0MPUTE_API_KEY}` } });
      if (!up.ok) return send(res, 502, 'the video is not available right now'), true;
      send(res, 200, Buffer.from(await up.arrayBuffer()), { 'content-type': 'video/mp4', 'cache-control': 'public, max-age=86400' });
      return true;
    }
    return false;
  };
}

export { HttpError };
