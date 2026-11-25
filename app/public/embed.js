// autoinfluencer drop-in components for any page:
//   <script type="module" src="https://influencer.marketing.pit.world/embed.js"></script>
//   <ai-form site="slug" form="contact"></ai-form>
//   <ai-newsletter site="slug"></ai-newsletter>
//   <ai-booking site="slug"></ai-booking>
//   <ai-shop site="slug"></ai-shop>
//   <ai-blog-feed site="slug" limit="5"></ai-blog-feed>
// Messages, sign-ups, bookings and orders land in the site's inbox (app, CLI, TUI, MCP).
const ORIGIN = new URL(import.meta.url).origin;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const CSS = `:host{display:block;font:inherit;color:inherit;margin:1rem 0}
form{display:grid;gap:.6rem;max-width:32rem}label{display:grid;gap:.25rem;font-size:.95em}
input,textarea,select{font:inherit;color:inherit;background:transparent;border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:8px;padding:.5rem .6rem}
button{font:inherit;font-weight:600;cursor:pointer;border:0;border-radius:8px;padding:.55rem 1rem;background:var(--ai-accent,currentColor);color:var(--ai-accent-fg,Canvas)}
button[disabled]{opacity:.6}.msg{min-height:1.2em;font-size:.95em}.msg.bad{color:#c22}.hp{position:absolute;left:-9999px}
.slots{display:flex;flex-wrap:wrap;gap:.35rem}.slots button{background:transparent;color:inherit;border:1px solid color-mix(in srgb,currentColor 25%,transparent);font-weight:400;padding:.3rem .6rem}
.slots button[aria-pressed=true]{border-color:currentColor;font-weight:700}.items{display:grid;gap:.6rem}.item{display:flex;gap:.6rem;align-items:center;justify-content:space-between;border-bottom:1px solid color-mix(in srgb,currentColor 15%,transparent);padding:.4rem 0}
ul{padding-left:1.1rem}li{margin:.3rem 0}small{opacity:.7}`;

async function api(site, path, body) {
  const r = await fetch(`${ORIGIN}/api/v1/public/${encodeURIComponent(site)}/${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `error ${r.status}`);
  return j;
}

class Base extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    this.attachShadow({ mode: 'open' }).innerHTML = `<style>${CSS}</style><div part="body">Loading…</div>`;
    this.body = this.shadowRoot.querySelector('div');
    this.site = this.getAttribute('site');
    this.start().catch((e) => (this.body.textContent = e.message));
  }
  msg(text, bad = false) {
    const m = this.shadowRoot.querySelector('.msg');
    if (m) {
      m.textContent = text;
      m.classList.toggle('bad', bad);
    }
  }
}

customElements.define('ai-form', class extends Base {
  async start() {
    const { form } = await api(this.site, `form/${this.getAttribute('form') || 'contact'}`);
    const field = (f) => {
      const req = f.required ? ' required' : '';
      if (f.type === 'textarea') return `<label>${esc(f.label)}<textarea name="${esc(f.name)}" rows="4"${req}></textarea></label>`;
      if (f.type === 'select') return `<label>${esc(f.label)}<select name="${esc(f.name)}"${req}>${(f.options ?? []).map((o) => `<option>${esc(o)}</option>`).join('')}</select></label>`;
      if (f.type === 'checkbox') return `<label><span><input type="checkbox" name="${esc(f.name)}"${req}> ${esc(f.label)}</span></label>`;
      return `<label>${esc(f.label)}<input type="${esc(f.type || 'text')}" name="${esc(f.name)}"${req}></label>`;
    };
    this.body.innerHTML = `<form>${form.fields.map(field).join('')}<input class="hp" name="_hp" tabindex="-1" autocomplete="off" aria-hidden="true"><button>${esc(this.getAttribute('button') || 'Send')}</button><p class="msg" role="status"></p></form>`;
    const el = this.body.querySelector('form');
    el.onsubmit = async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(el));
      el.querySelector('button').disabled = true;
      try {
        const r = await api(this.site, `form/${form.slug}`, data);
        el.reset();
        this.msg(r.message);
      } catch (err) {
        this.msg(err.message, true);
      } finally {
        el.querySelector('button').disabled = false;
      }
    };
  }
});

customElements.define('ai-newsletter', class extends Base {
  async start() {
    this.body.innerHTML = `<form><label>${esc(this.getAttribute('label') || 'Get new posts by email')}<input type="email" name="email" required placeholder="you@example.com"></label><input class="hp" name="_hp" tabindex="-1" autocomplete="off" aria-hidden="true"><button>Subscribe</button><p class="msg" role="status"></p></form>`;
    const el = this.body.querySelector('form');
    el.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const r = await api(this.site, 'subscribe', Object.fromEntries(new FormData(el)));
        el.reset();
        this.msg(r.message);
      } catch (err) {
        this.msg(err.message, true);
      }
    };
  }
});

customElements.define('ai-booking', class extends Base {
  async start() {
    const s = await api(this.site, `slots?days=${Number(this.getAttribute('days')) || 7}`);
    if (!s.slots.length) return (this.body.textContent = 'No free times this week.');
    const fmt = (iso) => new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    this.body.innerHTML = `<form><div class="slots" role="group" aria-label="Times">${s.slots.slice(0, 60).map((t) => `<button type="button" data-t="${t}" aria-pressed="false">${esc(fmt(t))}</button>`).join('')}</div>
<small>${s.minutes} minutes · times in your local time</small>
<label>Name<input name="name" required></label><label>Email<input type="email" name="email" required></label><label>Note<textarea name="note" rows="2"></textarea></label>
<input class="hp" name="_hp" tabindex="-1" autocomplete="off" aria-hidden="true"><button>Book</button><p class="msg" role="status"></p></form>`;
    const el = this.body.querySelector('form');
    let chosen = null;
    for (const b of el.querySelectorAll('[data-t]')) {
      b.onclick = () => {
        chosen = b.dataset.t;
        for (const x of el.querySelectorAll('[data-t]')) x.setAttribute('aria-pressed', String(x === b));
      };
    }
    el.onsubmit = async (e) => {
      e.preventDefault();
      if (!chosen) return this.msg('Pick a time first.', true);
      try {
        const r = await api(this.site, 'book', { ...Object.fromEntries(new FormData(el)), start: chosen });
        el.reset();
        this.msg(r.message);
      } catch (err) {
        this.msg(err.message, true);
      }
    };
  }
});

customElements.define('ai-shop', class extends Base {
  async start() {
    const { products } = await api(this.site, 'products');
    if (!products.length) return (this.body.textContent = 'Nothing for sale yet.');
    const money = (c, cur) => new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(c / 100);
    this.body.innerHTML = `<form><div class="items">${products
      .map((p) => `<div class="item"><span><b>${esc(p.name)}</b> ${money(p.price_cents, p.currency)}${p.description ? `<br><small>${esc(p.description)}</small>` : ''}</span><span>${p.variants.length ? `<select data-v="${esc(p.id)}">${p.variants.map((v) => `<option>${esc(v)}</option>`).join('')}</select>` : ''}<input type="number" min="0" max="99" value="0" data-q="${esc(p.id)}" style="width:4.5rem" aria-label="Quantity of ${esc(p.name)}"></span></div>`)
      .join('')}</div>
<label>Name<input name="name" required></label><label>Email<input type="email" name="email" required></label><label>Note<textarea name="note" rows="2"></textarea></label>
<input class="hp" name="_hp" tabindex="-1" autocomplete="off" aria-hidden="true"><button>Place order</button><p class="msg" role="status"></p></form>`;
    const el = this.body.querySelector('form');
    el.onsubmit = async (e) => {
      e.preventDefault();
      const items = [...el.querySelectorAll('[data-q]')].filter((i) => Number(i.value) > 0).map((i) => ({ id: i.dataset.q, qty: Number(i.value), variant: el.querySelector(`[data-v="${i.dataset.q}"]`)?.value }));
      if (!items.length) return this.msg('Choose at least one item.', true);
      try {
        const r = await api(this.site, 'order', { ...Object.fromEntries(new FormData(el)), items });
        el.reset();
        this.msg(r.message);
        if (r.pay_url) window.open(r.pay_url, '_blank', 'noopener');
      } catch (err) {
        this.msg(err.message, true);
      }
    };
  }
});

customElements.define('ai-blog-feed', class extends Base {
  async start() {
    const { posts } = await api(this.site, `posts?limit=${Number(this.getAttribute('limit')) || 5}`);
    this.body.innerHTML = posts.length ? `<ul>${posts.map((p) => `<li><a href="${esc(p.url)}">${esc(p.title)}</a> <small>${esc(p.published_at.slice(0, 10))}</small></li>`).join('')}</ul>` : '<small>No posts yet.</small>';
  }
});
