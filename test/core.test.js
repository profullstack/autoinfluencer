import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import {
  graphemes, truncate, toThread, platformId, getPlatform,
  normalizePersona, parsePersona, examplePersona,
  lintPost, withDisclosure,
  draft, ideas, reply, calendar, isPrivateIp,
  enqueue, listQueue, runDue,
  signWebhook, createTools, inputJsonSchema,
} from '../src/index.js';

const persona = examplePersona();
const mockAi = (object) => ({ generateObject: async (req) => ({ object: req.schema ? req.schema(object) : object, provider: 'mock', model: 'm' }) });

test('graphemes count emoji once and truncate respects the limit', () => {
  assert.equal(graphemes('👍🏽ok'), 3);
  const t = truncate('word '.repeat(100), 50);
  assert.ok(graphemes(t) <= 50);
  assert.ok(t.endsWith('…'));
});

test('platform aliases resolve and unknown names throw', () => {
  assert.equal(platformId('Twitter'), 'x');
  assert.equal(platformId('bsky'), 'bluesky');
  assert.throws(() => platformId('myspace'), /unknown platform/);
});

test('toThread splits within the limit and numbers parts', () => {
  const parts = toThread('This is a sentence. '.repeat(60), 'x');
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(graphemes(p) <= getPlatform('x').limit);
  assert.match(parts[0], /1\/\d+$/);
});

test('persona validation lists every missing field', () => {
  assert.throws(() => normalizePersona({ name: 'x' }), (e) => e.problems.length >= 3);
  const p = normalizePersona({ ...persona, platforms: ['twitter', 'x'], mix: { own: 0.4 } });
  assert.deepEqual(p.platforms, ['x']);
  assert.equal(p.mix.engage, 0.6);
});

test('markdown persona front matter parses lists, booleans and body', () => {
  const p = parsePersona(`---\nname: Sam\nniche: woodworking\naudience: hobbyists\nvoice: warm\ndisclose: false\npillars:\n  - shop tips\n  - project builds\n---\nI build furniture.`);
  assert.equal(p.disclose, false);
  assert.deepEqual(p.pillars, ['shop tips', 'project builds']);
  assert.equal(p.bio, 'I build furniture.');
  assert.ok(normalizePersona(p));
});

test('lint catches limits, hashtags, bait, avoid list, disclosure and duplicates', () => {
  const p = normalizePersona(persona);
  const long = lintPost({ platform: 'x', text: 'a'.repeat(300) }, p);
  assert.ok(long.errors.some((e) => e.includes('over the X limit')));
  const r = lintPost({ platform: 'hackernews', text: 'Like and share #wow this is revolutionary' }, p);
  assert.ok(r.errors.some((e) => e.includes('needs a title')));
  assert.ok(r.errors.some((e) => e.includes('hashtags')));
  assert.ok(r.errors.some((e) => e.includes('revolutionary')));
  assert.ok(r.errors.some((e) => e.includes('disclosure')));
  assert.ok(r.warnings.some((w) => w.includes('like and share')));
  const ok = lintPost({ platform: 'bluesky', text: withDisclosure('Cached node_modules per lockfile hash; CI went 9m to 4m.', p, 'bluesky') }, p);
  assert.equal(ok.ok, true, ok.errors.join());
  const dup = lintPost({ platform: 'bluesky', text: 'Same post (AI-assisted)' }, p, { recent: ['same POST! (AI-assisted)'] });
  assert.ok(dup.errors.includes('duplicate of a recent post'));
  assert.equal(lintPost({ platform: 'bluesky', kind: 'engage', text: 'Try a lockfile-keyed cache.' }, p).ok, true);
});

test('draft with a model returns finished, linted, disclosed posts', async () => {
  const res = await draft(persona, {
    topic: 'CI caching',
    platforms: ['bluesky', 'x'],
    ai: mockAi({ posts: [{ platform: 'bluesky', text: 'Keyed the cache on the lockfile hash. CI: 9m to 4m.' }, { platform: 'twitter', text: 'Lockfile-hash cache keys halved my CI.' }, { platform: 'myspace', text: 'drop me' }] }),
  });
  assert.equal(res.mode, 'ai');
  assert.deepEqual(res.posts.map((p) => p.platform), ['bluesky', 'x']);
  for (const p of res.posts) {
    assert.ok(p.text.includes('(AI-assisted)'));
    assert.equal(p.lint.ok, true, p.lint.errors.join());
  }
});

test('brief mode never calls the model; auto falls back to a brief on failure', async () => {
  const boom = { generateObject: async () => { throw new Error('down'); } };
  const b = await draft(persona, { topic: 't', mode: 'brief', ai: boom });
  assert.equal(b.mode, 'brief');
  assert.match(b.brief, /Ada Builder/);
  const f = await ideas(persona, { ai: boom });
  assert.equal(f.mode, 'brief');
  assert.match(f.note, /down/);
  await assert.rejects(ideas(persona, { ai: boom, mode: 'ai' }), /down/);
});

test('reply is an engage post without the disclosure requirement', async () => {
  const r = await reply(persona, { post: 'How do you speed up CI?', platform: 'bluesky', ai: mockAi({ text: 'Key the dependency cache on the lockfile hash.', why: 'concrete step' }) });
  assert.equal(r.kind, 'engage');
  assert.equal(r.lint.ok, true);
});

test('calendar honours the own/engage mix', async () => {
  const { slots } = await calendar(persona, { days: 8, perDay: 3, start: '2026-12-01T00:00:00Z' });
  assert.equal(slots.length, 24);
  assert.equal(slots.filter((s) => s.kind === 'own').length, 6);
  assert.equal(slots[0].at, '2026-12-01T09:00:00.000Z');
});

test('private addresses are refused for hosted fetches', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '169.254.169.254', '172.20.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1']) assert.ok(isPrivateIp(ip), ip);
  for (const ip of ['1.1.1.1', '172.32.0.1', '2606:4700::1111']) assert.ok(!isPrivateIp(ip), ip);
});

test('queue drains due posts, one per platform per run, and dry runs change nothing', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ai-q-')), 'q.jsonl');
  const now = new Date('2026-12-01T12:00:00Z');
  await enqueue([
    { platform: 'bluesky', text: 'one', at: '2026-12-01T10:00:00Z' },
    { platform: 'bluesky', text: 'two', at: '2026-12-01T11:00:00Z' },
    { platform: 'x', text: 'three', at: '2026-12-01T11:00:00Z' },
    { platform: 'x', text: 'later', at: '2026-12-02T11:00:00Z' },
  ], { path, now });
  const dry = await runDue(async () => ({}), { path, now, dryRun: true });
  assert.equal(dry.length, 2);
  assert.equal((await listQueue({ path, status: 'queued' })).length, 4);
  const sent = [];
  await runDue(async (i) => (sent.push(i.text), { ok: true }), { path, now });
  assert.deepEqual(sent, ['one', 'three']);
  let calls = 0;
  await runDue(async () => { calls++; throw new Error('nope'); }, { path, now, maxAttempts: 1 });
  assert.equal(calls, 1);
  assert.equal((await listQueue({ path, status: 'failed' }))[0].text, 'two');
});

test('webhook signatures follow Standard Webhooks', () => {
  const secret = 'whsec_' + Buffer.from('k3y').toString('base64');
  const h = signWebhook(secret, '{"a":1}', { id: 'msg_1', timestamp: 1700000000 });
  const want = createHmac('sha256', 'k3y').update('msg_1.1700000000.{"a":1}').digest('base64');
  assert.equal(h['webhook-signature'], `v1,${want}`);
});

test('tool registry: hosted mode hides local tools and every input has a JSON schema', () => {
  const local = createTools({ local: true }).map((t) => t.name);
  const hosted = createTools({ local: false });
  assert.ok(local.includes('publish_due'));
  assert.ok(!hosted.some((t) => ['publish_due', 'queue_add', 'persona_save'].includes(t.name)));
  for (const t of hosted) assert.equal(inputJsonSchema(t).type, 'object');
});
