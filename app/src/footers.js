// Fleet order for a pit.world host: site footer, Profullstack webring row (server-rendered,
// the ring verifier never runs script), then the pit.world global footer last.
import { footerHtml, footerHtmlSync } from '@profullstack/footer';

export const HOST = 'influencer.marketing.pit.world';
export const SITE = `https://${HOST}/`;
const PIT_SNIPPET = `https://pit.world/snippets/footer.html?site=${HOST}`;

const RING_OPTIONS = {
  site: SITE,
  links: [
    { label: 'API', href: `${SITE}openapi.json` },
    { label: 'CLI', href: 'https://www.npmjs.com/package/@profullstack/autoinfluencer' },
    { label: 'MCP', href: `${SITE}mcp` },
  ],
  since: 2026,
  tagline: 'posts in your voice, honestly',
};

export function siteFooter() {
  return `<footer class="site-footer"><p><strong>autoinfluencer</strong> writes on open models on the <a href="https://c0mpute.com">c0mpute</a> peer network. It never invents facts or engagement, keeps an AI disclosure on by default, and never posts for you without your go-ahead. Open source: <a href="https://github.com/profullstack/autoinfluencer">github.com/profullstack/autoinfluencer</a>.</p></footer>`;
}

let ring = '';
try {
  ring = footerHtmlSync({ ...RING_OPTIONS, version: 'bundled' });
} catch {
  /* filled on first refresh */
}
let pit = '';

export async function refreshFooters(fetchImpl = fetch) {
  try {
    const next = await footerHtml(RING_OPTIONS);
    if (typeof next === 'string' && next.includes('/ring/profullstack')) ring = next;
  } catch {
    /* keep the last good copy */
  }
  try {
    const r = await fetchImpl(PIT_SNIPPET, { signal: AbortSignal.timeout(4000) });
    const html = r.ok ? (await r.text()).trim() : '';
    if (html.includes('data-pit-footer') && html.length < 64_000) pit = html;
  } catch {
    /* keep the last good copy */
  }
}

export function startFooterRefresh(everyMs = 30 * 60_000) {
  refreshFooters();
  const t = setInterval(refreshFooters, everyMs);
  t.unref?.();
}

export const allFooters = () => `${siteFooter()}\n${ring}\n${pit}`;
