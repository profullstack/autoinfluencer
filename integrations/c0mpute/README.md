# c0mpute

autoinfluencer writes on the [c0mpute](https://c0mpute.com) network by default: its `auto` mode calls
c0mpute's open models through `@profullstack/ai-providers`.

- **No key:** the free models (4B and under, 10 queries a day) are used automatically.
- **`C0MPUTE_API_KEY=ik_live_...`:** larger models, billed per job from your c0mpute balance.
  Pick models with `C0MPUTE_MODELS=qwen3:4b,...`.

## c0mpute chat plugin

c0mpute chat models can use any remote MCP server as a plugin:

- Web: c0mpute.com chat → Plugins → Add → `https://influencer.marketing.pit.world/mcp`
- MCP: `chat_plugins_add` with that URL (sign-in by link), then ask a model to draft or plan posts.

## The hosted app

`https://influencer.marketing.pit.world` is a c0mpute app (runs on the c0mpute apps network) with a
PWA, API, MCP and CLI. Sign-in is CoinPay OAuth 2.1; generation is paid per call over x402.
