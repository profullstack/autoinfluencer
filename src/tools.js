import { z } from 'zod';
import { loadPersona, savePersona, examplePersona, normalizePersona } from './persona.js';
import { listPlatforms } from './platforms.js';
import { lintPost } from './lint.js';
import { ideas, draft, repurpose, reply, calendar } from './generate.js';
import { enqueue, listQueue, runDue, recentTexts } from './queue.js';
import { loadConfig, createPublisher } from './publishers.js';

/**
 * One registry of tools, used by every surface: the MCP server (stdio and HTTP), the
 * HTTP API and its OpenAPI document (ChatGPT Actions), and the hosted app.
 *
 * createTools({ local: true }) adds the tools that touch this machine: the persona file,
 * the queue and publishing. Hosted deployments use local: false and pass the persona
 * inline (or through `resolvePersona`).
 */

const persona = z
  .record(z.string(), z.any())
  .optional()
  .describe('The persona object (name, niche, audience, voice, pillars, platforms, ...). Omit to use the saved persona.');
const mode = z
  .enum(['auto', 'ai', 'brief'])
  .optional()
  .describe('auto: write with c0mpute, falling back to a brief. ai: c0mpute or error. brief: return the prompt so you write it yourself, then call lint.');
const platforms = z.array(z.string()).optional().describe('Platform ids, e.g. ["bluesky","linkedin","x"]. Defaults to the persona platforms.');
const postIn = z.object({
  platform: z.string(),
  text: z.string(),
  title: z.string().optional(),
  subreddit: z.string().optional(),
  kind: z.enum(['own', 'engage']).optional(),
  at: z.string().optional().describe('ISO time to publish (queue only)'),
});

export function createTools({ local = true, ai, resolvePersona, blockPrivate = !local, env = process.env } = {}) {
  const getPersona = async (input, ctx) => {
    if (resolvePersona) return resolvePersona(input, ctx);
    if (input && Object.keys(input).length) return normalizePersona(input);
    if (!local) throw new Error('pass a persona object');
    return loadPersona(undefined, env);
  };
  const gen = (args) => ({ mode: args.mode, ai, blockPrivate });

  /** @type {Array<{name:string,title:string,description:string,input:Record<string,z.ZodTypeAny>,annotations?:object,handler:(args:any,ctx?:any)=>Promise<any>}>} */
  const tools = [
    {
      name: 'platforms',
      title: 'Platform rules',
      description: 'Length limits, hashtag and link conventions and style notes for every supported network.',
      input: {},
      annotations: { readOnlyHint: true },
      handler: async () => ({ platforms: listPlatforms() }),
    },
    {
      name: 'persona_template',
      title: 'Persona template',
      description: 'An example persona to fill in. A persona is who is posting: niche, audience, voice, content pillars, platforms, words to avoid, disclosure.',
      input: {},
      annotations: { readOnlyHint: true },
      handler: async () => ({ persona: examplePersona() }),
    },
    {
      name: 'ideas',
      title: 'Post ideas',
      description: 'Generate post ideas (hook, angle, pillar, format) for the persona, optionally about a topic or pillar.',
      input: { persona, topic: z.string().optional(), pillar: z.string().optional(), count: z.number().int().min(1).max(50).optional(), mode },
      annotations: { readOnlyHint: true, openWorldHint: true },
      handler: async (a, ctx) => ideas(await getPersona(a.persona, ctx), { ...gen(a), topic: a.topic, pillar: a.pillar, count: a.count }),
    },
    {
      name: 'draft',
      title: 'Draft posts',
      description: 'Write one native post per platform from a topic or idea, in the persona voice, linted against platform rules.',
      input: { persona, topic: z.string().describe('What the post is about'), link: z.string().optional(), platforms, mode },
      annotations: { readOnlyHint: true, openWorldHint: true },
      handler: async (a, ctx) => draft(await getPersona(a.persona, ctx), { ...gen(a), topic: a.topic, link: a.link, platforms: a.platforms }),
    },
    {
      name: 'repurpose',
      title: 'Repurpose content',
      description: 'Turn a URL or a block of text (article, changelog, transcript, release notes) into native posts for each platform.',
      input: { persona, url: z.string().optional(), text: z.string().optional(), platforms, mode },
      annotations: { readOnlyHint: true, openWorldHint: true },
      handler: async (a, ctx) => repurpose(await getPersona(a.persona, ctx), { ...gen(a), url: a.url, text: a.text, platforms: a.platforms }),
    },
    {
      name: 'reply',
      title: 'Reply to a post',
      description: "Draft a reply to someone else's post that adds real value (an answer, data point or question), in the persona voice. No self-promotion unless asked.",
      input: { persona, post: z.string(), platform: z.string().optional(), author: z.string().optional(), goal: z.string().optional(), mode },
      annotations: { readOnlyHint: true, openWorldHint: true },
      handler: async (a, ctx) => reply(await getPersona(a.persona, ctx), { ...gen(a), post: a.post, platform: a.platform, author: a.author, goal: a.goal }),
    },
    {
      name: 'calendar',
      title: 'Posting calendar',
      description: 'A posting schedule: slots per day at the persona posting hours, split between original posts and engagement (default 25/75), rotating platforms and pillars.',
      input: { persona, days: z.number().int().min(1).max(90).optional(), perDay: z.number().int().min(1).max(24).optional(), start: z.string().optional(), withIdeas: z.boolean().optional(), mode },
      annotations: { readOnlyHint: true },
      handler: async (a, ctx) => calendar(await getPersona(a.persona, ctx), { ...gen(a), days: a.days, perDay: a.perDay, start: a.start, withIdeas: a.withIdeas }),
    },
    {
      name: 'lint',
      title: 'Check posts',
      description: 'Check posts against platform limits, hashtag/link conventions, bait and filler phrases, the persona avoid list and the disclosure rule. Run on every post you write yourself.',
      input: { persona, posts: z.array(postIn) },
      annotations: { readOnlyHint: true },
      handler: async (a, ctx) => {
        let p = null;
        try {
          p = await getPersona(a.persona, ctx);
        } catch {
          /* lint works without a persona */
        }
        const recent = local ? await recentTexts().catch(() => []) : [];
        return { results: a.posts.map((post) => ({ platform: post.platform, ...lintPost(post, p, { recent }) })) };
      },
    },
  ];

  if (local) {
    tools.push(
      {
        name: 'persona_get',
        title: 'Saved persona',
        description: 'Read the saved persona (~/.autoinfluencer/persona.json).',
        input: {},
        annotations: { readOnlyHint: true },
        handler: async () => ({ persona: await loadPersona(undefined, env) }),
      },
      {
        name: 'persona_save',
        title: 'Save persona',
        description: 'Validate and save the persona used by default.',
        input: { persona: z.record(z.string(), z.any()) },
        handler: async (a) => ({ saved: await savePersona(a.persona), persona: normalizePersona(a.persona) }),
      },
      {
        name: 'queue_add',
        title: 'Queue posts',
        description: 'Add finished posts to the local queue with a publish time. Nothing is sent until publish_due runs with confirm: true.',
        input: { posts: z.array(postIn) },
        handler: async (a) => ({ queued: await enqueue(a.posts) }),
      },
      {
        name: 'queue_list',
        title: 'List queue',
        description: 'List queued, sent and failed posts.',
        input: { status: z.enum(['queued', 'sent', 'failed']).optional() },
        annotations: { readOnlyHint: true },
        handler: async (a) => ({ items: await listQueue({ status: a.status }) }),
      },
      {
        name: 'publish_due',
        title: 'Publish due posts',
        description: 'Send queued posts whose time has come through the configured publisher (stdout, webhook, autopost, myna), at most one per platform per run. Dry run unless confirm is true. Ask the user before confirming.',
        input: { confirm: z.boolean().optional(), limit: z.number().int().min(1).max(50).optional() },
        annotations: { destructiveHint: true, openWorldHint: true },
        handler: async (a) => {
          const config = await loadConfig(env);
          const publish = createPublisher(config, { log: () => {} });
          const report = await runDue(publish, { dryRun: !a.confirm, limit: a.limit });
          return { publisher: config.publisher, dryRun: !a.confirm, report };
        },
      },
    );
  }
  return tools;
}

/** JSON Schema for a tool's input (for OpenAPI and plain HTTP clients). */
export function inputJsonSchema(tool) {
  const schema = z.toJSONSchema(z.object(tool.input));
  delete schema.$schema;
  return schema;
}
