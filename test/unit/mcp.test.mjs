// H4: the stateless MCP server (src/mcp/server.mjs), called directly and through the app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHandler, TOOLS, PROTOCOLS, summarize, structured } from '../../src/mcp/server.mjs';
import { createApp } from '../../server/app.mjs';
import { memoryStore } from '../../src/store/memory.mjs';
import { memoryRateLimiter } from '../../server/ratelimit.mjs';
import { fakeReport } from './server-fake-report.mjs';

const stored = { ...fakeReport('https://example.com/'), id: 'abc123def456', report_url: 'https://checker.example/r/abc123def456' };
const handler = createMcpHandler({
  scan: async (url) => { if (url.includes('blocked')) throw Object.assign(new Error('blocked.example resolves to a private address'), { status: 422 }); return { ...stored, url }; },
  getReport: async (id) => (id === stored.id ? stored : null),
});
const rpc = async (method, params, headers = {}, id = 1) => {
  const res = await handler(new Request('https://checker.example/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }));
  return { res, body: res.status === 202 ? null : await res.json() };
};

test('initialize negotiates 2025 versions and accepts 2026-07-28', async () => {
  for (const v of ['2025-06-18', '2025-11-25', '2026-07-28']) {
    const { body } = await rpc('initialize', { protocolVersion: v, capabilities: {}, clientInfo: { name: 't', version: '1' } }, { 'mcp-protocol-version': v });
    assert.equal(body.result.protocolVersion, v);
    assert.equal(body.result.serverInfo.name, 'agent-ready-check');
    assert.ok(body.result.capabilities.tools);
  }
  const { body } = await rpc('initialize', { protocolVersion: '2024-11-05' });
  assert.ok(PROTOCOLS.includes(body.result.protocolVersion));
});

test('server/discover (2026-07-28) lists versions, capabilities and serverInfo in _meta', async () => {
  const { body } = await rpc('server/discover', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } }, { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'server/discover' });
  assert.deepEqual(body.result.supportedVersions, PROTOCOLS);
  assert.equal(body.result._meta['io.modelcontextprotocol/serverInfo'].name, 'agent-ready-check');
  assert.equal(body.result.resultType, 'complete');
});

test('tools/list: four tools with schemas and annotations, deterministic order', async () => {
  const { body } = await rpc('tools/list', {});
  const names = body.result.tools.map((t) => t.name);
  assert.deepEqual(names, ['scan_site', 'list_checks', 'explain_check', 'get_report']);
  for (const t of body.result.tools) {
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(t.description.length > 40);
    assert.equal(t.annotations.readOnlyHint, true);
    for (const [, p] of Object.entries(t.inputSchema.properties)) assert.ok(p.description, `${t.name} property described`);
  }
  assert.equal(TOOLS[0].annotations.openWorldHint, true);
  assert.ok(TOOLS[0].outputSchema);
});

test('tools/call scan_site returns text summary and structuredContent without raw exchanges', async () => {
  const { body } = await rpc('tools/call', { name: 'scan_site', arguments: { url: 'https://example.com' } });
  assert.equal(body.result.isError, undefined);
  assert.match(body.result.content[0].text, /42\/100/);
  assert.match(body.result.content[0].text, /r\/abc123def456/);
  assert.equal(body.result.structuredContent.score, 42);
  assert.equal(body.result.structuredContent.exchanges, undefined);
  assert.equal(body.result.structuredContent.exchanges_omitted, 1);
  for (const k of TOOLS[0].outputSchema.required) assert.ok(k in body.result.structuredContent, k);
});

test('tools/call errors are tool results (isError), unknown tools are JSON-RPC errors', async () => {
  const blocked = await rpc('tools/call', { name: 'scan_site', arguments: { url: 'https://blocked.example' } });
  assert.equal(blocked.body.result.isError, true);
  const missing = await rpc('tools/call', { name: 'scan_site', arguments: {} });
  assert.equal(missing.body.result.isError, true);
  const unknown = await rpc('tools/call', { name: 'nope', arguments: {} });
  assert.equal(unknown.body.error.code, -32602);
});

test('list_checks, explain_check, get_report', async () => {
  const list = await rpc('tools/call', { name: 'list_checks', arguments: { layer: 'crawl' } });
  assert.ok(list.body.result.structuredContent.checks.every((c) => c.layer === 'crawl'));
  const badLayer = await rpc('tools/call', { name: 'list_checks', arguments: { layer: 'nope' } });
  assert.equal(badLayer.body.result.isError, true);
  const ex = await rpc('tools/call', { name: 'explain_check', arguments: { id: 'crawl.robots-txt' } });
  assert.match(ex.body.result.content[0].text, /crawl\.robots-txt/);
  assert.equal(ex.body.result.structuredContent.id, 'crawl.robots-txt');
  const nope = await rpc('tools/call', { name: 'explain_check', arguments: { id: 'x.y' } });
  assert.equal(nope.body.result.isError, true);
  const rep = await rpc('tools/call', { name: 'get_report', arguments: { id: 'abc123def456' } });
  assert.equal(rep.body.result.structuredContent.id, 'abc123def456');
  const gone = await rpc('tools/call', { name: 'get_report', arguments: { id: 'zzzzzzzzzzzz' } });
  assert.equal(gone.body.result.isError, true);
});

test('Origin validation: foreign browser origins get 403; same origin and no origin pass', async () => {
  assert.equal((await rpc('ping', {}, { origin: 'https://evil.example' })).res.status, 403);
  assert.equal((await rpc('ping', {}, { origin: 'null' })).res.status, 403);
  assert.equal((await rpc('ping', {}, { origin: 'https://checker.example' })).res.status, 200);
  assert.equal((await rpc('ping', {})).res.status, 200);
});

test('transport rules: notifications 202, GET 405, batch 400, parse error, bad version header, header/body mismatch', async () => {
  const n = await handler(new Request('https://checker.example/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }));
  assert.equal(n.status, 202);
  assert.equal((await handler(new Request('https://checker.example/mcp'))).status, 405);
  const batch = await handler(new Request('https://checker.example/mcp', { method: 'POST', body: '[]' }));
  assert.equal(batch.status, 400);
  const parse = await handler(new Request('https://checker.example/mcp', { method: 'POST', body: '{' }));
  assert.equal((await parse.json()).error.code, -32700);
  assert.equal((await rpc('ping', {}, { 'mcp-protocol-version': '1999-01-01' })).res.status, 400);
  const mismatch = await rpc('tools/call', { name: 'list_checks', arguments: {} }, { 'mcp-method': 'tools/call', 'mcp-name': 'scan_site' });
  assert.equal(mismatch.body.error.code, -32020);
  const unknown = await rpc('resources/templates/list', {});
  assert.equal(unknown.body.error.code, -32601);
});

test('summarize and structured helpers', () => {
  const s = summarize(stored);
  assert.match(s, /Top fixes/);
  assert.match(s, /crawl\.robots-txt/);
  assert.equal(structured(stored).exchanges, undefined);
});

test('through the app: tools/call scan_site runs the rate-limited, cached scan and stores the report', async () => {
  const store = memoryStore();
  const app = createApp({ scan: async (url) => fakeReport(url), store, rateLimit: memoryRateLimiter({ limit: 5 }), resolve: async () => ['93.184.216.34'] });
  const res = await app.request('https://checker.example/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'scan_site', arguments: { url: 'example.com' } } }) });
  const j = await res.json();
  assert.equal(j.id, 7);
  const id = j.result.structuredContent.id;
  assert.ok(await store.get(id));
  assert.equal(j.result.structuredContent.report_url, `https://checker.example/r/${id}`);
  const blocked = await app.request('https://checker.example/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'scan_site', arguments: { url: 'http://10.1.2.3' } } }) });
  assert.equal((await blocked.json()).result.isError, true);
  const evil = await app.request('https://checker.example/mcp', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }) });
  assert.equal(evil.status, 403);
});
