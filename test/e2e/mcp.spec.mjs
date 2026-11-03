// E2E (H4): MCP over real HTTP against server/node.mjs: discover, tools/list, scan_site, Origin rejection.
import { test, expect } from '@playwright/test';
import { startServer } from './api-server.helper.mjs';

let srv;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => { srv = await startServer(); });
test.afterAll(() => srv?.stop());

const call = (request, method, params, headers = {}) => request.post(`${srv.base}/mcp`, {
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': method, ...headers },
  data: { jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } },
  timeout: 110_000,
});

test('server/discover and tools/list', async ({ request }) => {
  const d = await (await call(request, 'server/discover', {})).json();
  expect(d.result.supportedVersions).toContain('2026-07-28');
  const l = await (await call(request, 'tools/list', {})).json();
  expect(l.result.tools.map((t) => t.name)).toEqual(['scan_site', 'list_checks', 'explain_check', 'get_report']);
});

test('tools/call scan_site on the service itself', async ({ request }) => {
  test.setTimeout(120_000);
  const r = await call(request, 'tools/call', { name: 'scan_site', arguments: { url: `${srv.base}/` } }, { 'mcp-name': 'scan_site' });
  const j = await r.json();
  expect(j.result.isError).toBeFalsy();
  expect(j.result.content[0].text).toMatch(/Agent-Ready score/);
  const id = j.result.structuredContent.id;
  const g = await (await call(request, 'tools/call', { name: 'get_report', arguments: { id } }, { 'mcp-name': 'get_report' })).json();
  expect(g.result.structuredContent.id).toBe(id);
});

test('a foreign Origin is refused with 403', async ({ request }) => {
  const r = await call(request, 'ping', {}, { origin: 'https://evil.example' });
  expect(r.status()).toBe(403);
});
