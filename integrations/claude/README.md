# Claude

## Claude Code: plugin (skill + MCP server)

```
/plugin marketplace add profullstack/autoinfluencer
/plugin install autoinfluencer@autoinfluencer
```

That installs the `autoinfluencer` skill and starts the MCP server with `npx -y @profullstack/autoinfluencer mcp`.
Then ask: "set up my persona", "draft a LinkedIn and Bluesky post about X", "repurpose https://... into posts",
"plan next week".

Only the MCP server, without the plugin:

```
claude mcp add autoinfluencer -- npx -y @profullstack/autoinfluencer mcp
```

Only the skill: copy `skills/autoinfluencer` into `~/.claude/skills/` (or `.claude/skills/` in a repo).

## Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "autoinfluencer": { "command": "npx", "args": ["-y", "@profullstack/autoinfluencer", "mcp"] }
  }
}
```

## claude.ai (web, desktop, mobile)

- **Connector:** Settings → Connectors → Add custom connector →
  `https://influencer.marketing.pit.world/mcp`. Sign in with CoinPay when asked.
- **Skill:** Settings → Capabilities → Skills → Upload `autoinfluencer-skill.zip` from the
  [latest release](https://github.com/profullstack/autoinfluencer/releases/latest).

With no connector, the skill still works: Claude follows the workflow and platform rules itself.
