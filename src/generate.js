import { normalizePersona } from './persona.js';
import { getPlatform, platformId, toThread, graphemes } from './platforms.js';
import { lintPost, withDisclosure } from './lint.js';
import { ideasPrompt, draftPrompt, replyPrompt, asBrief } from './prompts.js';

/**
 * Modes:
 *   auto  – write with c0mpute (via @profullstack/ai-providers); if that fails, return the brief.
 *   ai    – write with c0mpute; throw if it fails.
 *   brief – never call a model; return the prompt so the calling agent (Claude, ChatGPT,
 *           a c0mpute chat model) writes the posts itself, then checks them with `lint`.
 */

/** Models anyone can run on c0mpute without a key (4B and under are free, 10 queries a day). */
export const FREE_C0MPUTE_MODELS = ['qwen3:4b', 'huihui_ai/qwen3.5-abliterated:4b'];

let aiRouter;
async function defaultAi() {
  if (aiRouter) return aiRouter;
  const { createAiProviders } = await import('@profullstack/ai-providers');
  const env = { ...process.env };
  const hasKey = env.C0MPUTE_API_KEY || env.INFERNET_API_KEY;
  if (!hasKey && !env.C0MPUTE_MODELS && !env.C0MPUTE_MODEL) env.C0MPUTE_MODELS = FREE_C0MPUTE_MODELS.join(',');
  aiRouter = createAiProviders({ env });
  return aiRouter;
}

async function run(prompt, { mode = 'auto', ai, validate, feature, temperature = 0.8, timeoutMs } = {}) {
  if (mode === 'brief') return { mode: 'brief', brief: asBrief(prompt) };
  try {
    const client = ai ?? (await defaultAi());
    const res = await client.generateObject({
      system: prompt.system,
      user: prompt.user,
      schema: validate,
      feature: `autoinfluencer.${feature}`,
      temperature,
      maxTokens: 2500,
      timeoutMs: Number(timeoutMs ?? process.env.AUTOINFLUENCER_TIMEOUT_MS ?? 120000),
    });
    return { mode: 'ai', object: res.object, provider: res.provider, model: res.model };
  } catch (err) {
    if (mode === 'ai') throw err;
    return {
      mode: 'brief',
      brief: asBrief(prompt),
      note: `model unavailable (${err?.message ?? err}); write the posts from this brief, then run lint`,
    };
  }
}

function must(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** Post ideas for the persona. */
export async function ideas(persona, opts = {}) {
  const p = normalizePersona(persona);
  const count = Math.min(Math.max(Number(opts.count) || 10, 1), 50);
  const out = await run(ideasPrompt(p, { count, topic: opts.topic, pillar: opts.pillar }), {
    ...opts,
    feature: 'ideas',
    validate: (v) => {
      must(Array.isArray(v?.ideas) && v.ideas.length, 'expected {"ideas":[...]}');
      for (const i of v.ideas) must(typeof i?.hook === 'string' && i.hook, 'each idea needs a hook');
      return v;
    },
  });
  if (out.mode !== 'ai') return out;
  return { mode: 'ai', provider: out.provider, model: out.model, ideas: out.object.ideas.slice(0, count) };
}

/**
 * Finish model output into ready posts: disclosure added, long text threaded where the
 * platform supports threads, each post linted.
 */
export function finishPosts(p, posts, { recent = [] } = {}) {
  return posts.map((raw) => {
    const platform = platformId(raw.platform);
    const spec = getPlatform(platform);
    let text = String(raw.text ?? '').trim();
    let thread;
    if (graphemes(text) > spec.limit && spec.threads) {
      thread = toThread(text, platform);
      thread[0] = withDisclosure(thread[0], p, platform);
      text = thread[0];
    } else {
      text = withDisclosure(text, p, platform);
    }
    const post = { platform, kind: raw.kind ?? 'own', text, ...(raw.title ? { title: raw.title } : {}) };
    if (thread) post.thread = thread;
    post.lint = lintPost(post, p, { recent });
    return post;
  });
}

/** Native posts for each platform from a topic, idea or source text. */
export async function draft(persona, opts = {}) {
  const p = normalizePersona(persona);
  const platforms = [...new Set((opts.platforms?.length ? opts.platforms : p.platforms).map(platformId))];
  must(opts.topic || opts.source, 'draft needs a topic or source');
  const out = await run(
    draftPrompt(p, { topic: opts.topic, source: opts.source, link: opts.link, platforms }),
    {
      ...opts,
      feature: 'draft',
      validate: (v) => {
        must(Array.isArray(v?.posts) && v.posts.length, 'expected {"posts":[...]}');
        for (const x of v.posts) must(typeof x?.text === 'string' && x.platform, 'each post needs platform and text');
        return v;
      },
    },
  );
  if (out.mode !== 'ai') return { ...out, platforms };
  const posts = out.object.posts.filter((x) => {
    try {
      return platforms.includes(platformId(x.platform));
    } catch {
      return false;
    }
  });
  return { mode: 'ai', provider: out.provider, model: out.model, posts: finishPosts(p, posts, opts) };
}

/** Readable text from a URL: strips scripts, styles, tags and collapses whitespace. */
export async function fetchText(url, { fetch: f = globalThis.fetch, maxChars = 12000, blockPrivate = false } = {}) {
  const u = new URL(url);
  must(u.protocol === 'https:' || u.protocol === 'http:', 'only http(s) URLs');
  if (blockPrivate) await assertPublicHost(u.hostname);
  const res = await f(u, { headers: { 'user-agent': 'autoinfluencer/0.1 (+https://github.com/profullstack/autoinfluencer)' }, redirect: 'follow' });
  must(res.ok, `fetch ${url} failed: ${res.status}`);
  const html = await res.text();
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  const text = html
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
  return { title, text: text.slice(0, maxChars) };
}

/** Refuse hosts that resolve to loopback, private, link-local or metadata addresses. */
export async function assertPublicHost(hostname) {
  const { lookup } = await import('node:dns/promises');
  const host = hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal|metadata\..*)$/i.test(host)) throw new Error(`refusing private host ${host}`);
  const addrs = await lookup(host, { all: true });
  for (const { address } of addrs) {
    if (isPrivateIp(address)) throw new Error(`refusing private address for ${host}`);
  }
}

export function isPrivateIp(ip) {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) {
    const [a, b] = v4.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const x = ip.toLowerCase();
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80');
}

/** Turn an article, changelog, transcript or URL into native posts. */
export async function repurpose(persona, opts = {}) {
  let source = opts.text;
  let link = opts.link;
  if (!source && opts.url) {
    const page = await fetchText(opts.url, opts);
    source = page.title ? `${page.title}\n\n${page.text}` : page.text;
    link ??= opts.url;
  }
  must(source, 'repurpose needs text or url');
  return draft(persona, { ...opts, source, link, topic: opts.topic });
}

/** A reply that adds value to someone else's post (comment-share). */
export async function reply(persona, opts = {}) {
  const p = normalizePersona(persona);
  must(opts.post, 'reply needs the post text');
  const platform = platformId(opts.platform ?? 'bluesky');
  const out = await run(replyPrompt(p, { post: opts.post, platform, author: opts.author, goal: opts.goal }), {
    ...opts,
    feature: 'reply',
    temperature: 0.6,
    validate: (v) => {
      must(typeof v?.text === 'string' && v.text.trim(), 'expected {"text":"..."}');
      return v;
    },
  });
  if (out.mode !== 'ai') return { ...out, platform };
  const post = { platform, kind: 'engage', text: out.object.text.trim() };
  return { mode: 'ai', provider: out.provider, model: out.model, ...post, why: out.object.why, lint: lintPost(post, p) };
}

/**
 * A posting calendar: `days` × `perDay` slots at the persona's posting hours, split
 * between own posts and engagement (replies to others) by persona.mix, rotating
 * platforms and pillars. Deterministic; pass `withIdeas: true` to fill own slots.
 */
export async function calendar(persona, opts = {}) {
  const p = normalizePersona(persona);
  const days = Math.min(Math.max(Number(opts.days) || 7, 1), 90);
  const perDay = Math.min(Math.max(Number(opts.perDay) || p.postingHours.length, 1), 24);
  const start = opts.start ? new Date(opts.start) : nextDay(new Date());
  const hours = Array.from({ length: perDay }, (_, i) => p.postingHours[i % p.postingHours.length]);
  const slots = [];
  let n = 0;
  let ownCount = 0;
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++, n++) {
      const at = new Date(start);
      at.setUTCDate(at.getUTCDate() + d);
      at.setUTCHours(hours[i], (i * 7) % 60, 0, 0);
      // Own when behind the target ratio, otherwise engage.
      const kind = ownCount < Math.round((n + 1) * p.mix.own) ? 'own' : 'engage';
      if (kind === 'own') ownCount++;
      slots.push({
        at: at.toISOString(),
        platform: p.platforms[n % p.platforms.length],
        kind,
        pillar: kind === 'own' ? p.pillars[(ownCount - 1) % p.pillars.length] : undefined,
        task:
          kind === 'own'
            ? 'publish an original post'
            : 'find a relevant post by someone else in the niche and reply with something useful',
      });
    }
  }
  if (opts.withIdeas) {
    const own = slots.filter((s) => s.kind === 'own');
    if (own.length) {
      const res = await ideas(p, { ...opts, count: own.length });
      if (res.ideas) own.forEach((s, i) => (s.idea = res.ideas[i % res.ideas.length]));
      else return { slots, timezone: 'UTC', ideas: res };
    }
  }
  return { slots, timezone: 'UTC' };
}

function nextDay(d) {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + 1);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}
