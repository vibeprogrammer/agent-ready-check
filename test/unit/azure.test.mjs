// Azure Static Web Apps deployment: the function handler, the blob report store and the SWA routing config.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAzureHandler, originalUrl } from '../../server/azure.mjs';
import { azureBlobStore, parseConnectionString, stringToSign } from '../../src/store/azure-blob.mjs';
import { memoryStore } from '../../src/store/memory.mjs';
import { swaConfig, SITE_FUNCTION } from '../../scripts/swa-config.mjs';

const BASE = 'https://agent.example';

function rewritten(path, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('x-ms-original-url', BASE + path);
  return new Request(BASE + SITE_FUNCTION, { ...init, headers });
}

test('originalUrl prefers x-ms-original-url and falls back to the request URL', () => {
  assert.equal(originalUrl(`${BASE}/api/__site`, new Headers({ 'x-ms-original-url': `${BASE}/robots.txt?x=1` })), `${BASE}/robots.txt?x=1`);
  assert.equal(originalUrl(`${BASE}/api/health`, new Headers()), `${BASE}/api/health`);
  assert.equal(originalUrl(`${BASE}/api/health`, { 'x-ms-original-url': 'not a url' }), `${BASE}/api/health`);
});

test('the Azure handler serves rewritten pages and direct /api calls from the same app', async () => {
  const handle = createAzureHandler({ BASE_URL: BASE }, { store: memoryStore() });
  const home = await handle(rewritten('/'));
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  assert.match(home.headers.get('vary') || '', /Accept/);
  const md = await handle(rewritten('/', { headers: { accept: 'text/markdown' } }));
  assert.match(md.headers.get('content-type'), /text\/markdown/);
  const robots = await handle(rewritten('/robots.txt'));
  assert.equal(robots.status, 200);
  assert.match(await robots.text(), new RegExp(`Sitemap: ${BASE}/sitemap.xml`));
  const health = await handle(new Request(`${BASE}/api/health`));
  const h = await health.json();
  assert.equal(h.runtime, 'azure');
  assert.equal(h.browser, false);
  const mcp = await handle(rewritten('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  }));
  assert.equal(mcp.status, 200);
  assert.ok((await mcp.json()).result.tools.some((t) => t.name === 'scan_site'));
});

test('browser checks are offered only when a runner URL and token are both set', async () => {
  const on = createAzureHandler({ BASE_URL: BASE, BROWSER_RUNNER_URL: 'https://runner.example/collect', RUNNER_TOKEN: 't' }, { store: memoryStore() });
  assert.equal((await (await on(new Request(`${BASE}/api/health`))).json()).browser, true);
  const half = createAzureHandler({ BASE_URL: BASE, BROWSER_RUNNER_URL: 'https://runner.example/collect' }, { store: memoryStore() });
  assert.equal((await (await half(new Request(`${BASE}/api/health`))).json()).browser, false);
});

test('parseConnectionString reads Azure and Azurite connection strings', () => {
  const a = parseConnectionString('DefaultEndpointsProtocol=https;AccountName=arc1;AccountKey=a2V5;EndpointSuffix=core.windows.net');
  assert.deepEqual(a, { account: 'arc1', key: 'a2V5', blobEndpoint: 'https://arc1.blob.core.windows.net' });
  assert.equal(parseConnectionString('UseDevelopmentStorage=true').blobEndpoint, 'http://127.0.0.1:10000/devstoreaccount1');
  assert.throws(() => parseConnectionString('AccountName=x'), /AccountKey/);
});

test('stringToSign follows the Shared Key layout for the Blob service', () => {
  const s = stringToSign({
    method: 'PUT', account: 'arc1', url: 'https://arc1.blob.core.windows.net/reports/r/abc.json?restype=container&comp=list',
    headers: { 'x-ms-version': '2025-01-05', 'x-ms-date': 'Thu, 05 Nov 2026 08:00:00 GMT', 'content-type': 'application/json', 'content-length': '12', 'x-ms-blob-type': 'BlockBlob' },
  });
  assert.equal(s, 'PUT\n\n\n12\n\napplication/json\n\n\n\n\n\n\nx-ms-blob-type:BlockBlob\nx-ms-date:Thu, 05 Nov 2026 08:00:00 GMT\nx-ms-version:2025-01-05\n/arc1/reports/r/abc.json\ncomp:list\nrestype:container');
});

test('azureBlobStore round-trips reports and pointers through a fake Blob endpoint', async () => {
  const blobs = new Map();
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.authorization });
    const key = new URL(url).pathname;
    if (init.method === 'PUT') { blobs.set(key, new TextDecoder().decode(init.body)); return new Response(null, { status: 201 }); }
    if (!blobs.has(key)) return new Response(null, { status: 404 });
    return new Response(blobs.get(key), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const store = azureBlobStore({ connectionString: 'AccountName=arc1;AccountKey=a2V5a2V5a2V5;BlobEndpoint=https://arc1.blob.core.windows.net', fetch: fakeFetch });
  const id = await store.put({ url: 'https://example.com/', final_url: 'https://example.com/', score: 77 });
  assert.equal((await store.get(id)).score, 77);
  assert.equal((await store.latestForHost('EXAMPLE.com')).id, id);
  assert.equal((await store.latestForUrl('https://example.com/', 60_000)).id, id);
  assert.equal(await store.get('../etc/passwd'), null);
  assert.equal(await store.latestForHost('other.example'), null);
  assert.ok(calls.every((c) => /^SharedKey arc1:[A-Za-z0-9+/]+=*$/.test(c.auth)), 'every call is signed');
  assert.ok([...blobs.keys()].some((k) => k.startsWith('/reports/r/')) && [...blobs.keys()].some((k) => k.startsWith('/reports/host/')));
});

test('the Static Web Apps config keeps assets static and sends everything else to the site function', () => {
  const c = swaConfig();
  assert.equal(c.platform.apiRuntime, 'node:22');
  assert.equal(c.routes[0].route, '/assets/*');
  assert.equal(c.routes.at(-1).route, '/*');
  assert.equal(c.routes.at(-1).rewrite, SITE_FUNCTION);
  assert.equal(c.navigationFallback.rewrite, SITE_FUNCTION);
  assert.ok(SITE_FUNCTION.startsWith('/api/'), 'Static Web Apps only routes /api/* to functions');
});
