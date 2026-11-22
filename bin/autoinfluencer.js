#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createTools } from '../src/tools.js';
import { examplePersona, savePersona, defaultPersonaPath, loadPersona } from '../src/persona.js';
import { VERSION } from '../src/mcp.js';
import { login, logout, callRemote, readAuth, DEFAULT_URL } from '../src/remote.js';

const HELP = `autoinfluencer ${VERSION} - persona-driven social posts for every network

Usage: autoinfluencer <command> [options]

Persona
  init [--force]                      write a starter persona to ~/.autoinfluencer/persona.json
  persona                             print the saved persona

Write (add --brief to get the prompt instead of calling c0mpute)
  ideas [topic] [--count 10] [--pillar P]
  draft <topic> [-p bluesky,x] [--link URL]
  repurpose <url|file|-> [-p ...]    an article, changelog or transcript into posts
  reply <post text|-> [-p bluesky] [--author A] [--goal G]
  calendar [--days 7] [--per-day 3] [--ideas]
  lint <text|-> -p <platform> [--title T]

Queue and publish
  queue add <text|-> -p <platform> [--at ISO] [--title T] [--subreddit S]
  queue list [--status queued|sent|failed]
  run [--yes] [--limit 10]            send due posts (dry run without --yes)

Hosted app (${DEFAULT_URL}; sign in with CoinPay, pay per use)
  login [--url URL]                   sign in from this terminal (device code)
  whoami                              account, free generations left, credits
  persona push                        save your local persona on your account
  logout
  --remote                            run any write command on the hosted app

Surfaces
  mcp                                 MCP server over stdio
  serve [--port 8787] [--host 127.0.0.1]   HTTP API + /mcp + /openapi.json
  platforms                           network rules

Options: --persona <file>  --json  --brief  -p/--platforms a,b  -h/--help  -v/--version
Env: C0MPUTE_API_KEY (optional; 10 free c0mpute queries a day without), AUTOINFLUENCER_HOME,
     AUTOINFLUENCER_PUBLISHER=stdout|webhook|autopost|myna, AUTOPOST_TOKEN, AUTOINFLUENCER_WEBHOOK_URL
Docs: https://github.com/profullstack/autoinfluencer`;

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
    json: { type: 'boolean' },
    brief: { type: 'boolean' },
    force: { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
    ideas: { type: 'boolean' },
    persona: { type: 'string' },
    platforms: { type: 'string', short: 'p' },
    count: { type: 'string' },
    pillar: { type: 'string' },
    link: { type: 'string' },
    author: { type: 'string' },
    goal: { type: 'string' },
    days: { type: 'string' },
    'per-day': { type: 'string' },
    title: { type: 'string' },
    subreddit: { type: 'string' },
    at: { type: 'string' },
    status: { type: 'string' },
    limit: { type: 'string' },
    port: { type: 'string' },
    host: { type: 'string' },
    remote: { type: 'boolean', short: 'r' },
    url: { type: 'string' },
  },
});

const [cmd, ...rest] = positionals;
if (o.version) out(VERSION);
else if (o.help || !cmd || cmd === 'help') out(HELP);
else main().catch((err) => {
  process.stderr.write(`autoinfluencer: ${err?.message ?? err}\n`);
  process.exit(1);
});

async function main() {
  const tools = Object.fromEntries(createTools({ local: true }).map((t) => [t.name, t]));
  const call = (name, args) =>
    o.remote && !['platforms', 'queue_add', 'queue_list', 'publish_due'].includes(name)
      ? callRemote(name, args, { onWait: () => process.stderr.write('.') })
      : tools[name].handler(args);
  const persona = o.persona ? await loadPersona(o.persona) : undefined;
  const mode = o.brief ? 'brief' : 'auto';
  const plats = o.platforms ? o.platforms.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const num = (v) => (v == null ? undefined : Number(v));

  switch (cmd) {
    case 'init': {
      const path = defaultPersonaPath();
      if (existsSync(path) && !o.force) throw new Error(`${path} exists (use --force to overwrite)`);
      await savePersona(examplePersona(), path);
      return out(`wrote ${path}\nEdit it: name, niche, audience, voice, pillars, platforms. Then: autoinfluencer ideas`);
    }
    case 'persona':
      if (rest[0] === 'push') return print(await callRemote('persona_save', { persona: await loadPersona(o.persona) }));
      return print(o.remote ? await callRemote('persona_get', {}) : await loadPersona(o.persona));
    case 'login': {
      const auth = await login({
        url: o.url,
        onCode: (d) => process.stderr.write(`Open ${d.verification_uri}\nsign in with CoinPay and enter the code: ${d.user_code}\nwaiting…\n`),
      });
      return out(`signed in to ${auth.url}`);
    }
    case 'logout':
      return print(await logout());
    case 'whoami': {
      const auth = await readAuth();
      if (!auth) return out('not signed in (autoinfluencer login)');
      return print({ url: auth.url, ...(await callRemote('balance', {})) });
    }
    case 'platforms':
      return print(o.json ? await call('platforms', {}) : (await call('platforms', {})).platforms.map((p) => `${p.id.padEnd(11)} ${String(p.limit).padStart(6)}  ${p.notes}`).join('\n'));
    case 'ideas':
      return show(await call('ideas', { persona, topic: rest.join(' ') || undefined, count: num(o.count), pillar: o.pillar, mode }));
    case 'draft':
      return show(await call('draft', { persona, topic: rest.join(' ') || (await stdinIf('-')), link: o.link, platforms: plats, mode }));
    case 'repurpose': {
      const src = rest[0];
      if (!src) throw new Error('repurpose needs a url, a file or - for stdin');
      const args = { persona, platforms: plats, mode };
      if (/^https?:\/\//.test(src)) args.url = src;
      else args.text = src === '-' ? await stdin() : await readFile(src, 'utf8');
      return show(await call('repurpose', args));
    }
    case 'reply':
      return show(await call('reply', { persona, post: rest[0] === '-' ? await stdin() : rest.join(' '), platform: plats?.[0], author: o.author, goal: o.goal, mode }));
    case 'calendar':
      return show(await call('calendar', { persona, days: num(o.days), perDay: num(o['per-day']), withIdeas: !!o.ideas, mode }));
    case 'lint': {
      if (!plats?.length) throw new Error('lint needs -p <platform>');
      const text = rest[0] === '-' || !rest.length ? await stdin() : rest.join(' ');
      const res = await call('lint', { persona, posts: plats.map((platform) => ({ platform, text, title: o.title })) });
      show(res);
      if (res.results.some((r) => !r.ok)) process.exitCode = 2;
      return;
    }
    case 'queue': {
      const [sub, ...txt] = rest;
      if (sub === 'list') return show(await call('queue_list', { status: o.status }));
      if (sub === 'add') {
        if (!plats?.length) throw new Error('queue add needs -p <platform>');
        const text = txt[0] === '-' || !txt.length ? await stdin() : txt.join(' ');
        return show(await call('queue_add', { posts: plats.map((platform) => ({ platform, text, title: o.title, subreddit: o.subreddit, at: o.at })) }));
      }
      throw new Error('queue add | queue list');
    }
    case 'run':
      return show(await call('publish_due', { confirm: !!o.yes, limit: num(o.limit) }));
    case 'mcp': {
      const { serveStdio } = await import('../src/mcp.js');
      return serveStdio({ local: true });
    }
    case 'serve': {
      const { serve } = await import('../src/server.js');
      const port = num(o.port) ?? 8787;
      const host = o.host ?? '127.0.0.1';
      await serve({ port, host, local: true });
      return process.stderr.write(`autoinfluencer listening on http://${host}:${port}  (/mcp, /api/<tool>, /openapi.json)\n`);
    }
    default:
      throw new Error(`unknown command "${cmd}" (try --help)`);
  }
}

function out(s) {
  process.stdout.write(`${s}\n`);
}
function print(v) {
  out(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
}

/** Human output unless --json: briefs as Markdown, posts with their lint verdicts. */
function show(res) {
  if (o.json) return print(res);
  if (res.mode === 'brief') {
    if (res.note) process.stderr.write(`${res.note}\n\n`);
    return out(res.brief);
  }
  if (res.posts) {
    for (const p of res.posts) {
      out(`── ${p.platform}${p.title ? ` · ${p.title}` : ''} (${p.lint.length}/${p.lint.limit}) ${p.lint.ok ? 'ok' : 'NEEDS WORK'}`);
      out(p.thread ? p.thread.join('\n\n') : p.text);
      for (const e of p.lint.errors) out(`  ✗ ${e}`);
      for (const w of p.lint.warnings) out(`  ! ${w}`);
      out('');
    }
    return;
  }
  if (res.ideas) return out(res.ideas.map((i, n) => `${n + 1}. [${i.pillar ?? ''}/${i.format ?? ''}] ${i.hook}\n   ${i.angle ?? ''}`).join('\n'));
  if (res.slots) return out(res.slots.map((s) => `${s.at.slice(0, 16).replace('T', ' ')}  ${s.platform.padEnd(10)} ${s.kind.padEnd(6)} ${s.idea?.hook ?? s.pillar ?? s.task}`).join('\n'));
  if (res.results) {
    return out(res.results.map((r) => [`${r.platform}: ${r.ok ? 'ok' : 'fails'} (${r.length}/${r.limit})`, ...r.errors.map((e) => `  ✗ ${e}`), ...r.warnings.map((w) => `  ! ${w}`)].join('\n')).join('\n'));
  }
  if (res.text && res.platform) {
    out(res.text);
    if (res.why) process.stderr.write(`\nwhy: ${res.why}\n`);
    return;
  }
  print(res);
}

async function stdin() {
  if (process.stdin.isTTY) throw new Error('expected text on stdin');
  let s = '';
  for await (const c of process.stdin) s += c;
  return s.trim();
}
async function stdinIf(flag) {
  return rest.includes(flag) ? stdin() : undefined;
}
