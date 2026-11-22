# ChatGPT

## Connector / app (MCP)

ChatGPT connects to remote MCP servers (Settings → Apps & Connectors → Advanced → Developer mode,
then Create):

- **URL:** `https://influencer.marketing.pit.world/mcp`
- **Authentication:** OAuth (sign in with CoinPay)

The tools (`ideas`, `draft`, `repurpose`, `reply`, `calendar`, `lint`, `platforms`, `persona_template`)
then show up in any chat. Read-only tools are marked so ChatGPT will not ask to confirm them.

To use your own machine instead, run `npx -y @profullstack/autoinfluencer serve --host 0.0.0.0` behind
an HTTPS tunnel and point the connector at `<tunnel>/mcp`.

## Custom GPT (Actions)

1. Explore GPTs → Create → Configure.
2. **Instructions:** paste [`gpt-instructions.md`](gpt-instructions.md).
3. **Actions → Create new action → Import from URL:**
   `https://influencer.marketing.pit.world/openapi.json`
4. **Authentication:** OAuth. Authorization URL `https://influencer.marketing.pit.world/oauth/authorize`,
   token URL `https://influencer.marketing.pit.world/oauth/token`, scope `influencer`.
   Client ID and secret: register at `https://influencer.marketing.pit.world/oauth/register`.
5. Add the callback URL ChatGPT shows you back to the client registration.
