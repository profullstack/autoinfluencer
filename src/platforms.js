/**
 * What each network accepts and rewards. Limits are hard caps the network enforces;
 * `ideal` is the length that tends to perform, used as a soft target in prompts.
 * Counts are graphemes (what a person sees), not UTF-16 code units.
 */

/** @type {Record<string, import('../index.d.ts').PlatformSpec>} */
export const PLATFORMS = {
  x: {
    id: 'x', name: 'X', limit: 280, ideal: 220,
    hashtags: { max: 2, style: 'inline' }, links: { max: 1, penalized: true }, threads: true,
    notes: 'Hook in the first line. Links are down-ranked, so put the link in a reply when reach matters.',
  },
  bluesky: {
    id: 'bluesky', name: 'Bluesky', limit: 300, ideal: 240,
    hashtags: { max: 2, style: 'inline' }, links: { max: 1 }, threads: true,
    notes: 'Conversational, nerdy, allergic to marketing voice. Hashtags are rare and optional.',
  },
  mastodon: {
    id: 'mastodon', name: 'Mastodon', limit: 500, ideal: 400,
    hashtags: { max: 4, style: 'trailing' }, links: { max: 2 }, threads: true,
    notes: 'Hashtags are how posts are found (no algorithm); CamelCase them for screen readers. Alt text on every image.',
  },
  threads: {
    id: 'threads', name: 'Threads', limit: 500, ideal: 300,
    hashtags: { max: 1, style: 'inline' }, links: { max: 1 }, threads: true,
    notes: 'One topic tag per post. Casual, question-led posts get replies.',
  },
  linkedin: {
    id: 'linkedin', name: 'LinkedIn', limit: 3000, ideal: 1200,
    hashtags: { max: 3, style: 'trailing' }, links: { max: 1, penalized: true }, threads: false,
    notes: 'First 210 characters show before "see more", so the hook must land there. Short paragraphs, a concrete lesson, no humblebrag.',
  },
  reddit: {
    id: 'reddit', name: 'Reddit', limit: 40000, ideal: 1500, title: 300,
    hashtags: { max: 0, style: 'none' }, links: { max: 1 }, threads: false,
    notes: 'Needs a subreddit and a title. Read the sub rules. Lead with value, disclose that it is yours, never drop a bare link.',
  },
  hackernews: {
    id: 'hackernews', name: 'Hacker News', limit: 4000, ideal: 600, title: 80,
    hashtags: { max: 0, style: 'none' }, links: { max: 1 }, threads: false,
    notes: 'Plain factual title, no hype, no emoji. Show HN only for things people can try.',
  },
  instagram: {
    id: 'instagram', name: 'Instagram', limit: 2200, ideal: 600,
    hashtags: { max: 5, style: 'trailing' }, links: { max: 0 }, threads: false, media: 'required',
    notes: 'Needs an image or video. Links in captions are not clickable, so point to the bio.',
  },
  tiktok: {
    id: 'tiktok', name: 'TikTok', limit: 2200, ideal: 150,
    hashtags: { max: 4, style: 'trailing' }, links: { max: 0 }, threads: false, media: 'required',
    notes: 'The caption supports a video. Write the on-screen hook and a 3-beat script, not an essay.',
  },
  youtube: {
    id: 'youtube', name: 'YouTube', limit: 5000, ideal: 800, title: 100,
    hashtags: { max: 3, style: 'trailing' }, links: { max: 5 }, threads: false, media: 'required',
    notes: 'Title under 60 characters to avoid truncation. Description: summary, chapters, links.',
  },
  facebook: {
    id: 'facebook', name: 'Facebook', limit: 63206, ideal: 400,
    hashtags: { max: 2, style: 'trailing' }, links: { max: 1 }, threads: false,
    notes: 'Short, warm, community voice. Questions outperform announcements.',
  },
  telegram: {
    id: 'telegram', name: 'Telegram', limit: 4096, ideal: 700,
    hashtags: { max: 3, style: 'trailing' }, links: { max: 3 }, threads: false,
    notes: 'Channel posts can carry Markdown. Lead with the news.',
  },
  discord: {
    id: 'discord', name: 'Discord', limit: 2000, ideal: 500,
    hashtags: { max: 0, style: 'none' }, links: { max: 3 }, threads: false,
    notes: 'Write for the channel you are in. No @everyone.',
  },
  nostr: {
    id: 'nostr', name: 'Nostr', limit: 2000, ideal: 300,
    hashtags: { max: 3, style: 'trailing' }, links: { max: 2 }, threads: true,
    notes: 'Bitcoin- and freedom-tech-leaning audience. Zaps reward useful posts.',
  },
  newsletter: {
    id: 'newsletter', name: 'Newsletter', limit: 20000, ideal: 2500, title: 120,
    hashtags: { max: 0, style: 'none' }, links: { max: 10 }, threads: false,
    notes: 'Subject line plus a skimmable body: one idea, headers, one call to action.',
  },
  blog: {
    id: 'blog', name: 'Blog post', limit: 100000, ideal: 6000, title: 120,
    hashtags: { max: 0, style: 'none' }, links: { max: 20 }, threads: false,
    notes: 'H2 sections, a concrete example, a short summary, rel=canonical on syndicated copies.',
  },
};

const ALIASES = {
  twitter: 'x', 'x.com': 'x', bsky: 'bluesky', hn: 'hackernews', 'hacker-news': 'hackernews',
  ig: 'instagram', fb: 'facebook', yt: 'youtube', li: 'linkedin', masto: 'mastodon',
};

/** Normalise a platform name or alias to its id. Throws on unknown names. */
export function platformId(name) {
  const key = String(name ?? '').trim().toLowerCase();
  const id = ALIASES[key] ?? key;
  if (!PLATFORMS[id]) {
    throw new Error(`unknown platform "${name}" (known: ${Object.keys(PLATFORMS).join(', ')})`);
  }
  return id;
}

/** The spec for a platform name or alias. */
export function getPlatform(name) {
  return PLATFORMS[platformId(name)];
}

export function listPlatforms() {
  return Object.values(PLATFORMS);
}

const segmenter =
  typeof Intl !== 'undefined' && Intl.Segmenter
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/** Length as a person counts it (emoji and combined characters count once). */
export function graphemes(text) {
  const s = String(text ?? '');
  if (!segmenter) return [...s].length;
  let n = 0;
  for (const _ of segmenter.segment(s)) n++;
  return n;
}

/** Cut text to at most `max` graphemes on a word boundary, ending with an ellipsis. */
export function truncate(text, max) {
  const s = String(text ?? '');
  if (graphemes(s) <= max) return s;
  const parts = segmenter ? [...segmenter.segment(s)].map((x) => x.segment) : [...s];
  let out = parts.slice(0, Math.max(0, max - 1)).join('');
  const cut = out.search(/\s\S*$/);
  if (cut > max * 0.6) out = out.slice(0, cut);
  return out.replace(/[\s.,;:!-]+$/, '') + '…';
}

/**
 * Split long text into a thread of posts each within the platform limit, numbered
 * "1/n" when more than one. Splits on paragraphs, then sentences, then words.
 */
export function toThread(text, platform) {
  const spec = getPlatform(platform);
  const max = spec.limit - 6; // room for " 10/12"
  const pieces = String(text ?? '')
    .split(/\n{2,}/)
    .flatMap((p) => (graphemes(p) <= max ? [p] : p.split(/(?<=[.!?])\s+/)))
    .flatMap((p) => (graphemes(p) <= max ? [p] : splitWords(p, max)));
  const posts = [];
  let cur = '';
  for (const piece of pieces) {
    const next = cur ? `${cur}\n\n${piece}` : piece;
    if (graphemes(next) <= max) cur = next;
    else {
      if (cur) posts.push(cur);
      cur = piece;
    }
  }
  if (cur) posts.push(cur);
  if (posts.length <= 1) return posts;
  return posts.map((p, i) => `${p} ${i + 1}/${posts.length}`);
}

function splitWords(text, max) {
  const out = [];
  let cur = '';
  for (const w of text.split(/\s+/)) {
    const next = cur ? `${cur} ${w}` : w;
    if (graphemes(next) <= max) cur = next;
    else {
      if (cur) out.push(cur);
      cur = graphemes(w) > max ? truncate(w, max) : w;
    }
  }
  if (cur) out.push(cur);
  return out;
}
