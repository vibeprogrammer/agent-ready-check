// The MCP probe speaks both eras: server/discover (2026-07-28, stateless) first, then the 2025 initialize handshake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockSite, json } from '../helpers/mock-site.mjs';

const modern = ({ headers, body }) => {
  const m = JSON.parse(body);
  if (headers['mcp-protocol-version'] !== '2026-07-28' || !m.params?._meta) return json({ jsonrpc: '2.0', id: m.id, error: { code: -32020, message: 'Bad Request' } }, {}, 400);
  if (m.method === 'server/discover') return json({ jsonrpc: '2.0', id: m.id, result: { supportedVersions: ['2026-07-28', '2025-11-25'], capabilities: { tools: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'demo', version: '2.0.0' } } } });
  if (m.method === 'tools/list') return json({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'search', description: 'Search the catalogue', inputSchema: { type: 'object', properties: { q: { type: 'string', description: 'Words' } } } }] } });
  return json({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } });
};
const legacy = ({ body }) => {
  const m = JSON.parse(body || '{}');
  if (m.method === 'initialize') return json({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'old', version: '1' } } }, { 'mcp-session-id': 's1' });
  if (!m.id) return { status: 202, headers: {}, body: '' };
  if (m.method === 'tools/list') return json({ jsonrpc: '2.0', id: m.id, result: { tools: [] } });
  return json({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
};

test('a stateless 2026-07-28 server answers server/discover and tools/list with _meta', async () => {
  const site = mockSite({ '/mcp': modern });
  const e = await site.run('mcp.endpoint');
  assert.equal(e.status, 'pass'); assert.match(e.message, /server\/discover/); assert.equal(e.details.era, 'modern');
  assert.equal((await site.run('mcp.protocol-version')).status, 'pass');
  assert.equal((await site.run('mcp.tools-list')).status, 'pass');
});

test('a 2025-era server is reached through initialize', async () => {
  const e = await mockSite({ '/mcp': legacy }).run('mcp.endpoint');
  assert.equal(e.status, 'pass'); assert.equal(e.details.era, 'legacy'); assert.equal(e.details.protocolVersion, '2025-11-25');
});
