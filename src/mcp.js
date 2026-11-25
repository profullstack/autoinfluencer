import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTools } from './tools.js';

export const VERSION = '0.3.1';

const INSTRUCTIONS = `autoinfluencer writes social posts in a persona's voice for each network and keeps them honest.
Flow: get or build a persona (persona_get / persona_template), then ideas -> draft (or repurpose a URL/text, or reply to someone else's post) -> lint -> queue_add -> publish_due.
Generation tools take mode: "auto" writes on the c0mpute network and falls back to a brief; "brief" returns the prompt so YOU write the posts, then call lint on them.
Never publish without the user's explicit go-ahead: publish_due is a dry run unless confirm is true. Keep the persona disclosure on posts when persona.disclose is true. Default mix is 25% own posts, 75% genuine replies to others.`;

/**
 * An MCP server exposing the autoinfluencer tools.
 * @param {object} [opts] createTools options plus { tools, onCall(tool, args, ctx) }
 */
export function createMcpServer(opts = {}) {
  const server = new McpServer(
    { name: 'autoinfluencer', title: 'autoinfluencer', version: VERSION },
    { instructions: INSTRUCTIONS },
  );
  const tools = opts.tools ?? createTools(opts);
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.input, annotations: tool.annotations },
      async (args, extra) => {
        try {
          const ctx = { ...(opts.context ?? {}), authInfo: extra?.authInfo };
          if (opts.onCall) await opts.onCall(tool, args, ctx);
          const result = await tool.handler(args ?? {}, ctx);
          return {
            content: [{ type: 'text', text: render(result) }],
            structuredContent: result && typeof result === 'object' && !Array.isArray(result) ? result : { result },
          };
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: String(err?.message ?? err) }] };
        }
      },
    );
  }
  return server;
}

/** Briefs read better as Markdown than as an escaped JSON string. */
function render(result) {
  if (result?.mode === 'brief' && result.brief) {
    return `${result.note ? `${result.note}\n\n` : ''}Write the posts yourself from this brief, then call lint.\n\n${result.brief}`;
  }
  return JSON.stringify(result, null, 2);
}

/** Serve over stdio (Claude Code, Claude Desktop, Codex, Cursor, any local MCP client). */
export async function serveStdio(opts = {}) {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const server = createMcpServer(opts);
  await server.connect(new StdioServerTransport());
  return server;
}

/**
 * Handle one streamable-HTTP MCP request statelessly (a fresh server per request), so
 * it scales horizontally and works behind any proxy.
 */
export async function handleMcpHttp(req, res, body, opts = {}) {
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const server = createMcpServer(opts);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
