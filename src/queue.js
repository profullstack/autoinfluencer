import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homeDir } from './persona.js';
import { platformId } from './platforms.js';

/**
 * A plain JSON-lines queue on disk ($AUTOINFLUENCER_HOME/queue.jsonl). Each line is
 * one post: { id, at, platform, text, title?, subreddit?, status, attempts, result?, error? }.
 * status: queued -> sent | failed. `autoinfluencer run` sends what is due, so a cron
 * line (or systemd timer) is the whole scheduler.
 */
export function queuePath(env = process.env) {
  return join(homeDir(env), 'queue.jsonl');
}

export async function readQueue(path = queuePath()) {
  if (!existsSync(path)) return [];
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

async function writeQueue(items, path) {
  await mkdir(join(path, '..'), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, items.map((x) => JSON.stringify(x)).join('\n') + (items.length ? '\n' : ''));
  await rename(tmp, path);
}

/** Add posts. `at` defaults to now. Returns the stored items. */
export async function enqueue(posts, { path = queuePath(), now = new Date() } = {}) {
  const items = await readQueue(path);
  const added = (Array.isArray(posts) ? posts : [posts]).map((p) => {
    if (!p?.text) throw new Error('each queued post needs text');
    return {
      id: p.id ?? randomUUID(),
      at: new Date(p.at ?? now).toISOString(),
      platform: platformId(p.platform),
      text: p.text,
      ...(p.title ? { title: p.title } : {}),
      ...(p.subreddit ? { subreddit: p.subreddit } : {}),
      ...(p.thread ? { thread: p.thread } : {}),
      kind: p.kind ?? 'own',
      status: 'queued',
      attempts: 0,
      createdAt: now.toISOString(),
    };
  });
  await writeQueue([...items, ...added], path);
  return added;
}

export async function listQueue({ path = queuePath(), status } = {}) {
  const items = await readQueue(path);
  return status ? items.filter((x) => x.status === status) : items;
}

/** Texts sent in the last `days`, for duplicate checks. */
export async function recentTexts({ path = queuePath(), days = 30, now = new Date() } = {}) {
  const since = now.getTime() - days * 864e5;
  return (await readQueue(path))
    .filter((x) => x.status !== 'failed' && new Date(x.at).getTime() >= since)
    .map((x) => x.text);
}

export async function removeFromQueue(id, { path = queuePath() } = {}) {
  const items = await readQueue(path);
  const next = items.filter((x) => x.id !== id);
  await writeQueue(next, path);
  return items.length - next.length;
}

/**
 * Send every queued item whose time has come. `publish(item)` returns a result or throws.
 * At most `limit` items per run and at most `perPlatform` per platform per run, so a
 * backlog drains at a human pace instead of all at once.
 */
export async function runDue(publish, { path = queuePath(), now = new Date(), limit = 10, perPlatform = 1, maxAttempts = 3, dryRun = false } = {}) {
  const items = await readQueue(path);
  const due = items
    .filter((x) => x.status === 'queued' && new Date(x.at) <= now)
    .sort((a, b) => a.at.localeCompare(b.at));
  const used = {};
  const report = [];
  for (const item of due) {
    if (report.length >= limit) break;
    if ((used[item.platform] ?? 0) >= perPlatform) continue;
    used[item.platform] = (used[item.platform] ?? 0) + 1;
    if (dryRun) {
      report.push({ id: item.id, platform: item.platform, status: 'would-send', text: item.text });
      continue;
    }
    item.attempts++;
    try {
      item.result = await publish(item);
      item.status = 'sent';
      item.sentAt = new Date().toISOString();
      delete item.error;
    } catch (err) {
      item.error = String(err?.message ?? err);
      if (item.attempts >= maxAttempts) item.status = 'failed';
    }
    report.push({ id: item.id, platform: item.platform, status: item.status, error: item.error, result: item.result });
  }
  if (!dryRun) await writeQueue(items, path);
  return report;
}
