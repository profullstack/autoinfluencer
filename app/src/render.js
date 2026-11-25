// Server-side rendering: safe Markdown, blog pages and feed, static ads as SVG, the pricing
// page, the badge on Free sites, and the brand kit read from a website.
import { COSTS, PLANS, TOPUPS, creditsIn } from './plans.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeUrl = (u) => {
  const s = String(u ?? '').trim();
  return /^(https?:|mailto:|\/|#|\.\/)/i.test(s) && !/^\/\//.test(s) ? s : '#';
};

// ------------------------------------------------------------------ markdown
function inline(text) {
  let s = esc(text);
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, u) => `<img src="${esc(safeUrl(u))}" alt="${alt}" loading="lazy">`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${esc(safeUrl(u))}">${t}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

/** Markdown to HTML. Raw HTML in the source is escaped, never passed through. */
export function markdown(md) {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`);
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(l) || /^\s*\d+[.)]\s+/.test(l)) {
      const ordered = /^\s*\d/.test(l);
      const items = [];
      while (i < lines.length && (ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/).test(lines[i])) items.push(lines[i++].replace(/^\s*(?:[-*]|\d+[.)])\s+/, ''));
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    if (/^>\s?/.test(l)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
      continue;
    }
    if (!l.trim()) {
      i++;
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|>|\s*[-*]\s|\s*\d+[.)]\s)/.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return out.join('\n');
}

export const slugify = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'post';

// ------------------------------------------------------------------ brand
export const DEFAULT_BRAND = { name: 'Your brand', colors: { bg: '#111111', fg: '#ffffff', accent: '#e0307f' }, font: 'system-ui', logo: null, tagline: '' };

export function brandOf(site, persona) {
  const b = site?.brand ?? {};
  return {
    ...DEFAULT_BRAND,
    name: b.name || site?.name || persona?.name || DEFAULT_BRAND.name,
    ...b,
    colors: { ...DEFAULT_BRAND.colors, ...(b.colors ?? {}) },
  };
}

const HEX = /#(?:[0-9a-f]{3}){1,2}\b/gi;
const luminance = (hex) => {
  const h = hex.length === 4 ? hex.replace(/#(.)(.)(.)/, '#$1$1$2$2$3$3') : hex;
  const [r, g, b] = [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const norm = (hex) => (hex.length === 4 ? hex.replace(/#(.)(.)(.)/, '#$1$1$2$2$3$3') : hex).toLowerCase();

/** Read a brand kit (name, colours, font, logo, tagline) from a page's HTML and CSS. */
export function extractBrand(html, pageUrl, css = '') {
  const meta = (name) => html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']+)`, 'i'))?.[1] ?? html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:name|property)=["']${name}["']`, 'i'))?.[1];
  const title = (meta('og:site_name') || html.match(/<title[^>]*>([^<]+)/i)?.[1] || new URL(pageUrl).hostname).trim().split(/\s[|\-–·]\s/)[0].slice(0, 60);
  const tagline = (meta('description') || meta('og:description') || '').trim().slice(0, 160);
  const theme = meta('theme-color');
  const counts = new Map();
  for (const m of `${html}\n${css}`.matchAll(HEX)) {
    const c = norm(m[0]);
    if (c === '#ffffff' || c === '#000000') continue;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const saturated = ranked.filter((c) => {
    const [r, g, b] = [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16));
    return Math.max(r, g, b) - Math.min(r, g, b) > 60;
  });
  const accent = theme && /^#[0-9a-f]{3,6}$/i.test(theme) && saturated.length === 0 ? norm(theme) : saturated[0] ?? (theme && /^#/.test(theme) ? norm(theme) : DEFAULT_BRAND.colors.accent);
  const darks = ranked.filter((c) => luminance(c) < 0.06);
  const bg = darks[0] ?? '#111111';
  const fg = luminance(bg) > 0.4 ? '#111111' : '#ffffff';
  const font = (`${css}\n${html}`.match(/font-family:\s*["']?([A-Za-z0-9 \-]+)["']?/i)?.[1] ?? 'system-ui').trim();
  const icon = html.match(/<link[^>]+rel=["'](?:apple-touch-icon|icon)["'][^>]*href=["']([^"']+)/i)?.[1] || meta('og:image');
  let logo = null;
  try {
    logo = icon ? new URL(icon, pageUrl).href : null;
  } catch {
    /* bad href */
  }
  const stylesheets = [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)/gi)].map((m) => m[1]).slice(0, 2);
  return { name: title, tagline, colors: { bg, fg, accent }, font, logo, source: pageUrl, stylesheets };
}

// ------------------------------------------------------------------ ads
export const AD_FORMATS = { '1:1': [1080, 1080], '4:5': [1080, 1350], '9:16': [1080, 1920] };

function wrap(text, size, width) {
  const per = Math.max(6, Math.floor(width / (size * 0.56)));
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > per && cur) {
      lines.push(cur);
      cur = w;
    } else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  return lines;
}

/** One static ad as SVG. `logoData` is a data: URI (external images do not load inside an SVG <img>). */
export function adSvg({ copy, brand, watermark }, format = '1:1', logoData = null) {
  const [W, H] = AD_FORMATS[format] ?? AD_FORMATS['1:1'];
  const { bg, fg, accent } = brand.colors;
  const pad = 96;
  const hSize = format === '9:16' ? 104 : 92;
  const head = wrap(copy.headline, hSize, W - pad * 2).slice(0, 5);
  const sub = wrap(copy.sub, 44, W - pad * 2).slice(0, 4);
  const top = format === '9:16' ? 520 : format === '4:5' ? 360 : 300;
  const font = esc(`${brand.font || 'system-ui'}, system-ui, -apple-system, Segoe UI, sans-serif`);
  let y = top;
  const headSvg = head.map((l) => `<tspan x="${pad}" y="${(y += hSize * 1.08)}">${esc(l)}</tspan>`).join('');
  y += 40;
  const subSvg = sub.map((l) => `<tspan x="${pad}" y="${(y += 58)}">${esc(l)}</tspan>`).join('');
  const ctaW = Math.min(W - pad * 2, 80 + String(copy.cta ?? '').length * 26);
  const ctaY = H - pad - 120;
  const wm = watermark
    ? `<g opacity=".28" transform="rotate(-28 ${W / 2} ${H / 2})"><text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="86" font-weight="800" fill="${esc(fg)}">PREVIEW · autoinfluencer</text></g>`
    : '';
  const logo = logoData ? `<image href="${esc(logoData)}" x="${pad}" y="${pad}" width="120" height="120" preserveAspectRatio="xMinYMin meet"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${font}">
<rect width="100%" height="100%" fill="${esc(bg)}"/>
<circle cx="${W - 60}" cy="${H * 0.18}" r="${W * 0.38}" fill="${esc(accent)}" opacity=".22"/>
<rect x="${pad}" y="${top}" width="140" height="14" rx="7" fill="${esc(accent)}"/>
${logo}
<text x="${logo ? pad + 150 : pad}" y="${pad + 74}" font-size="46" font-weight="700" fill="${esc(fg)}">${esc(brand.name)}</text>
<text font-size="${hSize}" font-weight="800" fill="${esc(fg)}">${headSvg}</text>
<text font-size="44" fill="${esc(fg)}" opacity=".86">${subSvg}</text>
<rect x="${pad}" y="${ctaY}" width="${ctaW}" height="104" rx="52" fill="${esc(accent)}"/>
<text x="${pad + ctaW / 2}" y="${ctaY + 66}" text-anchor="middle" font-size="42" font-weight="700" fill="${luminance(norm(accent)) > 0.45 ? '#111111' : '#ffffff'}">${esc(copy.cta)}</text>
${wm}
</svg>`;
}

/** Ad copy from the page itself, no model: the free preview. */
export function templateCopy(brand, n = 0) {
  const tag = brand.tagline || `${brand.name}, made for people who care about the details.`;
  const first = tag.split(/(?<=[.!?])\s/)[0].slice(0, 90);
  const variants = [
    { headline: first, sub: `${brand.name}. See what it does for you.`, cta: 'Learn more' },
    { headline: `Meet ${brand.name}`, sub: first, cta: 'Try it today' },
    { headline: `Why people pick ${brand.name}`, sub: tag.slice(0, 140), cta: 'Get started' },
  ];
  return variants[n % variants.length];
}

// ------------------------------------------------------------------ site pages
const BADGE = (publicUrl) =>
  `<a href="${esc(publicUrl)}/?ref=badge" target="_blank" rel="noopener" style="position:fixed;right:12px;bottom:12px;z-index:2147483647;font:600 12px/1 system-ui,sans-serif;background:#111;color:#fff;padding:8px 10px;border-radius:999px;text-decoration:none;box-shadow:0 2px 8px rgba(0,0,0,.25)">Built with autoinfluencer</a>`;

/** Free sites carry the badge: injected before </body> of every served HTML page. */
export function withBadge(html, publicUrl) {
  const b = BADGE(publicUrl);
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${b}</body>`) : html + b;
}

function shell({ site, brand, title, description, body, base, publicUrl }) {
  const { bg, fg, accent } = brand.colors;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(description ?? '')}">
<link rel="alternate" type="application/rss+xml" href="${base}/feed.xml" title="${esc(site.name)}">
<style>
:root{--bg:${esc(fg === '#ffffff' ? '#fbfaf8' : bg)};--fg:#161616;--accent:${esc(accent)};--muted:#666;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#101012;--fg:#ececec;--muted:#9a9a9a}}
body{margin:0;background:var(--bg);color:var(--fg);font:18px/1.65 ${esc(brand.font || 'system-ui')},system-ui,sans-serif}
header,main,footer{max-width:44rem;margin:0 auto;padding:1.2rem}
header a{color:inherit;text-decoration:none;font-weight:700} a{color:var(--accent)}
h1{line-height:1.15;font-size:clamp(1.8rem,1.2rem + 2vw,2.6rem)} img{max-width:100%;height:auto}
pre{overflow:auto;padding:1rem;background:rgba(127,127,127,.12);border-radius:10px} .meta,.muted{color:var(--muted);font-size:.9rem}
ul.posts{list-style:none;padding:0} ul.posts li{margin:0 0 1.4rem} ul.posts a{font-size:1.2rem;font-weight:650;text-decoration:none}
blockquote{border-left:4px solid var(--accent);margin:0;padding:.2rem 1rem;color:var(--muted)}
</style></head><body>
<header><a href="${base}/">${esc(brand.name)}</a> · <a href="${base}/blog/">Blog</a></header>
<main>${body}</main>
<footer class="muted"><ai-newsletter site="${esc(site.slug)}"></ai-newsletter><p><a href="${base}/feed.xml">RSS</a></p></footer>
<script type="module" src="${esc(publicUrl)}/embed.js"></script>
</body></html>`;
}

export function blogIndexPage({ site, brand, posts, base, publicUrl, lang }) {
  const list = posts.length
    ? `<ul class="posts">${posts.map((p) => `<li><a href="${base}/blog/${esc(p.slug)}${p.lang !== 'en' ? `?lang=${esc(p.lang)}` : ''}">${esc(p.title)}</a><div class="meta">${new Date(p.published_at).toISOString().slice(0, 10)}${p.lang !== 'en' ? ` · ${esc(p.lang)}` : ''}</div>${p.summary ? `<div>${esc(p.summary)}</div>` : ''}</li>`).join('')}</ul>`
    : '<p class="muted">No posts yet.</p>';
  return shell({ site, brand, title: `Blog · ${brand.name}`, description: brand.tagline, body: `<h1>Blog${lang && lang !== 'en' ? ` (${esc(lang)})` : ''}</h1>${list}`, base, publicUrl });
}

export function blogPostPage({ site, brand, post, base, publicUrl, others = [] }) {
  const langs = others.length ? `<p class="meta">Also in: ${others.map((o) => `<a href="${base}/blog/${esc(o.slug)}?lang=${esc(o.lang)}">${esc(o.lang)}</a>`).join(' · ')}</p>` : '';
  const body = `<article><h1>${esc(post.title)}</h1><p class="meta">${new Date(post.published_at ?? post.updated_at).toISOString().slice(0, 10)}</p>${langs}${markdown(post.body_md)}</article>`;
  return shell({ site, brand, title: `${post.title} · ${brand.name}`, description: post.summary, body, base, publicUrl });
}

export function feedXml({ site, brand, posts, base }) {
  const items = posts
    .slice(0, 30)
    .map((p) => `<item><title>${esc(p.title)}</title><link>${base}/blog/${esc(p.slug)}</link><guid isPermaLink="false">${esc(p.id)}</guid><pubDate>${new Date(p.published_at).toUTCString()}</pubDate>${p.summary ? `<description>${esc(p.summary)}</description>` : ''}</item>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${esc(brand.name)}</title><link>${base}/</link><description>${esc(brand.tagline || site.name)}</description>${items}</channel></rss>`;
}

/** A site with no deploy yet: a simple home page from the brand kit, blog and newsletter. */
export function starterHome({ site, brand, posts, base, publicUrl }) {
  const body = `<h1>${esc(brand.name)}</h1>${brand.tagline ? `<p>${esc(brand.tagline)}</p>` : ''}
<p class="muted">This site is new. Deploy your own pages with <code>autoinfluencer site deploy ./dist --site ${esc(site.slug)}</code>, or ask your AI assistant.</p>
${posts.length ? `<h2>Latest</h2><ul class="posts">${posts.slice(0, 5).map((p) => `<li><a href="${base}/blog/${esc(p.slug)}">${esc(p.title)}</a></li>`).join('')}</ul>` : ''}
<ai-form site="${esc(site.slug)}" form="contact"></ai-form>`;
  return shell({ site, brand, title: brand.name, description: brand.tagline, body, base, publicUrl });
}

// ------------------------------------------------------------------ pricing page
export function pricingPage({ footers = '', who = '' } = {}) {
  const card = (p) => {
    const price = p.contact ? `<span class="amt">From $${p.usd.month}</span><span class="per">/mo + $${p.perClientUsd} per client site</span>` : `<span class="amt">$${p.usd.month}</span><span class="per">/mo</span>`;
    const year = p.usd.year ? `<p class="yr">or $${p.usd.year.toLocaleString('en-US')}/yr (two months free)</p>` : p.contact ? '<p class="yr">Custom quote</p>' : '<p class="yr">No wallet needed</p>';
    const cta = p.contact
      ? '<a class="btn" href="/#agency">Talk to us</a>'
      : p.id === 'free'
        ? '<a class="btn" href="/api/v1/coinpay/oauth/start?return_to=/">Start free</a>'
        : `<a class="btn primary" href="/checkout?option=${p.id}-month">Choose ${esc(p.name)}</a> <a class="btn small" href="/checkout?option=${p.id}-year">Yearly</a>`;
    return `<article class="card plan${p.id === 'solo' ? ' pick' : ''}"><h2>${esc(p.name)}</h2><p class="muted">${esc(p.blurb)}</p><p class="price">${price}</p>${year}<ul>${p.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul><p>${cta}</p></article>`;
  };
  const L = (k, fmt = (v) => v) => Object.values(PLANS).filter((p) => !p.contact).map((p) => `<td>${fmt(p.limits[k], p)}</td>`).join('');
  const yes = (v) => (v ? 'Yes' : 'No');
  const rows = [
    ['REST API, MCP, CLI, TUI, desktop app', Object.values(PLANS).filter((p) => !p.contact).map(() => '<td>Included</td>').join('')],
    ['Credits', Object.values(PLANS).filter((p) => !p.contact).map((p) => `<td>${p.creditsOnce ? `${p.creditsOnce.toLocaleString('en-US')} once` : `${p.creditsMonthly.toLocaleString('en-US')}/mo`}</td>`).join('')],
    ['Brands (sites)', L('sites')],
    ['Site pages', L('pages')],
    ['Deploy size', L('deployMb', (v) => `${v} MB`)],
    ['Files per deploy', L('filesPerDeploy', (v) => v.toLocaleString('en-US'))],
    ['Versions kept for rollback', L('versions')],
    ['Forms', L('forms')],
    ['Site languages', L('languages')],
    ['Team seats', L('seats')],
    ['Own domain', L('domain', yes)],
    ['Bookings and shop', L('shop', yes)],
    ['Reels', L('reels', (v) => (v ? 'Yes' : 'Growth preview'))],
  ];
  const costs = [
    ['Static ad (1:1, 4:5 and 9:16)', COSTS.ad],
    ['Reel (c0mpute promo video)', COSTS.reel],
    ['App capture on your desktop environment (refunded if nothing usable)', COSTS.app_capture],
    ['Blog post written on c0mpute', COSTS.blog_post],
    ['Translation (per post, per language)', COSTS.translation],
    ['Post draft, repurpose, reply, ideas (after 3 free a day)', COSTS.generation],
  ];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pricing · autoinfluencer</title>
<meta name="description" content="Plans for autoinfluencer: website, blog, forms, bookings, shop, scheduling and publishing on every network, ads and reels made on the c0mpute network. Pay in crypto with CoinPay or per call with x402.">
<link rel="stylesheet" href="/style.css"><link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="manifest" href="/manifest.webmanifest">
</head><body>
<header class="top"><a class="brand" href="/"><img src="/icon.svg" alt="" width="28" height="28"> autoinfluencer</a><nav><a href="/">App</a><a href="/pricing">Pricing</a><a href="/#agents">Agents</a><span class="who">${esc(who)}</span></nav></header>
<main>
<section class="hero"><h1>Pricing</h1><p class="lead">Your website, blog, forms, bookings, shop and social posting are free on every plan. Credits pay only for AI work done on the <a href="https://c0mpute.com">c0mpute</a> network and the jobs your desktop environment runs. 1 credit = $0.01.</p></section>
<section class="plans">${Object.values(PLANS).map(card).join('')}</section>
<section class="card"><h2>Compare plans</h2><div class="tablewrap"><table class="cmp"><thead><tr><th></th>${Object.values(PLANS).filter((p) => !p.contact).map((p) => `<th>${esc(p.name)}</th>`).join('')}</tr></thead><tbody>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th>${v}</tr>`).join('')}</tbody></table></div></section>
<section class="grid2">
<article class="card"><h2>What credits pay for</h2><table class="cmp"><tbody>${costs.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v} credits</td></tr>`).join('')}</tbody></table>
<p class="muted">No credits for: websites and deploys, forms, bookings, newsletter sign-ups, shop orders, scheduling, publishing, and anything your own AI assistant writes (brief mode). Credits stop at zero: no overage.</p></article>
<article class="card"><h2>Top up</h2><p>One-time packs, paid in crypto through CoinPay. Credits never expire.</p><div class="packs">${Object.entries(TOPUPS).map(([id, t]) => `<a class="btn" href="/checkout?option=${id}">${t.credits.toLocaleString('en-US')} credits · $${t.usd}</a>`).join('')}</div>
<p class="muted">1,000 credits is about ${creditsIn(1000).ads} ads, or ${creditsIn(1000).blog_posts} blog posts. Agents can skip accounts and pay per call with x402.</p></article>
</section>
<section class="card"><h2>Questions</h2><dl class="faq">
<dt>Which AI assistants work?</dt><dd>Anything that speaks MCP: Claude (web, desktop, Claude Code), ChatGPT custom connectors, Codex, Cursor, VS Code, Gemini CLI, c0mpute chat. Add <code>/mcp</code> on this site and sign in with CoinPay. The CLI, TUI, desktop app and PWA call the same tools.</dd>
<dt>What runs where?</dt><dd>Writing, translation, ad copy and reels run on the <a href="https://c0mpute.com">c0mpute</a> peer-to-peer network, and the app itself is a c0mpute app. Anything that needs a real browser, such as posting to a network or recording your web app, runs on <b>your desktop environment</b> through the <a href="https://w3bs.org/desktop">W3BS Agentic Desktop Layer</a>.</dd>
<dt>What is a desktop environment?</dt><dd>A computer you add once you are signed in: your laptop, a workstation or a headless box. It connects out to us over a two-way channel, so no ports are opened. We send it jobs (publish this post, record this app) and it sends back results. It can also call every tool here as you. Nothing is posted without the schedule or your confirmation, and the person at that desktop can stop it at any time.</dd>
<dt>Will it post without asking?</dt><dd>No. Posts are scheduled or saved as drafts. Publishing right now needs your request and <code>confirm</code>. Cancelling a scheduled post turns it back into a draft.</dd>
<dt>Do I need Stripe or a card?</dt><dd>No. Plans and top-ups are paid in crypto through CoinPay. Shop orders can be paid with your own CoinPay payment link, or you arrange payment yourself and both of you get the order.</dd>
<dt>Can I use my own domain?</dt><dd>Yes, on Solo and up: the whole site or a blog on blog.yourdomain.com. Every plan also has a free address here.</dd>
<dt>I built my site myself. Can you host it?</dt><dd>Yes. <code>autoinfluencer site deploy ./dist</code> (or the <code>site_deploy</code> tool from your coding assistant) uploads it as a new version you can roll back. Drop-in components add forms, bookings, newsletter and a blog feed to any page.</dd>
<dt>Is the API included?</dt><dd>Yes, on every plan including Free: REST, MCP, CLI and TUI, with OpenAPI at <code>/openapi.json</code>.</dd>
<dt>What happens to my data?</dt><dd>We get only the tool calls your assistant makes, not your conversation. We store your account, brand kit, sites and what you make. We never sell it or train on it.</dd>
</dl></section>
</main>
${footers}
</body></html>`;
}
