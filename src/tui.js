import { createInterface, emitKeypressEvents } from 'node:readline';
import { callRemote, readAuth, DEFAULT_URL } from './remote.js';

/**
 * The terminal UI: every tool the hosted app has, grouped by feature, each one a form built
 * from its JSON schema (from /openapi.json), so a new tool shows up here the day it ships.
 * Arrow keys or j/k to move, Enter to open, Esc or Backspace to go back, q to quit.
 */

const GROUPS = [
  ['Write posts', /^(ideas|draft|repurpose|reply|calendar|lint|platforms|persona_.*|job_status)$/],
  ['Sites', /^(site_.*|brand_.*)$/],
  ['Blog & newsletter', /^(blog_.*|newsletter_.*)$/],
  ['Inbox, forms & bookings', /^(inbox|form_.*|subscribers|booking_.*)$/],
  ['Shop', /^(product_.*|order_.*)$/],
  ['Social schedule', /^social_.*$/],
  ['Ads & reels', /^(ad_.*|reel_.*|preview_ads)$/],
  ['Desktop environments', /^(desktop_.*|app_capture)$/],
  ['Plan, credits & team', /^(plan_.*|credits_.*|team_.*|balance)$/],
];

const C = { dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`, inv: (s) => `\x1b[7m${s}\x1b[0m`, pink: (s) => `\x1b[38;5;205m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`, cyan: (s) => `\x1b[36m${s}\x1b[0m` };
const clear = () => process.stdout.write('\x1b[2J\x1b[H');

export function groupTools(ops) {
  const out = GROUPS.map(([name, re]) => ({ name, tools: ops.filter((o) => re.test(o.name)) }));
  const used = new Set(out.flatMap((g) => g.tools.map((t) => t.name)));
  const rest = ops.filter((o) => !used.has(o.name));
  if (rest.length) out.push({ name: 'Other', tools: rest });
  return out.filter((g) => g.tools.length);
}

/** Tools from the app's OpenAPI document: name, title, description, input schema. */
export async function loadTools(url, f = globalThis.fetch) {
  const r = await f(`${url}/openapi.json`);
  if (!r.ok) throw new Error(`could not read ${url}/openapi.json (${r.status})`);
  const doc = await r.json();
  return Object.entries(doc.paths).map(([path, v]) => ({ name: path.replace('/api/', ''), title: v.post.summary, description: v.post.description, schema: v.post.requestBody?.content?.['application/json']?.schema ?? { type: 'object', properties: {} }, readOnly: !v.post['x-openai-isConsequential'] }));
}

function keyLoop(render, onKey) {
  return new Promise((resolve) => {
    const done = (v) => {
      process.stdin.off('keypress', handler);
      resolve(v);
    };
    const handler = (str, key = {}) => onKey(str, key, done, render);
    process.stdin.on('keypress', handler);
    render();
  });
}

async function menu(title, items, header) {
  let i = 0;
  const rows = () => Math.max(5, (process.stdout.rows || 24) - 8);
  return keyLoop(
    () => {
      clear();
      process.stdout.write(`${header}\n\n${C.bold(title)}\n\n`);
      const top = Math.max(0, Math.min(i - Math.floor(rows() / 2), items.length - rows()));
      items.slice(top, top + rows()).forEach((it, n) => {
        const idx = top + n;
        const line = `${it.label}${it.hint ? `  ${C.dim(it.hint)}` : ''}`;
        process.stdout.write(`${idx === i ? C.inv(` ▸ ${it.label} `) + (it.hint ? `  ${C.dim(it.hint)}` : '') : `   ${line}`}\n`);
      });
      process.stdout.write(`\n${C.dim('↑/↓ move · Enter open · Esc back · q quit')}\n`);
    },
    (str, key, done, render) => {
      if (key.name === 'up' || str === 'k') i = (i - 1 + items.length) % items.length;
      else if (key.name === 'down' || str === 'j') i = (i + 1) % items.length;
      else if (key.name === 'return') return done(items[i]);
      else if (key.name === 'escape' || key.name === 'backspace' || str === 'h') return done(null);
      else if (str === 'q' || (key.ctrl && key.name === 'c')) return done('quit');
      render();
    },
  );
}

async function ask(rl, q) {
  return new Promise((r) => rl.question(q, r));
}

/** Prompt for each property; JSON for arrays and objects; Enter skips optional ones. */
async function fill(tool) {
  const props = tool.schema.properties ?? {};
  const required = new Set(tool.schema.required ?? []);
  process.stdin.setRawMode?.(false);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const args = {};
  try {
    clear();
    process.stdout.write(`${C.bold(tool.title || tool.name)}  ${C.dim(tool.name)}\n${tool.description ?? ''}\n\n`);
    if (!Object.keys(props).length) process.stdout.write(C.dim('(no inputs)\n'));
    for (const [k, s] of Object.entries(props)) {
      const type = s.type ?? (s.anyOf ? s.anyOf.map((x) => x.type).join('|') : 'any');
      const opts = s.enum ? ` [${s.enum.join(', ')}]` : '';
      const hint = `${type}${opts}${required.has(k) ? ', required' : ''}${s.description ? ` - ${s.description}` : ''}`;
      for (;;) {
        const v = (await ask(rl, `${C.cyan(k)} ${C.dim(hint)}\n> `)).trim();
        if (!v) {
          if (required.has(k)) {
            process.stdout.write(C.red('  required\n'));
            continue;
          }
          break;
        }
        try {
          if (type === 'number' || type === 'integer') args[k] = Number(v);
          else if (type === 'boolean') args[k] = /^(y|yes|true|1)$/i.test(v);
          else if (type === 'array' || type === 'object' || String(type).includes('object') || String(type).includes('array')) args[k] = JSON.parse(v);
          else if (v === 'null' && String(type).includes('null')) args[k] = null;
          else args[k] = v;
          break;
        } catch {
          process.stdout.write(C.red('  give JSON here, e.g. ["a","b"] or {"k":"v"}\n'));
        }
      }
    }
    if (!tool.readOnly && 'confirm' in props && args.confirm === undefined) {
      const ok = (await ask(rl, `${C.pink('This changes something. Go ahead?')} [y/N] `)).trim();
      if (/^y/i.test(ok)) args.confirm = true;
    }
  } finally {
    rl.close();
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
  }
  return args;
}

function show(value) {
  const json = JSON.stringify(value, null, 2) ?? String(value);
  return json
    .replace(/"([^"]+)":/g, (_, k) => `${C.cyan(`"${k}"`)}:`)
    .replace(/: "(https?:\/\/[^"]+)"/g, (_, u) => `: ${C.green(`"${u}"`)}`);
}

async function pause() {
  process.stdout.write(`\n${C.dim('press any key')}`);
  await new Promise((r) => process.stdin.once('keypress', () => r()));
}

export async function runTui({ env = process.env } = {}) {
  if (!process.stdin.isTTY) throw new Error('the TUI needs a terminal');
  const auth = await readAuth(env);
  const url = (auth?.url ?? env.AUTOINFLUENCER_URL ?? DEFAULT_URL).replace(/\/$/, '');
  const tools = await loadTools(url);
  const groups = groupTools(tools);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write('\x1b[?1049h'); // alternate screen
  const header = async () => {
    let who = C.red('not signed in: run "autoinfluencer login" (free tools and previews still work)');
    if (auth) {
      try {
        const b = await callRemote('balance', {}, { env });
        who = `${C.green('signed in')} · ${b.plan ?? 'free'} plan · ${Number(b.credits ?? 0).toLocaleString()} credits · ${b.free_left ?? 0} free drafts today`;
      } catch (e) {
        who = C.red(e.message);
      }
    }
    return `${C.pink(C.bold('autoinfluencer'))} ${C.dim(url)}\n${who}`;
  };
  try {
    let head = await header();
    for (;;) {
      const g = await menu('What do you want to work on?', groups.map((x) => ({ label: x.name, hint: `${x.tools.length} tools`, value: x })), head);
      if (!g || g === 'quit') break;
      for (;;) {
        const t = await menu(g.value.name, g.value.tools.map((x) => ({ label: x.title || x.name, hint: x.name, value: x })), head);
        if (t === 'quit') return;
        if (!t) break;
        const args = await fill(t.value);
        clear();
        process.stdout.write(`${C.dim(`calling ${t.value.name}…`)}\n`);
        try {
          const res = await callRemote(t.value.name, args, { env, onWait: () => process.stdout.write('.') });
          clear();
          process.stdout.write(`${C.bold(t.value.title || t.value.name)}\n\n${show(res)}\n`);
        } catch (e) {
          process.stdout.write(`\n${C.red(e.message)}\n`);
        }
        await pause();
        head = await header();
      }
    }
  } finally {
    process.stdout.write('\x1b[?1049l');
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}
