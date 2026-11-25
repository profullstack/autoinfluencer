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
- **Desktop app** (Linux AppImage/deb, macOS dmg, Windows exe) on every [release](https://github.com/profullstack/autoinfluencer/releases/latest): the app in a window plus the bundled CLI (Agents → Show CLI command copies it) and a local MCP server (Agents → Copy MCP config)

Generation runs on the open [c0mpute](https://c0mpute.com) network: free small models without a key,
larger ones with `C0MPUTE_API_KEY`. When no model answers, or with `--brief`, tools return the exact
prompt so the calling agent (Claude, ChatGPT, a c0mpute chat model) writes the posts itself, then lints them.

## The platform (hosted app)

https://influencer.marketing.pit.world is a whole small-business marketing stack you run from your AI
assistant: website hosting, blog, contact forms, newsletter sign-ups, bookings, a shop, static ads,
reels, app captures and scheduled posting to every network. Pricing: https://influencer.marketing.pit.world/pricing

| Plan | Price | Credits | Highlights |
| --- | --- | --- | --- |
| Free | $0 | 400 once | 1 site, 5 pages, blog, 3 forms, newsletter, scheduling; badge; ads watermarked after a 2-ad preview |
| Solo | $49/mo or $490/yr | 3,000/mo | own domain, bookings, shop, reels, no badge or watermark, 25 pages |
| Studio | $149/mo or $1,490/yr | 10,000/mo | 3 brands with their own domains, 3 team seats, 100 pages |
| Agency | from $190/mo + $49/client site | pooled | a workspace per client, your branding, developer MCP/CLI/TUI/API |

1 credit = $0.01. Credits pay only for AI work and desktop jobs: ad 50, reel 500, app capture 200
(refunded if nothing usable comes back), blog post 60, translation 10, post draft 5 after 3 free a day.
Sites, forms, bookings, newsletter, shop orders, scheduling and publishing cost nothing. Top-ups:
1,000 for $10, 2,750 for $25, 6,000 for $50, 13,000 for $100. Everything is paid in crypto through
CoinPay, or per call with x402.

### Every feature on every surface

Every feature is a tool, so each one is an **MCP** tool, a **REST** call (`POST /api/<tool>`, OpenAPI at
`/openapi.json`), a **CLI** command, a **TUI** screen, a panel in the **PWA**, and the same panel in the
**desktop app**.

| Feature | Tools | CLI |
| --- | --- | --- |
| Sites | `site_create` `site_deploy` `site_versions` `site_rollback` `site_domain` `site_settings` `site_publish_c0mpute` `brand_read` `brand_save` | `autoinfluencer site deploy ./dist --site you --yes` |
| Blog and newsletter | `blog_write` `blog_save` `blog_translate` `blog_list` `newsletter_write` | `autoinfluencer call blog_write topic="…" publish=true` |
| Forms, inbox, bookings | `form_save` `inbox` `subscribers` `booking_list` `booking_update` | `autoinfluencer call inbox` |
| Shop | `product_save` `product_list` `order_list` `order_update` | `autoinfluencer call product_save name=Mug price=12` |
| Social | `social_schedule` `social_list` `social_cancel` `social_publish_now` | `autoinfluencer call social_list` |
| Ads and reels | `ad_create` `ad_list` `preview_ads` `reel_create` `reel_status` | `autoinfluencer call ad_create count=3` |
| Desktop environments | `desktop_add` `desktop_list` `desktop_jobs` `desktop_open` `app_capture` | `autoinfluencer desktop connect --token dk_…` |
| Plan and team | `plan_get` `plan_checkout` `credits_history` `team_invite` `team_list` | `autoinfluencer pricing` |

`autoinfluencer tui` opens all of them as menus and forms (built from the live OpenAPI document);
`autoinfluencer tools` lists them; `autoinfluencer call <tool> key=value …` runs any of them.

Customer pages get drop-in components that post into the site's inbox:

```html
<script type="module" src="https://influencer.marketing.pit.world/embed.js"></script>
<ai-form site="you" form="contact"></ai-form>
<ai-newsletter site="you"></ai-newsletter>
<ai-booking site="you"></ai-booking>
<ai-shop site="you"></ai-shop>
<ai-blog-feed site="you" limit="5"></ai-blog-feed>
```

### Where the work runs: c0mpute and your desktop

- **c0mpute** ([c0mpute.com](https://c0mpute.com)): blog posts, translations, ad copy and newsletters are
  written by open models on the c0mpute peer-to-peer network through `@profullstack/ai-providers`; reels
  come from c0mpute's promo-video pipeline; the app itself runs as a c0mpute app; `site_publish_c0mpute`
  mirrors a site to c0mpute hosting with your own key.
- **Your desktop environment** ([w3bs.org/desktop](https://w3bs.org/desktop)): anything that needs a real
  browser (posting to a network, recording your web app, signing in once) runs on a computer you add
  after signing in, through the W3BS Agentic Desktop Layer. No network API keys are needed or stored.

**The two-way connection.** `desktop_add` returns a `dk_` token. On that computer:

```sh
curl -fsSL https://w3bs.org/desktop/install.sh | sh     # once: the W3BS desktop layer
w3bs desktop agents add autoinfluencer --preset broad   # once: an agent token for the connector
w3bs desktop browser launch                             # the agent browser (its own profile)
npx -y @profullstack/autoinfluencer desktop connect --token dk_…
```

1. **Desktop → app:** the connector long-polls `POST /api/v1/desktop/poll` over HTTPS with the token
   (outbound only, no open ports, works behind NAT). The same token is a bearer for `/mcp` and
   `/api/<tool>`, so agents on that computer use every tool as the account.
2. **App → desktop:** jobs (publish a post, open a page, record an app) come back on that poll. The
   connector runs them through the local broker (`127.0.0.1:7801/mcp`), which drives the agent browser
   by DevTools: snapshot, then click and fill by element uid. Results and frames go to
   `POST /api/v1/desktop/result`.
3. The person at the desktop approves the agent once, gets every sign-in, CAPTCHA and payment handed
   to them (`human_step`, never solved by the agent), and can stop everything with Super+Alt+Escape.

The desktop app does the same from its menu (Agents → Connect this computer). Operators can also carry
the app → desktop half over a reverse SSH tunnel: our own fleet runs the server on **dev2**, and the
desktop **bonita** keeps a reverse tunnel (`ssh -N -R …`) open to dev2, so agents on dev2 reach bonita's
desktop layer while bonita's connector polls dev2.

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
