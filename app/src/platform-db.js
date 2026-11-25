// Tables and queries for the platform side: plans, team seats, sites and their versions,
// blog, forms, newsletter, bookings, shop, scheduled social posts, ads, reels, desktop
// environments and the jobs sent to them, and stored files (capture frames).
import { INTERVALS, PLANS } from './plans.js';

export const PLATFORM_SCHEMA = `
create table if not exists subscriptions (
  account_id text primary key,
  plan text not null,
  interval text not null,
  period_end integer not null,
  next_grant_at integer not null,
  updated_at integer not null
);
create table if not exists members (
  account_id text primary key,
  owner_id text not null,
  created_at integer not null
);
create table if not exists invites (
  token_hash text primary key,
  owner_id text not null,
  expires_at integer not null
);
create table if not exists sites (
  id text primary key,
  account_id text not null,
  slug text unique not null,
  name text not null,
  domain text unique,
  brand text,
  settings text not null default '{}',
  live_version integer,
  created_at integer not null
);
create table if not exists site_versions (
  id text primary key,
  site_id text not null,
  version integer not null,
  status text not null,
  files integer not null default 0,
  bytes integer not null default 0,
  note text,
  created_at integer not null
);
create index if not exists site_versions_site on site_versions(site_id, version);
create table if not exists site_files (
  version_id text not null,
  path text not null,
  type text not null,
  body blob not null,
  primary key (version_id, path)
);
create table if not exists blog_posts (
  id text primary key,
  site_id text not null,
  slug text not null,
  lang text not null default 'en',
  title text not null,
  body_md text not null,
  summary text,
  status text not null default 'draft',
  source_id text,
  published_at integer,
  created_at integer not null,
  updated_at integer not null,
  unique (site_id, slug, lang)
);
create table if not exists forms (
  id text primary key,
  site_id text not null,
  slug text not null,
  name text not null,
  fields text not null,
  created_at integer not null,
  unique (site_id, slug)
);
create table if not exists submissions (
  id text primary key,
  site_id text not null,
  kind text not null,
  ref text,
  data text not null,
  ip_hash text,
  seen integer not null default 0,
  created_at integer not null
);
create index if not exists submissions_site on submissions(site_id, created_at);
create table if not exists subscribers (
  site_id text not null,
  email text not null,
  status text not null default 'subscribed',
  created_at integer not null,
  primary key (site_id, email)
);
create table if not exists bookings (
  id text primary key,
  site_id text not null,
  start_at integer not null,
  end_at integer not null,
  name text not null,
  email text not null,
  note text,
  status text not null default 'requested',
  created_at integer not null
);
create table if not exists products (
  id text primary key,
  site_id text not null,
  name text not null,
  description text,
  price_cents integer not null,
  currency text not null default 'USD',
  category text,
  variants text,
  image text,
  active integer not null default 1,
  created_at integer not null
);
create table if not exists orders (
  id text primary key,
  site_id text not null,
  items text not null,
  total_cents integer not null,
  currency text not null default 'USD',
  name text not null,
  email text not null,
  note text,
  status text not null default 'new',
  created_at integer not null
);
create table if not exists social (
  id text primary key,
  account_id text not null,
  site_id text,
  platform text not null,
  text text not null,
  title text,
  link text,
  subreddit text,
  at integer not null,
  status text not null,
  desktop_id text,
  result_url text,
  error text,
  created_at integer not null,
  updated_at integer not null
);
create index if not exists social_due on social(status, at);
create table if not exists ads (
  id text primary key,
  account_id text not null,
  site_id text,
  copy text not null,
  brand text not null,
  watermark integer not null,
  created_at integer not null
);
create table if not exists reels (
  id text primary key,
  account_id text not null,
  promo_id text,
  url text not null,
  status text not null,
  video text,
  error text,
  charge text,
  created_at integer not null,
  updated_at integer not null
);
create table if not exists desktops (
  id text primary key,
  account_id text not null,
  name text not null,
  kind text not null,
  token_hash text unique not null,
  info text,
  last_seen integer,
  created_at integer not null
);
create table if not exists desktop_jobs (
  id text primary key,
  desktop_id text not null,
  account_id text not null,
  type text not null,
  payload text not null,
  status text not null,
  result text,
  error text,
  charge text,
  social_id text,
  created_at integer not null,
  updated_at integer not null
);
create index if not exists desktop_jobs_q on desktop_jobs(desktop_id, status, created_at);
create table if not exists assets (
  id text primary key,
  account_id text not null,
  type text not null,
  body blob not null,
  created_at integer not null
);
create table if not exists hits (
  key text primary key,
  n integer not null,
  day text not null
);
`;

const J = (s, d = null) => {
  if (s == null) return d;
  try {
    return JSON.parse(s);
  } catch {
    return d;
  }
};

export function platformDb({ raw, get, run, tx, now, newId }) {
  const all = (sql, ...a) => raw.prepare(sql).all(...a);
  const DAY = 86_400_000;

  // ---------------------------------------------------------------- plans
  function subscription(accountId) {
    return get('select * from subscriptions where account_id = ?', accountId) ?? null;
  }
  /** The plan in force: a paid plan until its period ends, else Free. */
  function planOf(accountId) {
    const s = subscription(accountId);
    if (s && s.period_end > now() && PLANS[s.plan]) return { ...PLANS[s.plan], interval: s.interval, period_end: s.period_end };
    return { ...PLANS.free, interval: null, period_end: null };
  }

  /** A paid plan period: extends the current one when it is the same plan, else starts now. */
  function startPlan(accountId, plan, interval, ref) {
    return tx(() => {
      if (get('select 1 from ledger where ref = ?', ref)) return false;
      const s = subscription(accountId);
      const days = INTERVALS[interval] ?? 30;
      const from = s && s.plan === plan && s.period_end > now() ? s.period_end : now();
      const end = from + days * DAY;
      run(
        'insert into subscriptions (account_id, plan, interval, period_end, next_grant_at, updated_at) values (?, ?, ?, ?, ?, ?) on conflict(account_id) do update set plan = excluded.plan, interval = excluded.interval, period_end = excluded.period_end, next_grant_at = min(subscriptions.next_grant_at, excluded.next_grant_at), updated_at = excluded.updated_at',
        accountId, plan, interval, end, now(), now(),
      );
      run('insert into ledger (id, account_id, delta, reason, ref, created_at) values (?, ?, 0, ?, ?, ?)', newId(), accountId, `plan ${plan}/${interval}`, ref, now());
      return true;
    });
  }

  /** Monthly credits for every active plan whose grant is due (yearly plans get them monthly). */
  function grantDueCredits() {
    const due = all('select * from subscriptions where next_grant_at <= ? and period_end > ?', now(), now());
    for (const s of due) {
      const plan = PLANS[s.plan];
      const ref = `grant:${s.account_id}:${s.next_grant_at}`;
      tx(() => {
        if (!get('select 1 from ledger where ref = ?', ref) && plan?.creditsMonthly) {
          run('insert into balances (account_id) values (?) on conflict do nothing', s.account_id);
          run('update balances set credits = credits + ? where account_id = ?', plan.creditsMonthly, s.account_id);
          run('insert into ledger (id, account_id, delta, reason, ref, created_at) values (?, ?, ?, ?, ?, ?)', newId(), s.account_id, plan.creditsMonthly, `${plan.name} monthly credits`, ref, now());
        }
        run('update subscriptions set next_grant_at = ? where account_id = ?', s.next_grant_at + 30 * DAY, s.account_id);
      });
    }
    return due.length;
  }

  // ---------------------------------------------------------------- team
  const ownerOf = (accountId) => get('select owner_id from members where account_id = ?', accountId)?.owner_id ?? accountId;
  const members = (ownerId) => all('select m.account_id, a.name, a.email, m.created_at from members m join accounts a on a.id = m.account_id where m.owner_id = ?', ownerId);
  function addInvite(tokenHash, ownerId) {
    run('delete from invites where expires_at < ?', now());
    run('insert into invites (token_hash, owner_id, expires_at) values (?, ?, ?)', tokenHash, ownerId, now() + 7 * DAY);
  }
  function takeInvite(tokenHash) {
    const r = get('select * from invites where token_hash = ?', tokenHash);
    if (!r) return null;
    run('delete from invites where token_hash = ?', tokenHash);
    return r.expires_at > now() ? r.owner_id : null;
  }
  const join = (accountId, ownerId) => run('insert into members (account_id, owner_id, created_at) values (?, ?, ?) on conflict(account_id) do update set owner_id = excluded.owner_id', accountId, ownerId, now());
  const leave = (accountId) => run('delete from members where account_id = ?', accountId);

  // ---------------------------------------------------------------- sites
  const siteRow = (r) => (r ? { ...r, brand: J(r.brand), settings: J(r.settings, {}) } : null);
  const sites = (accountId) => all('select * from sites where account_id = ? order by created_at', accountId).map(siteRow);
  const siteBySlug = (slug) => siteRow(get('select * from sites where slug = ?', slug));
  const siteByDomain = (domain) => siteRow(get('select * from sites where domain = ?', String(domain).toLowerCase()));
  const siteById = (id) => siteRow(get('select * from sites where id = ?', id));
  function createSite(accountId, { slug, name }) {
    const id = `site_${newId(8)}`;
    run('insert into sites (id, account_id, slug, name, created_at) values (?, ?, ?, ?, ?)', id, accountId, slug, name, now());
    return siteById(id);
  }
  function updateSite(id, patch) {
    const cur = siteById(id);
    const next = { ...cur, ...patch };
    run('update sites set name = ?, domain = ?, brand = ?, settings = ? where id = ?', next.name, next.domain ?? null, next.brand ? JSON.stringify(next.brand) : null, JSON.stringify(next.settings ?? {}), id);
    return siteById(id);
  }
  function deleteSite(id) {
    tx(() => {
      for (const v of all('select id from site_versions where site_id = ?', id)) run('delete from site_files where version_id = ?', v.id);
      for (const t of ['site_versions', 'blog_posts', 'forms', 'submissions', 'subscribers', 'bookings', 'products', 'orders']) run(`delete from ${t} where site_id = ?`, id);
      run('delete from sites where id = ?', id);
    });
  }

  // A deploy is a staging version that collects files over one or more calls, then goes live.
  function stagingVersion(siteId, deployId) {
    if (deployId) {
      const v = get("select * from site_versions where id = ? and site_id = ? and status = 'staging'", deployId, siteId);
      return v ?? null;
    }
    const n = (get('select max(version) as v from site_versions where site_id = ?', siteId)?.v ?? 0) + 1;
    const id = `dep_${newId(8)}`;
    run("insert into site_versions (id, site_id, version, status, created_at) values (?, ?, ?, 'staging', ?)", id, siteId, n, now());
    return get('select * from site_versions where id = ?', id);
  }
  function putFiles(versionId, files) {
    tx(() => {
      for (const f of files) run('insert into site_files (version_id, path, type, body) values (?, ?, ?, ?) on conflict(version_id, path) do update set type = excluded.type, body = excluded.body', versionId, f.path, f.type, f.body);
      const s = get('select count(*) as n, coalesce(sum(length(body)), 0) as b from site_files where version_id = ?', versionId);
      run('update site_versions set files = ?, bytes = ? where id = ?', s.n, s.b, versionId);
    });
    return get('select * from site_versions where id = ?', versionId);
  }
  const versionFiles = (versionId) => all('select path, type, length(body) as bytes from site_files where version_id = ? order by path', versionId);
  const versionFileBodies = (versionId) => all('select path, type, body from site_files where version_id = ? order by path', versionId);
  const versions = (siteId) => all('select id, version, status, files, bytes, note, created_at from site_versions where site_id = ? and status != ? order by version desc', siteId, 'staging');
  function goLive(siteId, versionId, keep) {
    return tx(() => {
      const v = get('select * from site_versions where id = ? and site_id = ?', versionId, siteId);
      if (!v) return null;
      run("update site_versions set status = 'old' where site_id = ? and status = 'live'", siteId);
      run("update site_versions set status = 'live' where id = ?", versionId);
      run('update sites set live_version = ? where id = ?', v.version, siteId);
      // Keep the newest `keep` versions for rollback.
      const old = all("select id from site_versions where site_id = ? and status = 'old' order by version desc", siteId).slice(Math.max(0, keep - 1));
      for (const o of old) {
        run('delete from site_files where version_id = ?', o.id);
        run('delete from site_versions where id = ?', o.id);
      }
      return get('select * from site_versions where id = ?', versionId);
    });
  }
  function versionByNumber(siteId, n) {
    return get("select * from site_versions where site_id = ? and version = ? and status != 'staging'", siteId, n) ?? null;
  }
  function liveFile(siteId, path) {
    return get("select f.path, f.type, f.body from site_files f join site_versions v on v.id = f.version_id where v.site_id = ? and v.status = 'live' and f.path = ?", siteId, path) ?? null;
  }
  function dropVersion(id) {
    tx(() => {
      run('delete from site_files where version_id = ?', id);
      run("delete from site_versions where id = ? and status = 'staging'", id);
    });
  }
  const dropStaleStaging = () => {
    for (const v of all("select id from site_versions where status = 'staging' and created_at < ?", now() - DAY)) {
      run('delete from site_files where version_id = ?', v.id);
      run('delete from site_versions where id = ?', v.id);
    }
  };

  // ---------------------------------------------------------------- blog
  const posts = (siteId, { status, lang } = {}) =>
    all(`select id, slug, lang, title, summary, status, source_id, published_at, updated_at from blog_posts where site_id = ?${status ? ' and status = ?' : ''}${lang ? ' and lang = ?' : ''} order by coalesce(published_at, updated_at) desc`, siteId, ...(status ? [status] : []), ...(lang ? [lang] : []));
  const post = (id) => get('select * from blog_posts where id = ?', id) ?? null;
  const postBySlug = (siteId, slug, lang = 'en') => get('select * from blog_posts where site_id = ? and slug = ? and lang = ?', siteId, slug, lang) ?? get("select * from blog_posts where site_id = ? and slug = ? and status = 'published' order by lang = 'en' desc limit 1", siteId, slug) ?? null;
  function savePost(siteId, p) {
    const t = now();
    if (p.id) {
      const cur = post(p.id);
      const next = { ...cur, ...p };
      const pub = next.status === 'published' ? cur.published_at ?? t : null;
      run('update blog_posts set slug = ?, lang = ?, title = ?, body_md = ?, summary = ?, status = ?, published_at = ?, updated_at = ? where id = ?', next.slug, next.lang, next.title, next.body_md, next.summary ?? null, next.status, pub, t, p.id);
      return post(p.id);
    }
    const id = `post_${newId(8)}`;
    run(
      'insert into blog_posts (id, site_id, slug, lang, title, body_md, summary, status, source_id, published_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, siteId, p.slug, p.lang ?? 'en', p.title, p.body_md, p.summary ?? null, p.status ?? 'draft', p.source_id ?? null, p.status === 'published' ? t : null, t, t,
    );
    return post(id);
  }
  const deletePost = (id) => run('delete from blog_posts where id = ?', id);
  const siteLanguages = (siteId) => all('select distinct lang from blog_posts where site_id = ?', siteId).map((r) => r.lang);

  // ---------------------------------------------------------------- forms, newsletter, bookings
  const formRow = (r) => (r ? { ...r, fields: J(r.fields, []) } : null);
  const forms = (siteId) => all('select * from forms where site_id = ? order by created_at', siteId).map(formRow);
  const form = (siteId, slug) => formRow(get('select * from forms where site_id = ? and slug = ?', siteId, slug));
  function saveForm(siteId, { slug, name, fields }) {
    run('insert into forms (id, site_id, slug, name, fields, created_at) values (?, ?, ?, ?, ?, ?) on conflict(site_id, slug) do update set name = excluded.name, fields = excluded.fields', `form_${newId(8)}`, siteId, slug, name, JSON.stringify(fields), now());
    return form(siteId, slug);
  }
  const deleteForm = (siteId, slug) => run('delete from forms where site_id = ? and slug = ?', siteId, slug);
  function addSubmission(siteId, kind, ref, data, ipHash) {
    const id = `sub_${newId(8)}`;
    run('insert into submissions (id, site_id, kind, ref, data, ip_hash, created_at) values (?, ?, ?, ?, ?, ?, ?)', id, siteId, kind, ref ?? null, JSON.stringify(data), ipHash ?? null, now());
    return id;
  }
  const inbox = (siteId, { kind, limit = 100 } = {}) =>
    all(`select id, kind, ref, data, seen, created_at from submissions where site_id = ?${kind ? ' and kind = ?' : ''} order by created_at desc limit ?`, siteId, ...(kind ? [kind] : []), limit).map((r) => ({ ...r, data: J(r.data, {}) }));
  const markSeen = (siteId, ids) => tx(() => ids.forEach((id) => run('update submissions set seen = 1 where id = ? and site_id = ?', id, siteId)));
  const countForms = (siteId) => get('select count(*) as n from forms where site_id = ?', siteId).n;

  const subscribe = (siteId, email) => run("insert into subscribers (site_id, email, created_at) values (?, ?, ?) on conflict(site_id, email) do update set status = 'subscribed'", siteId, email, now());
  const unsubscribe = (siteId, email) => run("update subscribers set status = 'unsubscribed' where site_id = ? and email = ?", siteId, email);
  const subscribers = (siteId) => all('select email, status, created_at from subscribers where site_id = ? order by created_at desc', siteId);

  function addBooking(siteId, b) {
    const id = `bk_${newId(8)}`;
    run('insert into bookings (id, site_id, start_at, end_at, name, email, note, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)', id, siteId, b.start_at, b.end_at, b.name, b.email, b.note ?? null, now());
    return get('select * from bookings where id = ?', id);
  }
  const bookings = (siteId, from = 0) => all('select * from bookings where site_id = ? and end_at >= ? order by start_at', siteId, from);
  const bookingsBetween = (siteId, a, b) => all("select start_at, end_at from bookings where site_id = ? and status != 'cancelled' and start_at < ? and end_at > ?", siteId, b, a);
  const setBooking = (siteId, id, status) => run('update bookings set status = ? where id = ? and site_id = ?', status, id, siteId);
  const booking = (id) => get('select * from bookings where id = ?', id) ?? null;

  // ---------------------------------------------------------------- shop
  const productRow = (r) => (r ? { ...r, variants: J(r.variants, []), active: !!r.active } : null);
  const products = (siteId, { active } = {}) => all(`select * from products where site_id = ?${active ? ' and active = 1' : ''} order by category, name`, siteId).map(productRow);
  const product = (id) => productRow(get('select * from products where id = ?', id));
  function saveProduct(siteId, p) {
    if (p.id) {
      const cur = product(p.id);
      const n = { ...cur, ...p };
      run('update products set name = ?, description = ?, price_cents = ?, currency = ?, category = ?, variants = ?, image = ?, active = ? where id = ?', n.name, n.description ?? null, n.price_cents, n.currency, n.category ?? null, JSON.stringify(n.variants ?? []), n.image ?? null, n.active === false ? 0 : 1, p.id);
      return product(p.id);
    }
    const id = `prod_${newId(8)}`;
    run('insert into products (id, site_id, name, description, price_cents, currency, category, variants, image, active, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)', id, siteId, p.name, p.description ?? null, p.price_cents, p.currency ?? 'USD', p.category ?? null, JSON.stringify(p.variants ?? []), p.image ?? null, now());
    return product(id);
  }
  const deleteProduct = (siteId, id) => run('delete from products where id = ? and site_id = ?', id, siteId);
  function addOrder(siteId, o) {
    const id = `ord_${newId(8)}`;
    run('insert into orders (id, site_id, items, total_cents, currency, name, email, note, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)', id, siteId, JSON.stringify(o.items), o.total_cents, o.currency, o.name, o.email, o.note ?? null, now());
    return order(id);
  }
  function order(id) {
    const r = get('select * from orders where id = ?', id);
    return r ? { ...r, items: J(r.items, []) } : null;
  }
  const orders = (siteId) => all('select * from orders where site_id = ? order by created_at desc limit 200', siteId).map((r) => ({ ...r, items: J(r.items, []) }));
  const setOrder = (siteId, id, status) => run('update orders set status = ? where id = ? and site_id = ?', status, id, siteId);

  // ---------------------------------------------------------------- social
  function schedule(accountId, p) {
    const id = `soc_${newId(8)}`;
    run(
      'insert into social (id, account_id, site_id, platform, text, title, link, subreddit, at, status, desktop_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, accountId, p.site_id ?? null, p.platform, p.text, p.title ?? null, p.link ?? null, p.subreddit ?? null, p.at, p.status ?? 'scheduled', p.desktop_id ?? null, now(), now(),
    );
    return socialPost(id);
  }
  const socialPost = (id) => get('select * from social where id = ?', id) ?? null;
  const socialList = (accountId, status) => all(`select * from social where account_id = ?${status ? ' and status = ?' : ''} order by at desc limit 200`, accountId, ...(status ? [status] : []));
  const setSocial = (id, patch) => {
    const cur = socialPost(id);
    const n = { ...cur, ...patch };
    run('update social set status = ?, at = ?, desktop_id = ?, result_url = ?, error = ?, text = ?, updated_at = ? where id = ?', n.status, n.at, n.desktop_id ?? null, n.result_url ?? null, n.error ?? null, n.text, now(), id);
    return socialPost(id);
  };
  const dueSocial = () => all("select * from social where status = 'scheduled' and at <= ? order by at limit 50", now());

  // ---------------------------------------------------------------- ads, reels, assets
  function addAd(accountId, siteId, copy, brand, watermark) {
    const id = `ad_${newId(8)}`;
    run('insert into ads (id, account_id, site_id, copy, brand, watermark, created_at) values (?, ?, ?, ?, ?, ?, ?)', id, accountId, siteId ?? null, JSON.stringify(copy), JSON.stringify(brand), watermark ? 1 : 0, now());
    return ad(id);
  }
  function ad(id) {
    const r = get('select * from ads where id = ?', id);
    return r ? { ...r, copy: J(r.copy, {}), brand: J(r.brand, {}), watermark: !!r.watermark } : null;
  }
  const ads = (accountId) => all('select id from ads where account_id = ? order by created_at desc limit 100', accountId).map((r) => ad(r.id));
  const countAds = (accountId, watermark) => get('select count(*) as n from ads where account_id = ? and watermark = ?', accountId, watermark ? 1 : 0).n;

  function addReel(accountId, url, charge) {
    const id = `reel_${newId(8)}`;
    run("insert into reels (id, account_id, url, status, charge, created_at, updated_at) values (?, ?, ?, 'starting', ?, ?, ?)", id, accountId, url, JSON.stringify(charge ?? null), now(), now());
    return reel(id);
  }
  function reel(id) {
    const r = get('select * from reels where id = ?', id);
    return r ? { ...r, charge: J(r.charge) } : null;
  }
  const reels = (accountId) => all('select * from reels where account_id = ? order by created_at desc limit 50', accountId).map((r) => ({ ...r, charge: J(r.charge) }));
  const countReels = (accountId) => get("select count(*) as n from reels where account_id = ? and status != 'failed'", accountId).n;
  const setReel = (id, patch) => {
    const n = { ...reel(id), ...patch };
    run('update reels set promo_id = ?, status = ?, video = ?, error = ?, updated_at = ? where id = ?', n.promo_id ?? null, n.status, n.video ?? null, n.error ?? null, now(), id);
    return reel(id);
  };
  const pendingReels = () => all("select * from reels where status in ('starting', 'pending') and updated_at < ?", now() - 20_000).map((r) => ({ ...r, charge: J(r.charge) }));

  function addAsset(accountId, type, body) {
    const id = `f_${newId(12)}`;
    run('insert into assets (id, account_id, type, body, created_at) values (?, ?, ?, ?, ?)', id, accountId, type, body, now());
    return id;
  }
  const asset = (id) => get('select * from assets where id = ?', id) ?? null;

  // ---------------------------------------------------------------- desktops
  const desktopRow = (r) => (r ? { id: r.id, account_id: r.account_id, name: r.name, kind: r.kind, info: J(r.info, {}), last_seen: r.last_seen, online: !!r.last_seen && now() - r.last_seen < 45_000, created_at: r.created_at } : null);
  function addDesktop(accountId, name, kind, tokenHash) {
    const id = `dt_${newId(8)}`;
    run('insert into desktops (id, account_id, name, kind, token_hash, created_at) values (?, ?, ?, ?, ?, ?)', id, accountId, name, kind, tokenHash, now());
    return desktopRow(get('select * from desktops where id = ?', id));
  }
  const desktops = (accountId) => all('select * from desktops where account_id = ? order by created_at', accountId).map(desktopRow);
  const desktop = (id) => desktopRow(get('select * from desktops where id = ?', id));
  const desktopByToken = (tokenHash) => desktopRow(get('select * from desktops where token_hash = ?', tokenHash));
  const seeDesktop = (id, info) => run('update desktops set last_seen = ?, info = coalesce(?, info) where id = ?', now(), info ? JSON.stringify(info) : null, id);
  const deleteDesktop = (id) => {
    run("update desktop_jobs set status = 'failed', error = 'desktop removed' where desktop_id = ? and status in ('queued', 'running')", id);
    run('delete from desktops where id = ?', id);
  };
  /** The desktop that does an account's work: the named one, else the online one seen last. */
  function pickDesktop(accountId, id) {
    if (id) return desktops(accountId).find((d) => d.id === id || d.name === id) ?? null;
    const ds = desktops(accountId).sort((a, b) => (b.last_seen ?? 0) - (a.last_seen ?? 0));
    return ds.find((d) => d.online) ?? ds[0] ?? null;
  }

  const jobRow = (r) => (r ? { ...r, payload: J(r.payload, {}), result: J(r.result), charge: J(r.charge) } : null);
  function queueJob(desktopId, accountId, type, payload, { charge, socialId } = {}) {
    const id = `dj_${newId(10)}`;
    run("insert into desktop_jobs (id, desktop_id, account_id, type, payload, status, charge, social_id, created_at, updated_at) values (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)", id, desktopId, accountId, type, JSON.stringify(payload), JSON.stringify(charge ?? null), socialId ?? null, now(), now());
    return dJob(id);
  }
  const dJob = (id) => jobRow(get('select * from desktop_jobs where id = ?', id));
  /** The next queued job for a desktop, marked running (one at a time per desktop). */
  function claimJob(desktopId) {
    return tx(() => {
      if (get("select 1 from desktop_jobs where desktop_id = ? and status = 'running' and updated_at > ?", desktopId, now() - 15 * 60_000)) return null;
      const r = get("select * from desktop_jobs where desktop_id = ? and status = 'queued' order by created_at limit 1", desktopId);
      if (!r) return null;
      run("update desktop_jobs set status = 'running', updated_at = ? where id = ?", now(), r.id);
      return jobRow({ ...r, status: 'running' });
    });
  }
  function finishDJob(id, { ok, result, error }) {
    run('update desktop_jobs set status = ?, result = ?, error = ?, updated_at = ? where id = ?', ok ? 'done' : 'failed', result ? JSON.stringify(result) : null, error ?? null, now(), id);
    return dJob(id);
  }
  const dJobs = (accountId, limit = 50) => all('select * from desktop_jobs where account_id = ? order by created_at desc limit ?', accountId, limit).map(jobRow);
  /** Running jobs whose desktop went quiet for 15 minutes fail (and refund through the caller). */
  const staleDJobs = () => all("select * from desktop_jobs where status = 'running' and updated_at < ?", now() - 15 * 60_000).map(jobRow);

  // ---------------------------------------------------------------- rate limits
  /** Count a hit for `key` today; returns the count including this one. */
  function hit(key) {
    const day = new Date().toISOString().slice(0, 10);
    run('insert into hits (key, n, day) values (?, 1, ?) on conflict(key) do update set n = case when hits.day = excluded.day then hits.n + 1 else 1 end, day = excluded.day', key, day);
    return get('select n from hits where key = ?', key).n;
  }

  return {
    subscription, planOf, startPlan, grantDueCredits,
    ownerOf, members, addInvite, takeInvite, join, leave,
    sites, siteBySlug, siteByDomain, siteById, createSite, updateSite, deleteSite,
    stagingVersion, putFiles, versionFiles, versionFileBodies, versions, goLive, versionByNumber, liveFile, dropStaleStaging, dropVersion,
    posts, post, postBySlug, savePost, deletePost, siteLanguages,
    forms, form, saveForm, deleteForm, addSubmission, inbox, markSeen, countForms,
    subscribe, unsubscribe, subscribers,
    addBooking, bookings, bookingsBetween, setBooking, booking,
    products, product, saveProduct, deleteProduct, addOrder, order, orders, setOrder,
    schedule, socialPost, socialList, setSocial, dueSocial,
    addAd, ad, ads, countAds, addReel, reel, reels, countReels, setReel, pendingReels, addAsset, asset,
    addDesktop, desktops, desktop, desktopByToken, seeDesktop, deleteDesktop, pickDesktop,
    queueJob, dJob, claimJob, finishDJob, dJobs, staleDJobs,
    hit,
  };
}
