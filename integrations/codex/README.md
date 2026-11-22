# OpenAI Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.autoinfluencer]
command = "npx"
args = ["-y", "@profullstack/autoinfluencer", "mcp"]
```

Skill: copy `skills/autoinfluencer` into `~/.codex/skills/` (or `.agents/skills/` in a repo).

Or add to a repo's `AGENTS.md`:

```md
## Social posts
Use the autoinfluencer MCP tools (or `npx -y @profullstack/autoinfluencer --help`) to draft, lint and
queue social posts. Always run lint; never publish without asking.
```
