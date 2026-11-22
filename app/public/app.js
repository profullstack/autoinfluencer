const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const PLATFORMS = ['x', 'bluesky', 'mastodon', 'threads', 'linkedin', 'reddit', 'hackernews', 'instagram', 'tiktok', 'youtube', 'facebook', 'telegram', 'newsletter'];
let tool = 'draft';
let persona = null;

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

async function boot() {
  const me = await api('/api/v1/me');
  if (me.status !== 200) {
    $('#hero').hidden = false;
    return;
  }
  $('#app').hidden = false;
  $('#who').innerHTML = `${esc(me.data.user.name || me.data.user.email || 'signed in')} · <a href="#" id="logout">sign out</a>`;
  $('#logout').onclick = async (e) => {
    e.preventDefault();
    await api('/api/v1/logout', { method: 'POST' });
    location.reload();
  };
  showBalance(me.data);
  persona = me.data.persona;
  fillPersona(persona);
}

function showBalance(d) {
  $('#balance').textContent = `${d.credits ?? 0} credits · ${d.free_left ?? 0} free generations left today`;
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

for (const b of $$('[role=tab]')) {
  b.onclick = () => {
    tool = b.dataset.tool;
    for (const t of $$('[role=tab]')) t.setAttribute('aria-selected', String(t === b));
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
  status('Working… generation on c0mpute can take a minute.');
  try {
    let r = await api(`/api/${tool}`, { method: 'POST', body: args });
    while (r.status === 202 || r.data?.job?.status === 'running') {
      const id = r.data.job.id;
      await new Promise((ok) => setTimeout(ok, 3000));
      r = await api('/api/job_status', { method: 'POST', body: { id } });
    }
    if (r.status === 402) return status(r.data.error ?? 'Out of credits: buy a pack below.');
    if (r.status !== 200) return status(r.data.error ?? `error ${r.status}`);
    const result = r.data.job?.result ?? r.data;
    status('');
    render(result);
    const me = await api('/api/v1/me');
    if (me.status === 200) showBalance(me.data);
  } finally {
    $('#go').disabled = false;
  }
});

function status(s) {
  $('#run-status').textContent = s;
}

function render(res) {
  const out = $('#out');
  out.replaceChildren();
  if (res.mode === 'brief') {
    out.append(block('Brief', res.brief, res.note));
    return;
  }
  if (res.posts) for (const p of res.posts) out.append(postCard(p));
  else if (res.platform && res.text) out.append(postCard(res));
  else if (res.ideas) out.append(list(res.ideas.map((i) => `<b>${esc(i.hook)}</b><br><small>${esc(i.pillar ?? '')} · ${esc(i.format ?? '')} — ${esc(i.angle ?? '')}</small>`)));
  else if (res.slots) out.append(list(res.slots.map((s) => `<code>${s.at.slice(0, 16).replace('T', ' ')}</code> ${s.platform} · <b>${s.kind}</b> — ${esc(s.idea?.hook ?? s.pillar ?? s.task)}`)));
  else if (res.results) for (const r of res.results) out.append(lintCard(r.platform, r));
  else out.append(block('Result', JSON.stringify(res, null, 2)));
}

function postCard(p) {
  const el = document.createElement('article');
  el.className = 'post';
  const text = p.thread ? p.thread.join('\n\n') : p.text;
  el.innerHTML = `<header><b>${esc(p.platform)}</b>${p.title ? ` · ${esc(p.title)}` : ''}<span class="len">${p.lint?.length ?? ''}/${p.lint?.limit ?? ''}</span><button class="btn small">Copy</button></header><pre></pre>`;
  el.querySelector('pre').textContent = text;
  el.querySelector('button').onclick = () => navigator.clipboard.writeText(text);
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
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

boot();
