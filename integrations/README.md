# Use autoinfluencer from any agent

Two ways to connect, everywhere:

- **Local (free, private):** run the MCP server on your machine with
  `npx -y @profullstack/autoinfluencer mcp` (stdio). Your persona, queue and publishing stay local.
- **Hosted:** `https://influencer.marketing.pit.world/mcp` (MCP streamable HTTP) and
  `https://influencer.marketing.pit.world/openapi.json` (REST). Sign in with CoinPay; calls are
  paid per use over x402. Nothing to install.

| Client | Guide |
| --- | --- |
| Claude Code, Claude Desktop, claude.ai | [claude/](claude/README.md) |
| ChatGPT (connectors / apps, Custom GPT actions) | [chatgpt/](chatgpt/README.md) |
| c0mpute chat and c0mpute apps | [c0mpute/](c0mpute/README.md) |
| OpenAI Codex CLI | [codex/](codex/README.md) |
| Cursor, VS Code, Windsurf, Zed | [cursor/](cursor/README.md) |

The skill in [`skills/autoinfluencer/SKILL.md`](../skills/autoinfluencer/SKILL.md) follows the open
Agent Skills format, so any agent that reads `SKILL.md` folders (Claude, Codex, OpenCode, Goose, ...) can use it.
