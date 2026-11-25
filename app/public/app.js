const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const PLATFORMS = ['x', 'bluesky', 'mastodon', 'threads', 'linkedin', 'reddit', 'hackernews', 'instagram', 'tiktok', 'youtube', 'facebook', 'telegram', 'newsletter'];
const NETWORKS = ['bluesky', 'x', 'mastodon', 'threads', 'linkedin', 'reddit', 'hackernews', 'facebook', 'instagram', 'tiktok', 'youtube', 'telegram'];
let tool = 'draft';
let persona = null;
let me = null;
let sites = [];
let current = null; // the site open in the Sites panel

for (const el of $$('.origin')) el.textContent = location.origin;
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

/** Run a tool, waiting out c0mpute jobs. Throws with the server's message. */
async function call(name, args = {}) {
  let r = await api(`/api/${name}`, { method: 'POST', body: args });
  while (r.status === 200 && r.data?.job?.status === 'running' && r.data.job.id?.startsWith('job_')) {
    await new Promise((ok) => setTimeout(ok, 3000));
    r = await api('/api/job_status', { method: 'POST', body: { id: r.data.job.id } });
    if (r.data?.job?.status === 'done') return r.data.job.result;
    if (r.data?.job?.status === 'failed') throw new Error(r.data.job.error);
  }
  if (r.status !== 200) throw new Error(r.data?.error ?? `error ${r.status}`);
  return r.data;
}

function say(id, s, bad = false) {
  const el = $(`#${id}`);
  if (!el) return;
  el.textContent = s;
  el.classList.toggle('bad', bad);
}
async function act(statusId, fn, busy = 'Working…') {
  say(statusId, busy);
  try {
    const r = await fn();
    say(statusId, '');
    return r;
  } catch (e) {
    say(statusId, e.message, true);
    return null;
  }
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const when = (t) => (t ? new Date(t).toLocaleString() : '');
const row = (html, actions = '') => `<div class="item"><div>${html}</div>${actions ? `<div class="acts">${actions}</div>` : ''}</div>`;

// ---------------------------------------------------------------- landing: free preview ads
$('#preview')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = e.target.url.value;
  const out = await act('preview-status', () => call('preview_ads', { url }), 'Reading your brand kit…');
  if (out) $('#preview-out').innerHTML = out.ads.map(adCard).join('');
});
function adCard(a) {
  return `<figure class="ad"><img src="${esc(a.images['4:5'])}" alt="${esc(a.copy.headline)}" loading="lazy"><figcaption>${Object.entries(a.images).map(([k, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${k}</a>`).join(' · ')}${a.watermark ? ' · preview' : ''}</figcaption></figure>`;
}

// ---------------------------------------------------------------- boot
async function boot() {
  const r = await api('/api/v1/me');
  if (r.status !== 200) {
    $('#hero').hidden = false;
    const want = location.hash.replace('#', '');
    if ($(`[data-panel="${want}"]`)) {
      const label = $(`[data-panel="${want}"]`).textContent.trim();
      const note = $('#signin-note');
      note.hidden = false;
      note.innerHTML = `Sign in to open <b>${esc(label)}</b>. <a class="btn primary small" href="/api/v1/coinpay/oauth/start?return_to=${encodeURIComponent(`/#${want}`)}">Sign in with CoinPay</a>`;
      for (const a of $$('a[href="/api/v1/coinpay/oauth/start"]')) a.href = `/api/v1/coinpay/oauth/start?return_to=${encodeURIComponent(`/#${want}`)}`;
    }
    return;
  }
  me = r.data;
  $('#app').hidden = false;
  $('#who').innerHTML = `${esc(me.user.name || me.user.email || 'signed in')} · <a href="#" id="logout">sign out</a>`;
  $('#logout').onclick = async (ev) => {
    ev.preventDefault();
    await api('/api/v1/logout', { method: 'POST' });
    location.reload();
  };
  showBalance(me);
  persona = me.persona;
  fillPersona(persona);
  $('#schedule [name=platform]').innerHTML = NETWORKS.map((n) => `<option>${n}</option>`).join('');
  await loadSites();
  const want = new URLSearchParams(location.search).get('panel') || location.hash.replace('#', '');
  show($(`[data-panel="${want}"]`) ? want : 'write');
}

function showBalance(d) {
  const plan = d.plan?.name ?? 'Free';
  $('#side-balance').textContent = `${plan} · ${Number(d.credits ?? 0).toLocaleString()} credits · ${d.free_left ?? 0} free drafts today`;
  $('#plan-now').innerHTML = `<b>${esc(plan)}</b>${d.plan?.period_end ? `, paid through ${new Date(d.plan.period_end).toLocaleDateString()}` : ''} · <b>${Number(d.credits ?? 0).toLocaleString()}</b> credits`;
  if (d.costs) $('#balance-detail').textContent = `Ad ${d.costs.ad} · reel ${d.costs.reel} · blog post ${d.costs.blog_post} · app capture ${d.costs.app_capture} · translation ${d.costs.translation} credits. Sites, forms, bookings, scheduling and publishing are free.`;
}
async function refreshBalance() {
  const r = await api('/api/v1/me');
  if (r.status === 200) showBalance((me = r.data));
}

// ---------------------------------------------------------------- panels
function show(name) {
  for (const b of $$('[data-panel]')) b.toggleAttribute('aria-current', b.dataset.panel === name);
  for (const s of $$('[data-panel-body]')) s.hidden = s.dataset.panelBody !== name;
  const load = { sites: renderSites, blog: loadBlog, inbox: loadInbox, shop: loadShop, social: loadSocial, ads: loadAds, desktops: loadDesktops, plan: loadPlan }[name];
  load?.();
  pollDesktops(name === 'desktops');
  history.replaceState(null, '', `#${name}`);
}
for (const b of $$('[data-panel]')) b.onclick = () => show(b.dataset.panel);
window.addEventListener('hashchange', () => me && $(`[data-panel="${location.hash.slice(1)}"]`) && show(location.hash.slice(1)));

async function loadSites() {
  try {
    sites = (await call('site_list')).sites;
  } catch {
    sites = [];
  }
  for (const sel of $$('.site-pick')) {
    const keep = sel.value;
    sel.innerHTML = sites.length ? sites.map((s) => `<option value="${esc(s.slug)}">${esc(s.name)}</option>`).join('') : '<option value="">No site yet</option>';
    if (keep && sites.some((s) => s.slug === keep)) sel.value = keep;
  }
  renderSites();
}
const pick = (id) => $(`#${id}`).value || undefined;
for (const sel of $$('.site-pick')) sel.onchange = () => ({ 'blog-site': loadBlog, 'inbox-site': loadInbox, 'shop-site': loadShop, 'ads-site': loadAds })[sel.id]?.();

// ---------------------------------------------------------------- sites
function renderSites() {
  $('#sites-list').innerHTML = sites.length
    ? sites.map((s) => row(`<b>${esc(s.name)}</b> <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a><br><small>${s.live_version ? `version ${s.live_version} live` : 'starter page'}${s.domain ? ` · ${esc(s.domain)}` : ''}</small>`, `<button class="btn small" data-open="${esc(s.slug)}">Manage</button>`)).join('')
    : '<p class="small">No sites yet.</p>';
  for (const b of $$('[data-open]')) b.onclick = () => openSite(b.dataset.open);
}
$('#site-new').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const r = await act('sites-status', () => call('site_create', { name: f.name.value, brand_from: f.brand_from.value || undefined }), 'Creating…');
  if (r) {
    f.reset();
    await loadSites();
    openSite(r.site.slug);
  }
});
async function openSite(slug) {
  const r = await act('sites-status', () => call('site_get', { site: slug }));
  if (!r) return;
  current = r.site;
  $('#site-detail').hidden = false;
  $('#site-title').textContent = current.name;
  $('#site-links').innerHTML = `<a href="${esc(current.url)}" target="_blank" rel="noopener">${esc(current.url)}</a> · <a href="${esc(current.url)}blog/" target="_blank" rel="noopener">blog</a> · <a href="${esc(current.url)}feed.xml" target="_blank" rel="noopener">RSS</a>${r.live ? ` · version ${r.live.version}, ${r.live.files.length} files` : ''}`;
  const c = current.brand?.colors ?? {};
  $('#swatches').innerHTML = current.brand ? `<b>${esc(current.brand.name ?? '')}</b> ${['bg', 'fg', 'accent'].map((k) => (c[k] ? `<span class="sw" style="background:${esc(c[k])}" title="${k} ${esc(c[k])}"></span>` : '')).join('')} <small>${esc(current.brand.font ?? '')}</small>` : '<small>No brand kit yet.</small>';
  $('#domain').domain.value = current.domain ?? '';
  const st = current.settings ?? {};
  const f = $('#settings');
  const bk = st.bookings ?? {};
  f.days.value = (bk.days ?? [1, 2, 3, 4, 5]).join(',');
  f.start.value = bk.start ?? '09:00';
  f.end.value = bk.end ?? '17:00';
  f.minutes.value = bk.minutes ?? 30;
  f.utc_offset_minutes.value = bk.utc_offset_minutes ?? 0;
  f.payment_link.value = st.payment_link ?? '';
  f.notify_webhook.value = st.notify_webhook ?? '';
  $('#embed-code').textContent = [
    `<script type="module" src="${location.origin}/embed.js"></script>`,
    `<ai-form site="${current.slug}" form="contact"></ai-form>`,
    `<ai-newsletter site="${current.slug}"></ai-newsletter>`,
    `<ai-booking site="${current.slug}"></ai-booking>`,
    `<ai-shop site="${current.slug}"></ai-shop>`,
    `<ai-blog-feed site="${current.slug}" limit="5"></ai-blog-feed>`,
  ].join('\n');
  loadVersions();
}
async function loadVersions() {
  const r = await call('site_versions', { site: current.slug }).catch(() => ({ versions: [] }));
  $('#versions').innerHTML = r.versions.length
    ? r.versions.map((v) => row(`v${v.version} · ${v.files} files · ${(v.bytes / 1024).toFixed(0)} KB · ${when(v.created_at)}${v.note ? ` · ${esc(v.note)}` : ''}`, v.status === 'live' ? '<b>live</b>' : `<button class="btn small" data-rollback="${v.version}">Roll back</button>`)).join('')
    : '<p class="small">Nothing deployed yet.</p>';
  for (const b of $$('[data-rollback]')) b.onclick = () => confirm(`Make version ${b.dataset.rollback} live?`) && act('site-status', () => call('site_rollback', { site: current.slug, version: Number(b.dataset.rollback), confirm: true })).then(loadVersions);
}
$('#deploy').addEventListener('submit', async (e) => {
  e.preventDefault();
  const list = [...e.target.dir.files];
  if (!list.length) return;
  const strip = list[0].webkitRelativePath.split('/')[0] + '/';
  if (!confirm(`Deploy ${list.length} files to ${current.name} and make them live?`)) return;
  await act('site-status', async () => {
    let batch = [];
    let size = 0;
    let deploy;
    const send = async (finish) => {
      const r = await call('site_deploy', { site: current.slug, files: batch, deploy, finish, confirm: finish, note: e.target.note.value || undefined });
      deploy = r.deploy ?? deploy;
      batch = [];
      size = 0;
      return r;
    };
    for (const [i, file] of list.entries()) {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (let k = 0; k < buf.length; k += 0x8000) bin += String.fromCharCode(...buf.subarray(k, k + 0x8000));
      batch.push({ path: file.webkitRelativePath.replace(strip, ''), content: btoa(bin), encoding: 'base64' });
      size += buf.length;
      say('site-status', `Uploading ${i + 1}/${list.length}…`);
      if (size > 600_000 && i < list.length - 1) await send(false);
    }
    const r = await send(true);
    say('site-status', `Version ${r.version} is live.`);
    return r;
  }, 'Uploading…');
  loadVersions();
  loadSites();
});
$('#brand').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (await act('site-status', () => call('brand_read', { url: e.target.url.value, site: current.slug }), 'Reading brand…')) openSite(current.slug);
});
$('#domain').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = e.target.domain.value.trim();
  const r = await act('site-status', () => call('site_domain', { site: current.slug, domain: v || null }));
  if (r?.dns) $('#dns').textContent = `Add these DNS records:\n${r.dns.map((d) => `${d.type}  ${d.name}  ${d.value}`).join('\n')}\n\n${r.note}`;
});
$('#settings').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const settings = {
    bookings: { days: f.days.value.split(',').map(Number).filter((n) => n >= 0 && n <= 6), start: f.start.value, end: f.end.value, minutes: Number(f.minutes.value), utc_offset_minutes: Number(f.utc_offset_minutes.value) },
    ...(f.payment_link.value ? { payment_link: f.payment_link.value } : {}),
    ...(f.notify_webhook.value ? { notify_webhook: f.notify_webhook.value } : {}),
  };
  if (await act('site-status', () => call('site_settings', { site: current.slug, settings }))) say('site-status', 'Saved.');
});

// ---------------------------------------------------------------- blog
async function loadBlog() {
  if (!pick('blog-site')) return ($('#blog-list').innerHTML = '<p class="small">Create a site first.</p>');
  const r = await call('blog_list', { site: pick('blog-site') }).catch((e) => ({ posts: [], error: e.message }));
  $('#blog-list').innerHTML = r.posts.length
    ? r.posts.map((p) => row(`<b>${esc(p.title)}</b> <small>${p.status} · ${esc(p.lang)} · ${when(p.updated_at)}</small>${p.status === 'published' ? `<br><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url)}</a>` : ''}`, `<button class="btn small" data-edit="${p.id}">Edit</button><button class="btn small" data-del="${p.id}">Delete</button>`)).join('')
    : '<p class="small">No posts yet.</p>';
  for (const b of $$('[data-edit]')) b.onclick = () => editPost(b.dataset.edit);
  for (const b of $$('[data-del]')) b.onclick = () => confirm('Delete this post?') && call('blog_delete', { site: pick('blog-site'), id: b.dataset.del }).then(loadBlog);
}
$('#blog-write').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await act('blog-status', () => call('blog_write', { site: pick('blog-site'), topic: e.target.topic.value, lang: e.target.lang.value || 'en' }), 'Writing on c0mpute… this can take a minute or two.');
  if (r) {
    e.target.topic.value = '';
    await loadBlog();
    editPost(r.post.id);
    refreshBalance();
  }
});
async function editPost(id) {
  const { post } = await call('blog_get', { site: pick('blog-site'), id });
  const f = $('#blog-edit');
  f.hidden = false;
  f.id.value = post.id;
  f.title.value = post.title;
  f.summary.value = post.summary ?? '';
  f.body_md.value = post.body_md;
  f.status.value = post.status;
  f.scrollIntoView({ behavior: 'smooth' });
}
$('#blog-edit').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  if (await act('blog-status', () => call('blog_save', { site: pick('blog-site'), id: f.id.value, title: f.title.value, summary: f.summary.value || undefined, body_md: f.body_md.value, status: f.status.value }))) {
    say('blog-status', 'Saved.');
    loadBlog();
  }
});
$('#translate').onclick = async () => {
  const f = $('#blog-edit');
  if (!f.tlang.value) return f.tlang.focus();
  if (await act('blog-status', () => call('blog_translate', { site: pick('blog-site'), id: f.id.value, lang: f.tlang.value }), 'Translating on c0mpute…')) {
    loadBlog();
    refreshBalance();
  }
};

// ---------------------------------------------------------------- inbox
let inboxKind = '';
for (const b of $$('#inbox-tabs [role=tab]')) {
  b.onclick = () => {
    inboxKind = b.dataset.kind;
    for (const t of $$('#inbox-tabs [role=tab]')) t.setAttribute('aria-selected', String(t === b));
    loadInbox();
  };
}
async function loadInbox() {
  if (!pick('inbox-site')) return ($('#inbox-list').innerHTML = '<p class="small">Create a site first.</p>');
  const r = await call('inbox', { site: pick('inbox-site'), kind: inboxKind || undefined, mark_seen: true }).catch(() => ({ items: [] }));
  $('#inbox-list').innerHTML = r.items.length
    ? r.items.map((i) => row(`<b>${esc(i.kind)}</b>${i.ref ? ` · ${esc(i.ref)}` : ''} ${i.seen ? '' : '<span class="new">new</span>'} <small>${when(i.created_at)}</small><br>${Object.entries(i.data).map(([k, v]) => `<small>${esc(k)}:</small> ${esc(Array.isArray(v) ? v.join(', ') : v)}`).join('<br>')}`)).join('')
    : '<p class="small">Nothing here yet. Messages from your forms, bookings, newsletter sign-ups and orders land here.</p>';
}

// ---------------------------------------------------------------- shop
async function loadShop() {
  if (!pick('shop-site')) return;
  const [p, o] = await Promise.all([call('product_list', { site: pick('shop-site') }).catch(() => ({ products: [] })), call('order_list', { site: pick('shop-site') }).catch(() => ({ orders: [] }))]);
  $('#products').innerHTML = p.products.length ? p.products.map((x) => row(`<b>${esc(x.name)}</b> ${(x.price_cents / 100).toFixed(2)} ${esc(x.currency)}${x.category ? ` · ${esc(x.category)}` : ''}${x.variants.length ? ` · ${x.variants.map(esc).join(', ')}` : ''}`, `<button class="btn small" data-pdel="${x.id}">Remove</button>`)).join('') : '<p class="small">No products yet.</p>';
  for (const b of $$('[data-pdel]')) b.onclick = () => call('product_delete', { site: pick('shop-site'), id: b.dataset.pdel }).then(loadShop);
  $('#orders').innerHTML = o.orders.length
    ? o.orders.map((x) => row(`<b>${(x.total_cents / 100).toFixed(2)} ${esc(x.currency)}</b> · ${esc(x.name)} &lt;${esc(x.email)}&gt; · <i>${esc(x.status)}</i> <small>${when(x.created_at)}</small><br><small>${x.items.map((i) => `${i.qty}× ${esc(i.name)}${i.variant ? ` (${esc(i.variant)})` : ''}`).join(', ')}</small>`, ['paid', 'ready', 'shipped', 'done'].map((s) => `<button class="btn small" data-ord="${x.id}" data-st="${s}">${s}</button>`).join(''))).join('')
    : '<p class="small">No orders yet.</p>';
  for (const b of $$('[data-ord]')) b.onclick = () => call('order_update', { site: pick('shop-site'), id: b.dataset.ord, status: b.dataset.st }).then(loadShop);
}
$('#product').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  if (await act('shop-status', () => call('product_save', { site: pick('shop-site'), name: f.name.value, price: Number(f.price.value), category: f.category.value || undefined, variants: f.variants.value ? f.variants.value.split(',').map((s) => s.trim()).filter(Boolean) : undefined }))) {
    f.reset();
    loadShop();
  }
});

// ---------------------------------------------------------------- social
async function loadSocial() {
  const r = await call('social_list').catch(() => ({ posts: [] }));
  $('#social-list').innerHTML = r.posts.length
    ? r.posts.map((p) => row(`<b>${esc(p.platform)}</b> · <i>${esc(p.status)}</i> · ${when(p.at)}${p.result_url ? ` · <a href="${esc(p.result_url)}" target="_blank" rel="noopener">view</a>` : ''}${p.error ? `<br><small class="bad">${esc(p.error)}</small>` : ''}<br>${esc(p.text.slice(0, 280))}`, `${['scheduled', 'needs_desktop', 'failed'].includes(p.status) ? `<button class="btn small" data-cancel="${p.id}">To draft</button>` : ''}${p.status !== 'published' ? `<button class="btn small" data-now="${p.id}">Publish now</button>` : ''}`)).join('')
    : '<p class="small">Nothing scheduled.</p>';
  for (const b of $$('[data-cancel]')) b.onclick = () => call('social_cancel', { id: b.dataset.cancel }).then(loadSocial);
  for (const b of $$('[data-now]')) b.onclick = () => confirm('Publish this post now from your desktop?') && act('social-status', () => call('social_publish_now', { id: b.dataset.now, confirm: true })).then(loadSocial);
}
$('#schedule').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const r = await act('social-status', () => call('social_schedule', { posts: [{ platform: f.platform.value, text: f.text.value, at: f.at.value ? new Date(f.at.value).toISOString() : undefined, link: f.link.value || undefined }], draft: f.draft.checked }));
  if (r) {
    f.reset();
    if (r.warning) say('social-status', r.warning);
    loadSocial();
  }
});

// ---------------------------------------------------------------- ads, reels, capture
async function loadAds() {
  const [a, r] = await Promise.all([call('ad_list').catch(() => ({ ads: [] })), call('reel_status').catch(() => ({ reels: [] }))]);
  $('#ads-out').innerHTML = a.ads.map(adCard).join('') || '<p class="small">No ads yet.</p>';
  $('#reels').innerHTML = (r.reels ?? []).map((x) => row(`<b>${esc(x.status)}</b> · ${esc(x.url)} <small>${when(x.created_at)}</small>${x.video ? `<br><video src="${esc(x.video)}" controls preload="none" class="reelvid"></video>` : ''}${x.error ? `<br><small class="bad">${esc(x.error)}</small>` : ''}`)).join('') || '<p class="small">No reels yet.</p>';
}
$('#ad').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  if (await act('ads-status', () => call('ad_create', { site: pick('ads-site'), topic: f.topic.value || undefined, count: Number(f.count.value) || 1 }), 'Writing copy on c0mpute…')) {
    loadAds();
    refreshBalance();
  }
});
$('#reel').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  if (await act('ads-status', () => call('reel_create', { url: f.url.value || undefined, site: pick('ads-site'), style: f.style.value }), 'Starting the reel on c0mpute…')) {
    loadAds();
    refreshBalance();
  }
});
$('#capture').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const r = await act('capture-status', () => call('app_capture', { url: f.url.value, steps: f.steps.value ? f.steps.value.split(',').map((s) => s.trim()).filter(Boolean) : undefined }));
  if (r) say('capture-status', `Sent to ${r.desktop}${r.online ? '' : ' (offline: it runs when the desktop connects)'}. Frames show under Desktops.`);
});

// ---------------------------------------------------------------- desktops
let desktopTimer = null;
let wizard = null; // { token, name, id, os }
const COMMANDS = {
  unix: (t) => [
    ['Install the W3BS desktop layer (once)', 'curl -fsSL https://w3bs.org/desktop/install.sh | sh'],
    ['Let autoinfluencer drive it (once)', 'w3bs desktop agents add autoinfluencer --preset broad'],
    ['Start the agent browser', 'w3bs desktop browser launch'],
    ['Connect this computer (keep it running)', `npx -y @profullstack/autoinfluencer desktop connect --token ${t}`],
  ],
  win: (t) => [
    ['Install the W3BS desktop layer (once, PowerShell)', 'irm https://w3bs.org/desktop/install.ps1 | iex'],
    ['Let autoinfluencer drive it (once)', 'w3bs desktop agents add autoinfluencer --preset broad'],
    ['Start the agent browser', 'w3bs desktop browser launch'],
    ['Connect this computer (keep it running)', `npx -y @profullstack/autoinfluencer desktop connect --token ${t}`],
  ],
  app: (t) => [
    ['Install the W3BS desktop layer (once)', 'curl -fsSL https://w3bs.org/desktop/install.sh | sh'],
    ['Download the autoinfluencer desktop app', 'https://github.com/profullstack/autoinfluencer/releases/latest'],
    ['Copy this token, then in the app choose Agents → Connect this computer', t],
  ],
};

function copyBtn(text) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn small copy';
  b.textContent = 'Copy';
  b.onclick = async () => {
    await navigator.clipboard.writeText(text);
    b.textContent = 'Copied';
    setTimeout(() => (b.textContent = 'Copy'), 1500);
  };
  return b;
}

function renderCommands() {
  const box = $('#wizard-cmds');
  if (!wizard?.token) return;
  box.replaceChildren(
    ...COMMANDS[wizard.os](wizard.token).map(([label, cmd], i) => {
      const row = document.createElement('div');
      row.className = 'cmd';
      row.innerHTML = `<span class="n">${i + 1}</span><div><div class="small">${esc(label)}</div><code></code></div>`;
      row.querySelector('code').textContent = cmd;
      row.append(copyBtn(cmd));
      return row;
    }),
  );
}
for (const b of $$('.ostabs [role=tab]')) {
  b.onclick = () => {
    for (const t of $$('.ostabs [role=tab]')) t.setAttribute('aria-selected', String(t === b));
    if (wizard) wizard.os = b.dataset.os;
    renderCommands();
  };
}

function openWizard() {
  wizard = null;
  $('#desktop-wizard').hidden = false;
  $('#desktop-new').reset();
  $('#desktop-new [name=name]').disabled = false;
  $('#desktop-new button').disabled = false;
  for (const s of $$('.step')) s.setAttribute('aria-disabled', String(s.dataset.step !== '1'));
  $('#wizard-cmds').innerHTML = '<p class="small">Name the computer first.</p>';
  $('#wizard-status').className = 'waiting';
  $('#wizard-status').innerHTML = '<span class="dot"></span> Waiting for the computer to connect…';
  $('#desktop-new [name=name]').focus();
  $('#desktop-wizard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$('#desktop-start').onclick = openWizard;
$('#wizard-close').onclick = () => {
  $('#desktop-wizard').hidden = true;
  wizard = null;
};

$('#desktop-new').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = e.target.name.value.trim();
  if (!name) return;
  e.target.querySelector('button').disabled = true;
  try {
    const r = await call('desktop_add', { name });
    const os = /win/i.test(navigator.platform) ? 'win' : 'unix';
    wizard = { token: r.token, name, id: r.desktop.id, os };
    for (const t of $$('.ostabs [role=tab]')) t.setAttribute('aria-selected', String(t.dataset.os === os));
    e.target.name.disabled = true;
    for (const s of $$('.step')) s.setAttribute('aria-disabled', 'false');
    renderCommands();
    loadDesktops();
  } catch (err) {
    e.target.querySelector('button').disabled = false;
    alert(err.message);
  }
});

function health(d) {
  const i = d.info ?? {};
  if (!d.last_seen) return [['warn', 'Not connected yet: run the connect command on that computer']];
  const out = [];
  out.push(d.online ? ['ok', 'Connected'] : ['bad', `Offline since ${when(d.last_seen)}: start the connector again`]);
  if (d.last_seen) {
    out.push(i.broker ? ['ok', 'W3BS desktop layer found'] : ['bad', 'W3BS desktop layer not found: install it and run “w3bs desktop agents add autoinfluencer --preset broad”']);
    out.push(i.browser ? ['ok', 'Agent browser ready'] : ['warn', 'Agent browser not running: run “w3bs desktop browser launch”']);
  }
  return out;
}

async function loadDesktops() {
  const [d, j] = await Promise.all([call('desktop_list').catch(() => ({ desktops: [] })), call('desktop_jobs', { limit: 30 }).catch(() => ({ jobs: [] }))]);
  const list = $('#desktop-list');
  if (!d.desktops.length) {
    list.innerHTML = `<div class="empty"><p><b>No computer connected yet.</b></p><p class="small">Connect your laptop or any always-on machine. Posts you schedule are published from it, in a real browser, signed in as you.</p></div>`;
    if (!wizard && $('#desktop-wizard').hidden) openWizard();
  } else {
    list.innerHTML = d.desktops
      .map((x) => {
        const jobs = j.jobs.filter((y) => y.desktop_id === x.id).slice(0, 5);
        return `<article class="dcard ${x.online ? 'on' : ''}">
<header><span class="dot ${x.online ? 'on' : ''}"></span><b>${esc(x.name)}</b><span class="small">${x.info?.platform ? esc(`${x.info.hostname ?? ''} · ${x.info.platform}`) : ''}</span></header>
<ul class="checks">${health(x).map(([k, t]) => `<li class="${k}">${esc(t)}</li>`).join('')}</ul>
${jobs.length ? `<details><summary class="small">Recent jobs</summary><ul class="jobs">${jobs.map((y) => `<li><b>${esc(y.type)}</b> <i>${esc(y.status)}</i> <small>${when(y.created_at)}</small>${y.error ? `<br><small class="bad">${esc(y.error)}</small>` : ''}${y.result?.url ? ` <a href="${esc(y.result.url)}" target="_blank" rel="noopener">view</a>` : ''}${y.result?.frames?.length ? `<div class="frames">${y.result.frames.map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="frame" loading="lazy"></a>`).join('')}</div>` : ''}</li>`).join('')}</ul></details>` : ''}
<footer><button class="btn small" data-dtest="${x.id}" ${x.online ? '' : 'disabled'}>Send a test</button><button class="btn small" data-drm="${x.id}">Remove</button></footer>
</article>`;
      })
      .join('');
  }
  for (const b of $$('[data-drm]')) b.onclick = () => confirm('Remove this computer? Its token stops working at once.') && call('desktop_remove', { id: b.dataset.drm }).then(loadDesktops);
  for (const b of $$('[data-dtest]')) {
    b.onclick = async () => {
      b.disabled = true;
      try {
        await call('desktop_open', { url: 'https://w3bs.org/desktop', desktop: b.dataset.dtest });
        b.textContent = 'Sent: watch that screen';
      } catch (err) {
        alert(err.message);
        b.disabled = false;
      }
    };
  }
  if (wizard) {
    const mine = d.desktops.find((x) => x.id === wizard.id);
    if (mine?.online) {
      const ok = mine.info?.broker && mine.info?.browser;
      $('#wizard-status').className = ok ? 'connected' : 'partial';
      $('#wizard-status').innerHTML = ok
        ? `<span class="dot on"></span> <b>${esc(mine.name)} is connected.</b> Scheduled posts will publish from it.`
        : `<span class="dot on"></span> <b>${esc(mine.name)} is connected</b>, but ${mine.info?.broker ? 'the agent browser is not running (step 3)' : 'the W3BS desktop layer is missing (steps 1 to 3)'}.`;
    }
  }
}

function pollDesktops(on) {
  clearInterval(desktopTimer);
  desktopTimer = on ? setInterval(loadDesktops, 4000) : null;
}

// ---------------------------------------------------------------- plan and team
async function loadPlan() {
  refreshBalance();
  const t = await call('team_list').catch(() => null);
  if (!t) return;
  $('#team').innerHTML = row(`<b>${esc(t.owner.name || 'You')}</b> (owner)`) + t.members.map((m) => row(`${esc(m.name || m.email || m.account_id)}`, `<button class="btn small" data-mrm="${m.account_id}">Remove</button>`)).join('') + `<p class="small">${t.members.length + 1} of ${t.seats} seats</p>`;
  for (const b of $$('[data-mrm]')) b.onclick = () => call('team_remove', { account_id: b.dataset.mrm }).then(loadPlan);
}
$('#invite').onclick = async () => {
  const r = await act('team-status', () => call('team_invite'));
  if (r) say('team-status', `Send this link (valid ${r.expires_in_days} days): ${r.link}`);
};

// ---------------------------------------------------------------- write posts (persona + generation tools)
function checkboxes(container, name, checked) {
  container.replaceChildren(
    ...PLATFORMS.map((p) => {
      const l = document.createElement('label');
      l.className = 'chip';
      l.innerHTML = `<input type="checkbox" name="${name}" value="${p}"> ${p}`;
      l.querySelector('input').checked = checked.includes(p);
      return l;
    }),
  );
}
function fillPersona(p) {
  const f = $('#persona');
  const v = p ?? {};
  for (const k of ['name', 'handle', 'niche', 'audience', 'voice', 'cta', 'disclosure']) if (v[k] != null) f[k].value = v[k];
  f.pillars.value = (v.pillars ?? []).join('\n');
  f.avoid.value = (v.avoid ?? []).join(', ');
  f.disclose.checked = v.disclose !== false;
  const plats = v.platforms ?? ['bluesky', 'mastodon', 'linkedin', 'x'];
  checkboxes($('#platforms'), 'platforms', plats);
  checkboxes($('#targets'), 'targets', plats.slice(0, 3));
}
$('#persona').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const p = {
    name: f.name.value, handle: f.handle.value, niche: f.niche.value, audience: f.audience.value, voice: f.voice.value,
    pillars: f.pillars.value.split('\n').map((s) => s.trim()).filter(Boolean),
    platforms: $$('input[name=platforms]:checked').map((i) => i.value),
    avoid: f.avoid.value.split(',').map((s) => s.trim()).filter(Boolean),
    cta: f.cta.value, disclose: f.disclose.checked, disclosure: f.disclosure.value,
  };
  const r = await api('/api/v1/persona', { method: 'PUT', body: p });
  $('#persona-status').textContent = r.status === 200 ? 'Saved.' : r.data.error;
  if (r.status === 200) persona = r.data.persona;
});
for (const b of $$('.work [role=tab]')) {
  b.onclick = () => {
    tool = b.dataset.tool;
    for (const t of $$('.work [role=tab]')) t.setAttribute('aria-selected', String(t === b));
    for (const d of $$('#run [data-for]')) d.hidden = !d.dataset.for.split(' ').includes(tool);
    $('#go').textContent = tool === 'lint' ? 'Check' : tool === 'calendar' ? 'Plan' : 'Write';
  };
}
$('#run').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const targets = $$('input[name=targets]:checked').map((i) => i.value);
  const mode = f.brief.checked ? 'brief' : 'auto';
  const args = {
    draft: { topic: f.topic.value, link: f.link.value || undefined, platforms: targets, mode },
    repurpose: { url: f.url.value || undefined, text: f.text.value || undefined, platforms: targets, mode },
    reply: { post: f.post.value, goal: f.goal.value || undefined, platform: targets[0], mode },
    ideas: { topic: f.itopic.value || undefined, count: Number(f.count.value) || 10, mode },
    calendar: { days: Number(f.days.value) || 7, withIdeas: f.withIdeas.checked, mode },
    lint: { posts: targets.map((platform) => ({ platform, text: f.ltext.value })) },
  }[tool];
  $('#go').disabled = true;
  try {
    const result = await act('run-status', () => call(tool, args), 'Working… writing on c0mpute can take a minute.');
    if (result) render(result);
    refreshBalance();
  } finally {
    $('#go').disabled = false;
  }
});
function render(res) {
  const out = $('#out');
  out.replaceChildren();
  if (res.mode === 'brief') return out.append(block('Brief', res.brief, res.note));
  if (res.posts) for (const p of res.posts) out.append(postCard(p));
  else if (res.platform && res.text) out.append(postCard(res));
  else if (res.ideas) out.append(list(res.ideas.map((i) => `<b>${esc(i.hook)}</b><br><small>${esc(i.pillar ?? '')} · ${esc(i.format ?? '')} · ${esc(i.angle ?? '')}</small>`)));
  else if (res.slots) out.append(list(res.slots.map((s) => `<code>${s.at.slice(0, 16).replace('T', ' ')}</code> ${s.platform} · <b>${s.kind}</b> · ${esc(s.idea?.hook ?? s.pillar ?? s.task)}`)));
  else if (res.results) for (const r of res.results) out.append(lintCard(r.platform, r));
  else out.append(block('Result', JSON.stringify(res, null, 2)));
}
function postCard(p) {
  const el = document.createElement('article');
  el.className = 'post';
  const text = p.thread ? p.thread.join('\n\n') : p.text;
  el.innerHTML = `<header><b>${esc(p.platform)}</b>${p.title ? ` · ${esc(p.title)}` : ''}<span class="len">${p.lint?.length ?? ''}/${p.lint?.limit ?? ''}</span><button class="btn small" data-c>Copy</button><button class="btn small" data-s>Schedule</button></header><pre></pre>`;
  el.querySelector('pre').textContent = text;
  el.querySelector('[data-c]').onclick = () => navigator.clipboard.writeText(text);
  el.querySelector('[data-s]').onclick = async () => {
    try {
      await call('social_schedule', { posts: [{ platform: NETWORKS.includes(p.platform) ? p.platform : 'bluesky', text, title: p.title }], draft: true });
      el.querySelector('[data-s]').textContent = 'Saved as draft';
    } catch (err) {
      alert(err.message);
    }
  };
  if (p.lint) el.append(lintList(p.lint));
  return el;
}
function lintCard(platform, r) {
  const el = document.createElement('article');
  el.className = 'post';
  el.innerHTML = `<header><b>${esc(platform)}</b> ${r.ok ? '✓ ready' : '✗ needs work'}<span class="len">${r.length}/${r.limit}</span></header>`;
  el.append(lintList(r));
  return el;
}
function lintList(l) {
  const ul = document.createElement('ul');
  ul.className = 'lint';
  for (const e of l.errors) ul.insertAdjacentHTML('beforeend', `<li class="err">${esc(e)}</li>`);
  for (const w of l.warnings) ul.insertAdjacentHTML('beforeend', `<li class="warn">${esc(w)}</li>`);
  return ul;
}
function block(title, text, note) {
  const el = document.createElement('article');
  el.className = 'post';
  el.innerHTML = `<header><b>${title}</b><button class="btn small">Copy</button></header>${note ? `<p class="note">${esc(note)}</p>` : ''}<pre></pre>`;
  el.querySelector('pre').textContent = text;
  el.querySelector('button').onclick = () => navigator.clipboard.writeText(text);
  return el;
}
function list(items) {
  const ol = document.createElement('ol');
  ol.className = 'items';
  ol.innerHTML = items.map((i) => `<li>${i}</li>`).join('');
  return ol;
}

boot();
