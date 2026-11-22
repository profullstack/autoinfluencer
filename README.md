# autoinfluencer

Persona-driven social posts for every network: post ideas, native drafts per platform, repurposing
articles and URLs, value-adding replies, posting calendars, linting against each network's rules,
and a publish queue. One package, every surface:

- **Library** `@profullstack/autoinfluencer`
- **CLI** `autoinfluencer`
- **MCP server** (stdio and streamable HTTP)
- **HTTP API** with an OpenAPI document (ChatGPT Actions)
- **Agent Skill** + **Claude Code plugin**, and guides for ChatGPT, claude.ai, c0mpute, Codex, Cursor
- **Hosted app:** https://influencer.marketing.pit.world (PWA, API, MCP, CLI; CoinPay sign-in; x402 pay per call)
- **Desktop app** (Linux AppImage/deb, macOS dmg, Windows exe) on every [release](https://github.com/profullstack/autoinfluencer/releases/latest): the app in a window plus the bundled CLI (`autoinfluencer --cli …`) and a local MCP server (Agents → Copy MCP config)

Generation runs on the open [c0mpute](https://c0mpute.com) network: free small models without a key,
larger ones with `C0MPUTE_API_KEY`. When no model answers, or with `--brief`, tools return the exact
prompt so the calling agent (Claude, ChatGPT, a c0mpute chat model) writes the posts itself, then lints them.

## Quick start

```sh
npx -y @profullstack/autoinfluencer init          # writes ~/.autoinfluencer/persona.json; edit it
npx -y @profullstack/autoinfluencer ideas "pricing" --count 5
npx -y @profullstack/autoinfluencer draft "how I halved CI time" -p bluesky,linkedin,x
npx -y @profullstack/autoinfluencer repurpose https://example.com/blog/post -p mastodon,threads
npx -y @profullstack/autoinfluencer reply "How do you price a dev tool?" -p bluesky
npx -y @profullstack/autoinfluencer calendar --days 7 --ideas
echo "my post" | npx -y @profullstack/autoinfluencer lint -p x
```

Queue and publish (dry run until `--yes`):

```sh
autoinfluencer queue add "post text" -p bluesky --at 2026-12-01T17:00:00Z
autoinfluencer run          # shows what would go out
autoinfluencer run --yes    # sends due posts, at most one per network per run
```

Put `autoinfluencer run --yes` in cron and the queue is the scheduler. Publishers
(`AUTOINFLUENCER_PUBLISHER`): `stdout` (default), `webhook` (Standard Webhooks signed),
`autopost` ([Crawlproof](https://crawlproof.com/social) connected accounts, `AUTOPOST_TOKEN`),
`myna` ([myna CLI](https://mynaposter.com)).

## Persona

```json
{
  "name": "Ada Builder",
  "niche": "developer tools and indie SaaS",
  "audience": "working developers who want practical tips, not hype",
  "voice": "plain, specific, a little dry; never salesy",
  "pillars": ["build-in-public numbers", "one practical tip", "tool teardowns"],
  "platforms": ["bluesky", "mastodon", "linkedin", "x"],
  "avoid": ["revolutionary", "unlock"],
  "disclose": true,
  "disclosure": "(AI-assisted)",
  "mix": { "own": 0.25 }
}
```

JSON or Markdown with front matter. `mix.own` is the share of original posts; the rest of the calendar
is engagement: genuine replies to other people's posts.

## Honest by default

- Never invents facts, metrics, quotes or testimonials; prompts forbid it and you are asked for them instead.
- Lint flags engagement bait, AI filler, the persona's banned words, duplicates, and hashtag/link misuse.
- Disclosure on original posts unless you turn it off.
- Publishing is always explicit (`--yes`, `confirm: true`), paced per network.

## Agents

| Where | How |
| --- | --- |
| Claude Code | `/plugin marketplace add profullstack/autoinfluencer` then `/plugin install autoinfluencer@autoinfluencer` |
| Any MCP client | `npx -y @profullstack/autoinfluencer mcp` |
| Remote MCP (ChatGPT, claude.ai, c0mpute chat) | `https://influencer.marketing.pit.world/mcp` |
| ChatGPT Custom GPT | Actions from `https://influencer.marketing.pit.world/openapi.json` |

Details per client in [integrations/](integrations/README.md).

## Library

```js
import { draft, lintPost, createTools } from '@profullstack/autoinfluencer';
import { createHandler } from '@profullstack/autoinfluencer/server';

const res = await draft(persona, { topic: 'CI caching', platforms: ['bluesky', 'x'] });
// { mode: 'ai', posts: [{ platform, text, lint: { ok, errors, warnings } }] } or { mode: 'brief', brief }

// Host it with your own auth and payment:
http.createServer(createHandler({ local: false, authenticate, gate }));
```

`createHandler` hooks: `authenticate(req)` returns a context or null (401); `gate(req, res, { tool })`
returns false after writing its own response (for example an x402 `402 Payment Required`).

## Environment

| Variable | Purpose |
| --- | --- |
| `C0MPUTE_API_KEY` | c0mpute account key; without it the free models are used |
| `C0MPUTE_MODELS` | model list, in order |
| `AUTOINFLUENCER_TIMEOUT_MS` | per generation, default 120000, then fall back to a brief |
| `AUTOINFLUENCER_HOME` | persona, queue, config (default `~/.autoinfluencer`) |
| `AUTOINFLUENCER_PUBLISHER` | `stdout`, `webhook`, `autopost`, `myna` |
| `AUTOINFLUENCER_WEBHOOK_URL`, `AUTOINFLUENCER_WEBHOOK_SECRET` | webhook publisher |
| `AUTOPOST_TOKEN` | Crawlproof social API token |

MIT © Profullstack, Inc.
