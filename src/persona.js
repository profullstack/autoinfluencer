import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { platformId } from './platforms.js';

/** Where autoinfluencer keeps its persona, queue and history. */
export function homeDir(env = process.env) {
  return env.AUTOINFLUENCER_HOME || join(homedir(), '.autoinfluencer');
}

export function defaultPersonaPath(env = process.env) {
  return env.AUTOINFLUENCER_PERSONA || join(homeDir(env), 'persona.json');
}

/** A starting persona. Every field is plain language the model reads. */
export function examplePersona() {
  return {
    name: 'Ada Builder',
    handle: '@adabuilds',
    bio: 'Indie developer shipping small, useful tools in public.',
    niche: 'developer tools and indie SaaS',
    audience: 'working developers and indie hackers who want practical tips, not hype',
    voice: 'plain, specific, a little dry; shows the work; never salesy',
    pillars: [
      'build-in-public updates with real numbers',
      'one practical tip per post',
      'teardowns of tools the audience already uses',
      'honest lessons from things that failed',
    ],
    platforms: ['bluesky', 'mastodon', 'linkedin', 'x'],
    links: { site: 'https://example.com' },
    cta: 'try the free tier',
    avoid: ['revolutionary', 'unlock', 'synergy'],
    examples: [],
    disclose: true,
    disclosure: '(AI-assisted)',
    timezone: 'UTC',
    postingHours: [9, 13, 17],
    mix: { own: 0.25, engage: 0.75 },
  };
}

/**
 * Check and normalise a persona. Returns a new object; throws with every problem
 * listed when required fields are missing.
 */
export function normalizePersona(input) {
  if (!input || typeof input !== 'object') throw new Error('persona must be an object');
  const p = { ...input };
  const problems = [];
  for (const k of ['name', 'niche', 'audience', 'voice']) {
    if (!p[k] || typeof p[k] !== 'string') problems.push(`"${k}" is required (a short sentence)`);
  }
  p.pillars = arr(p.pillars);
  p.avoid = arr(p.avoid);
  p.examples = arr(p.examples);
  const platforms = arr(p.platforms);
  try {
    p.platforms = [...new Set((platforms.length ? platforms : ['bluesky', 'mastodon', 'linkedin']).map(platformId))];
  } catch (e) {
    problems.push(e.message);
  }
  if (!p.pillars.length) problems.push('"pillars" needs at least one content theme');
  p.disclose = p.disclose !== false;
  p.disclosure =
    typeof p.disclosure === 'string' && p.disclosure.trim() ? p.disclosure.trim() : '(AI-assisted)';
  p.timezone = p.timezone || 'UTC';
  p.postingHours = arr(p.postingHours).map(Number).filter((h) => h >= 0 && h < 24);
  if (!p.postingHours.length) p.postingHours = [9, 13, 17];
  const own = clamp01(Number(p.mix?.own ?? 0.25));
  p.mix = { own, engage: Math.round((1 - own) * 100) / 100 };
  p.links = p.links && typeof p.links === 'object' ? p.links : {};
  if (problems.length) {
    const err = new Error(`invalid persona:\n  - ${problems.join('\n  - ')}`);
    err.problems = problems;
    throw err;
  }
  return p;
}

function arr(v) {
  if (v == null || v === '') return [];
  return Array.isArray(v) ? v.filter((x) => x !== '' && x != null) : [v];
}

function clamp01(n) {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.25;
}

/**
 * Parse a persona from JSON or from Markdown with a simple `key: value` front matter
 * block. Lists in front matter are `- item` lines under the key; the body becomes `bio`.
 */
export function parsePersona(text) {
  const s = String(text).trim();
  if (s.startsWith('{')) return JSON.parse(s);
  const m = s.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error('persona must be JSON or Markdown with front matter');
  const front = parseFrontMatter(m[1]);
  const body = m[2].trim();
  if (body && !front.bio) front.bio = body;
  return front;
}

function parseFrontMatter(src) {
  const out = {};
  let key = null;
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && key) {
      if (!Array.isArray(out[key])) out[key] = [];
      out[key].push(scalar(item[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      out[key] = kv[2] === '' ? [] : scalar(kv[2]);
    }
  }
  return out;
}

function scalar(v) {
  const s = v.trim().replace(/^["'](.*)["']$/, '$1');
  if (/^(true|false)$/i.test(s)) return s.toLowerCase() === 'true';
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (/^\[.*\]$/.test(s)) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1).split(',').map((x) => scalar(x));
    }
  }
  return s;
}

/** Load the persona: an object passes through, a path is read, nothing reads the default file. */
export async function loadPersona(source, env = process.env) {
  if (source && typeof source === 'object') return normalizePersona(source);
  const path = source || defaultPersonaPath(env);
  if (!existsSync(path)) {
    throw new Error(`no persona at ${path}. Run "autoinfluencer init" or pass one inline.`);
  }
  return normalizePersona(parsePersona(await readFile(path, 'utf8')));
}

export async function savePersona(persona, path = defaultPersonaPath()) {
  const p = normalizePersona(persona);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(p, null, 2) + '\n');
  return path;
}
