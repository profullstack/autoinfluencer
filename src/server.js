import { createServer } from 'node:http';
import { createTools, inputJsonSchema } from './tools.js';
import { handleMcpHttp, VERSION } from './mcp.js';

/**
 * The HTTP surface:
 *   GET  /health
 *   GET  /openapi.json      OpenAPI 3.1 for ChatGPT GPT Actions and plain HTTP clients
 *   POST /api/<tool>        JSON body = tool input, response = tool output
 *   POST /mcp               MCP streamable HTTP (ChatGPT connectors, Claude.ai custom
 *                           connectors, c0mpute chat plugins, any remote MCP client)
 *
 * Hooks let a host add auth and payment without forking:
 *   authenticate(req) -> ctx | null      throw or return null to send 401
 *   gate(req, res, { tool, ctx }) -> bool  return false after writing a response (e.g. 402)
 */
export function createHandler(opts = {}) {
  const tools = opts.tools ?? createTools(opts);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const baseUrl = opts.baseUrl;

  return async function handler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    cors(res, opts.cors);
    if (req.method === 'OPTIONS') return end(res, 204);
    try {
      if (url.pathname === '/health') return json(res, 200, { ok: true, version: VERSION });
      if (url.pathname === '/openapi.json') {
        return json(res, 200, openapi(tools, baseUrl ?? `${proto(req)}://${req.headers.host}`, opts.info));
      }

      let ctx = {};
      const needsAuth = url.pathname === '/mcp' || url.pathname.startsWith('/api/');
      if (needsAuth && opts.authenticate) {
        try {
          ctx = await opts.authenticate(req);
        } catch {
          ctx = null;
        }
        if (!ctx) {
          if (opts.unauthorized) return opts.unauthorized(req, res);
          res.setHeader('www-authenticate', 'Bearer');
          return json(res, 401, { error: 'unauthorized' });
        }
      }

      if (url.pathname === '/mcp') {
        const body = req.method === 'POST' ? await readJson(req) : undefined;
        const call = body?.method === 'tools/call' ? byName.get(body.params?.name) : null;
        if (call && opts.gate && (await opts.gate(req, res, { tool: call, ctx, args: body.params?.arguments })) === false) return;
        return handleMcpHttp(req, res, body, { tools, context: ctx });
      }

      const m = url.pathname.match(/^\/api\/([a-z_]+)$/);
      if (m) {
        const tool = byName.get(m[1]);
        if (!tool) return json(res, 404, { error: `no tool ${m[1]}` });
        if (req.method !== 'POST' && req.method !== 'GET') return json(res, 405, { error: 'use POST' });
        const args = req.method === 'POST' ? (await readJson(req)) ?? {} : Object.fromEntries(url.searchParams);
        if (opts.gate && (await opts.gate(req, res, { tool, ctx, args })) === false) return;
        const { z } = await import('zod');
        const parsed = z.object(tool.input).safeParse(args);
        if (!parsed.success) return json(res, 400, { error: 'invalid input', issues: parsed.error.issues });
        return json(res, 200, await tool.handler(parsed.data, ctx));
      }

      if (opts.fallback) return opts.fallback(req, res);
      if (url.pathname === '/') {
        return json(res, 200, {
          name: 'autoinfluencer',
          version: VERSION,
          mcp: '/mcp',
          openapi: '/openapi.json',
          tools: tools.map((t) => t.name),
        });
      }
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      if (!res.headersSent) return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
      res.end();
    }
  };
}

export function serve({ port = 8787, host = '127.0.0.1', ...opts } = {}) {
  const server = createServer(createHandler(opts));
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

export function openapi(tools, serverUrl, info = {}) {
  const paths = {};
  for (const t of tools) {
    paths[`/api/${t.name}`] = {
      post: {
        operationId: t.name,
        summary: t.title,
        description: t.description,
        ...(t.annotations?.readOnlyHint ? {} : { 'x-openai-isConsequential': true }),
        requestBody: { required: true, content: { 'application/json': { schema: inputJsonSchema(t) } } },
        responses: { 200: { description: 'Tool result', content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'autoinfluencer',
      version: VERSION,
      description: 'Persona-driven social posts for every network: ideas, drafts, repurposing, replies, calendars and linting.',
      ...info,
    },
    servers: [{ url: serverUrl }],
    paths,
  };
}

function proto(req) {
  return req.headers['x-forwarded-proto']?.split(',')[0] ?? (req.socket?.encrypted ? 'https' : 'http');
}

function cors(res, origin = '*') {
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('access-control-allow-headers', 'authorization, content-type, mcp-session-id, mcp-protocol-version, x-payment, payment-signature');
  res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('access-control-expose-headers', 'mcp-session-id, www-authenticate, x-payment-response, payment-required');
}

function end(res, status) {
  res.writeHead(status);
  res.end();
}

export function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export async function readJson(req, limit = 1_000_000) {
  if (req.body !== undefined) return req.body;
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('invalid JSON'), { status: 400 });
  }
}
