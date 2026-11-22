import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '../src/server.js';
import { createTools } from '../src/tools.js';
import { examplePersona } from '../src/persona.js';

async function withServer(opts, fn) {
  const server = await serve({ port: 0, local: false, ...opts });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

const mcp = (base, body, headers = {}) =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });

test('HTTP API, OpenAPI and MCP streamable HTTP all serve the same tools', async () => {
  await withServer({}, async (base) => {
    assert.equal((await (await fetch(`${base}/health`)).json()).ok, true);

    const spec = await (await fetch(`${base}/openapi.json`)).json();
    assert.equal(spec.openapi, '3.1.0');
    assert.ok(spec.paths['/api/draft'].post.requestBody);

    const lint = await (await fetch(`${base}/api/lint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ posts: [{ platform: 'x', text: 'a'.repeat(281) }] }),
    })).json();
    assert.equal(lint.results[0].ok, false);

    const bad = await fetch(`${base}/api/lint`, { method: 'POST', body: '{}' });
    assert.equal(bad.status, 400);

    const init = await mcp(base, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    assert.equal(init.status, 200);
    const list = await (await mcp(base, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { 'mcp-protocol-version': '2025-06-18' })).json();
    const names = list.result.tools.map((t) => t.name);
    assert.ok(names.includes('draft') && names.includes('lint'));

    const call = await (await mcp(base, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'draft', arguments: { persona: examplePersona(), topic: 'CI caching', mode: 'brief' } },
    }, { 'mcp-protocol-version': '2025-06-18' })).json();
    assert.match(call.result.content[0].text, /Write the posts yourself/);
  });
});

test('authenticate and gate hooks guard /api and /mcp', async () => {
  const opts = {
    tools: createTools({ local: false }),
    authenticate: async (req) => (req.headers.authorization === 'Bearer good' ? { user: 'u1' } : null),
    gate: async (req, res, { tool }) => {
      if (tool.name !== 'draft') return true;
      res.writeHead(402, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'payment required' }));
      return false;
    },
  };
  await withServer(opts, async (base) => {
    const body = JSON.stringify({ persona: examplePersona(), topic: 't', mode: 'brief' });
    assert.equal((await fetch(`${base}/api/draft`, { method: 'POST', body })).status, 401);
    assert.equal((await fetch(`${base}/api/draft`, { method: 'POST', body, headers: { authorization: 'Bearer good' } })).status, 402);
    assert.equal((await fetch(`${base}/api/platforms`, { headers: { authorization: 'Bearer good' } })).status, 200);
    const gated = await mcp(base, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'draft', arguments: {} } }, { authorization: 'Bearer good' });
    assert.equal(gated.status, 402);
  });
});
