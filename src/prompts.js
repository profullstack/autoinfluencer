import { getPlatform } from './platforms.js';

/** The persona as the model should read it. */
export function personaBlock(p) {
  const lines = [
    `Name: ${p.name}${p.handle ? ` (${p.handle})` : ''}`,
    p.bio && `Bio: ${p.bio}`,
    `Niche: ${p.niche}`,
    `Audience: ${p.audience}`,
    `Voice: ${p.voice}`,
    `Content pillars:\n${p.pillars.map((x) => `  - ${x}`).join('\n')}`,
    p.cta && `Call to action (use sparingly, at most one post in four): ${p.cta}`,
    Object.keys(p.links ?? {}).length &&
      `Links:\n${Object.entries(p.links).map(([k, v]) => `  - ${k}: ${v}`).join('\n')}`,
    p.avoid?.length && `Never use these words or phrases: ${p.avoid.join(', ')}`,
    p.examples?.length &&
      `Posts in this voice (match the style, never copy):\n${p.examples.map((x) => `  > ${x}`).join('\n')}`,
  ];
  return lines.filter(Boolean).join('\n');
}

const RULES = `Rules for every post:
- Write as the persona, in first person, for the stated audience. Specific beats general: numbers, names, steps.
- One idea per post. The first line is the hook and must stand alone.
- No engagement bait ("like and share", "follow for more", "comment below"), no fake urgency, no invented facts, metrics, quotes or testimonials. If a fact is not given, do not state it.
- No AI filler ("delve", "game-changer", "in today's fast-paced world", "unleash").
- Respect each platform's length, hashtag and link conventions given below.`;

function platformBlock(ids) {
  return ids
    .map((id) => {
      const s = getPlatform(id);
      const bits = [
        `${s.id}: max ${s.limit} characters (aim for about ${s.ideal})`,
        s.title && `title max ${s.title}`,
        `hashtags: ${s.hashtags.max === 0 ? 'none' : `at most ${s.hashtags.max}, ${s.hashtags.style}`}`,
        `links: ${s.links.max === 0 ? 'none (not clickable)' : `at most ${s.links.max}`}`,
      ];
      return `- ${bits.filter(Boolean).join('; ')}. ${s.notes}`;
    })
    .join('\n');
}

export function ideasPrompt(p, { count, topic, pillar }) {
  return {
    system: `You are the content strategist for this creator.\n\n${personaBlock(p)}\n\n${RULES}`,
    user: [
      `Give ${count} distinct post ideas${topic ? ` about: ${topic}` : ''}${pillar ? ` under the pillar "${pillar}"` : ''}.`,
      'Spread them across the pillars and formats (tip, story, teardown, question, list, behind-the-scenes, hot take with evidence).',
      'Return JSON: {"ideas":[{"hook":"the opening line as it would be posted","angle":"what the post says, one sentence","pillar":"which pillar","format":"tip|story|teardown|question|list|bts|take"}]}',
    ].join('\n'),
  };
}

export function draftPrompt(p, { topic, source, link, platforms }) {
  return {
    system: `You are ghostwriting social posts for this creator.\n\n${personaBlock(p)}\n\n${RULES}\n\nPlatforms:\n${platformBlock(platforms)}`,
    user: [
      topic && `Topic or idea: ${topic}`,
      source && `Source material (repurpose it; keep facts exactly, add nothing that is not in it):\n"""\n${source}\n"""`,
      link && `Link to include where the platform allows it: ${link}`,
      `Write one native post for each platform: ${platforms.join(', ')}. Each must be written for that platform, not a copy resized.`,
      'Return JSON: {"posts":[{"platform":"<id>","title":"only for platforms that need a title","text":"the post"}]}',
    ]
      .filter(Boolean)
      .join('\n\n'),
  };
}

export function replyPrompt(p, { post, platform, author, goal }) {
  const s = getPlatform(platform);
  return {
    system: `You write replies as this creator.\n\n${personaBlock(p)}\n\nReply rules:\n- Add something real: an answer, a data point, a counter-example, a resource name, or a sharp question.\n- No self-promotion and no link unless the post explicitly asks for a tool or resource and ours genuinely fits; then say plainly that it is ours.\n- Never flatter ("Great post!"). Never pretend to agree. Keep it under ${Math.min(s.limit, 400)} characters for ${s.name}.`,
    user: [
      `Post${author ? ` by ${author}` : ''} on ${s.name}:\n"""\n${post}\n"""`,
      goal && `Goal for this reply: ${goal}`,
      'Return JSON: {"text":"the reply","why":"one sentence on what value it adds"}',
    ]
      .filter(Boolean)
      .join('\n\n'),
  };
}

/** The prompt rendered as one Markdown block for a host model (brief mode). */
export function asBrief(prompt) {
  return `${prompt.system}\n\n---\n\n${prompt.user}`;
}
