import { getPlatform, graphemes } from './platforms.js';

/** Phrases that read as engagement bait or AI filler on every network. */
export const BAIT = [
  'like and share', 'smash that', 'follow for more', 'comment below', 'tag a friend',
  "you won't believe", 'this will blow your mind', 'game-changer', 'game changer', 'delve',
  'unleash', "in today's fast-paced", 'buckle up', 'let that sink in',
];

/**
 * Check a post against the platform's rules and the persona's style.
 * Returns { ok, errors, warnings, length, limit }. Errors would be rejected by the
 * network or break a persona rule; warnings are style.
 *
 * @param {{text:string,title?:string,platform:string,kind?:string}} post
 * @param {object|null} [persona]
 * @param {{recent?: string[]}} [opts] recent texts, for duplicate detection
 */
export function lintPost(post, persona = null, opts = {}) {
  const spec = getPlatform(post.platform);
  const text = String(post.text ?? '');
  const errors = [];
  const warnings = [];
  const length = graphemes(text);

  if (!text.trim()) errors.push('empty post');
  if (length > spec.limit) errors.push(`${length} characters, over the ${spec.name} limit of ${spec.limit}`);
  else if (length > spec.ideal * 1.5) warnings.push(`${length} characters; ${spec.name} posts do best near ${spec.ideal}`);

  if (spec.title) {
    if (!post.title) {
      if (['reddit', 'hackernews', 'youtube'].includes(spec.id)) errors.push(`${spec.name} needs a title`);
    } else if (graphemes(post.title) > spec.title) {
      errors.push(`title is ${graphemes(post.title)} characters, over ${spec.title}`);
    }
  }

  const tags = text.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? [];
  if (tags.length > spec.hashtags.max) {
    if (spec.hashtags.max === 0) errors.push(`${tags.length} hashtags; ${spec.name} does not use them`);
    else warnings.push(`${tags.length} hashtags; ${spec.name} works best with at most ${spec.hashtags.max}`);
  }
  const links = text.match(/https?:\/\/\S+/g) ?? [];
  if (links.length > spec.links.max) {
    warnings.push(
      spec.links.max === 0
        ? `${spec.name} does not make caption links clickable`
        : `${links.length} links; ${spec.name} prefers at most ${spec.links.max}`,
    );
  } else if (links.length && spec.links.penalized) {
    warnings.push(`${spec.name} down-ranks posts with links; consider the link in a reply`);
  }

  const lower = text.toLowerCase();
  for (const phrase of BAIT) if (lower.includes(phrase)) warnings.push(`reads as bait or filler: "${phrase}"`);
  if (persona) {
    for (const phrase of persona.avoid ?? []) {
      if (phrase && lower.includes(String(phrase).toLowerCase())) {
        errors.push(`uses a phrase the persona avoids: "${phrase}"`);
      }
    }
    if (persona.disclose && post.kind !== 'engage' && !text.includes(persona.disclosure)) {
      errors.push(`missing the disclosure "${persona.disclosure}" (persona.disclose is on)`);
    }
  }

  const letters = text.replace(/[^\p{L}]/gu, '');
  const caps = letters.replace(/[^\p{Lu}]/gu, '');
  if (letters.length > 20 && caps.length / letters.length > 0.5) warnings.push('mostly capital letters');
  const emoji = text.match(/\p{Extended_Pictographic}/gu) ?? [];
  if (emoji.length > 4) warnings.push(`${emoji.length} emoji`);
  if ((text.match(/!/g) ?? []).length > 3) warnings.push('many exclamation marks');

  const norm = normalize(text);
  if (norm && (opts.recent ?? []).some((r) => normalize(r) === norm)) errors.push('duplicate of a recent post');

  return { ok: errors.length === 0, errors, warnings, length, limit: spec.limit };
}

function normalize(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Append the persona's disclosure if it is on and missing, keeping within the limit. */
export function withDisclosure(text, persona, platform) {
  if (!persona?.disclose || String(text).includes(persona.disclosure)) return text;
  const spec = getPlatform(platform);
  const suffix = ` ${persona.disclosure}`;
  if (graphemes(text) + graphemes(suffix) <= spec.limit) return text + suffix;
  return text; // lint flags it; never silently cut the author's words
}
