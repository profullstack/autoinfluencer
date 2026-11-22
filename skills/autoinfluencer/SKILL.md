---
name: autoinfluencer
description: Run a creator's or brand's social presence from a persona - post ideas, native drafts per network (X, Bluesky, Mastodon, Threads, LinkedIn, Reddit, Hacker News, Instagram, TikTok, YouTube, newsletter), repurposing a URL or article into posts, value-adding replies to other people's posts, a posting calendar, linting against platform rules, and a publish queue. Use when asked to write, plan, schedule, repurpose or reply to social posts, grow an audience, build a content calendar, or "be my influencer / ghostwriter / social media manager".
---

# autoinfluencer

Writes social posts in one persona's voice, native to each network, and keeps them honest:
no invented facts or metrics, no engagement bait, disclosure kept on when the persona asks for it,
and most activity spent adding value to other people's posts rather than broadcasting.

## Tools: use whichever is available

1. **MCP tools** named `ideas`, `draft`, `repurpose`, `reply`, `calendar`, `lint`, `platforms`,
   `persona_template`, and locally `persona_get`, `persona_save`, `queue_add`, `queue_list`, `publish_due`.
2. **CLI**, if there is a shell: `npx -y @profullstack/autoinfluencer <command>` (same names; `--json` for
   machine output, `--brief` to get the prompt instead of calling a model).
3. **Neither**: follow the workflow below by hand, using the platform rules table at the end.

## Workflow

1. **Persona first.** Load it (`persona_get`, or `npx -y @profullstack/autoinfluencer persona`). If none
   exists, ask the user 5 quick questions (who you are, niche, audience, voice in 3 adjectives, 3-5 content
   pillars, which networks) and fill `persona_template`; save it with `persona_save` when local.
   Pass the persona object inline on hosted servers.
2. **Ideas** -> pick with the user -> **draft** (or **repurpose** a URL/text, or **reply** to a post they paste).
3. **Write it yourself when the tool returns a brief.** Generation tools take `mode`:
   `auto` writes on the c0mpute network and falls back to a brief if no model answers; `brief` always
   returns the prompt. When you get a brief, you are the writer: follow it exactly and return JSON-shaped posts.
4. **Always lint** every post you wrote or edited (`lint`). Fix every error; weigh warnings.
5. **Calendar**: `calendar` gives slots split 25% original posts / 75% engagement by default. For engage
   slots, find a real post in the niche and draft a `reply` that adds an answer, data point or question.
6. **Publishing is the user's call.** `queue_add` with times, then `publish_due` runs as a dry run;
   only pass `confirm: true` (CLI `run --yes`) after the user says go. Never post on their behalf otherwise.

## Rules that matter

- Write native to each network: a LinkedIn post is not a long tweet. One idea per post; the first line is the hook.
- Never invent numbers, quotes, customers or results. If the user did not give it, ask or leave it out.
- No bait ("like and share", "follow for more", "comment below"), no fake urgency, no AI filler words
  ("delve", "game-changer", "unleash", "in today's fast-paced world").
- Keep `persona.disclosure` (default "(AI-assisted)") on original posts when `persona.disclose` is true.
- Replies: no self-promotion and no link unless the post asks for a tool and ours genuinely fits; say it is ours.
- Respect each network's rules and terms. Never create fake accounts, buy engagement, or coordinate inauthentic activity.

## Platform rules (graphemes)

| Network | Max | Aim | Hashtags | Notes |
| --- | --- | --- | --- | --- |
| x | 280 | 220 | ≤2 | hook first line; link in a reply for reach |
| bluesky | 300 | 240 | ≤2 | conversational, anti-marketing |
| mastodon | 500 | 400 | ≤4 trailing, CamelCase | hashtags = discovery; alt text |
| threads | 500 | 300 | 1 | question-led |
| linkedin | 3000 | 1200 | ≤3 trailing | hook in first 210 chars |
| reddit | 40000 | 1500 | none | title ≤300, subreddit, disclose it's yours |
| hackernews | 4000 | 600 | none | title ≤80, plain, no hype |
| instagram | 2200 | 600 | ≤5 | needs media; links not clickable |
| tiktok | 2200 | 150 | ≤4 | caption + 3-beat script |
| youtube | 5000 | 800 | ≤3 | title ≤100 (60 shows) |

More: `platforms` tool. Source and docs: https://github.com/profullstack/autoinfluencer
