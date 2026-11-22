# Cursor, VS Code, Windsurf, Zed

Every MCP-capable editor takes the same stdio command.

**Cursor**, `~/.cursor/mcp.json` · **Windsurf**, `~/.codeium/windsurf/mcp_config.json`:

```json
{ "mcpServers": { "autoinfluencer": { "command": "npx", "args": ["-y", "@profullstack/autoinfluencer", "mcp"] } } }
```

**VS Code**, `.vscode/mcp.json`:

```json
{ "servers": { "autoinfluencer": { "type": "stdio", "command": "npx", "args": ["-y", "@profullstack/autoinfluencer", "mcp"] } } }
```

**Zed**, `settings.json`:

```json
{ "context_servers": { "autoinfluencer": { "command": { "path": "npx", "args": ["-y", "@profullstack/autoinfluencer", "mcp"] } } } }
```

Hosted alternative (no install): `https://influencer.marketing.pit.world/mcp`.
