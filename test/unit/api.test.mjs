import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockSite, html, json, text } from '../helpers/mock-site.mjs';
import { isSfDate, isHttpDate, parseRateLimit } from '../../src/checks/api.mjs';

// Pass fixtures adapted from agent-ready-web-demos (MIT), nordlys-cabins/layers/07-public-api.
const O = 'https://example.com';
const LINKSET = 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"';
const catalog = { linkset: [{ anchor: `${O}/api/v1`, 'service-desc': [{ href: `${O}/openapi.json`, type: 'application/json' }], 'service-doc': [{ href: `${O}/developers.md`, type: 'text/markdown' }], status: [{ href: `${O}/api/v1/health`, type: 'application/json' }] }] };
const openapi = {
  openapi: '3.1.1', info: { title: 'Nordlys Cabins API', version: '1.0.0', description: 'Search and book cabins' },
  servers: [{ url: `${O}/api/v1` }],
  paths: {
    '/cabins': { get: { operationId: 'searchCabins', summary: 'Search cabins by region and guests', parameters: [{ name: 'region', in: 'query', description: 'Region name', schema: { type: 'string' } }], responses: { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/CabinList' } } } } } } },
    '/cabins/{slug}': { get: { operationId: 'getCabin', summary: 'Get one cabin with prices', parameters: [{ name: 'slug', in: 'path', required: true, description: 'Cabin slug', schema: { type: 'string' } }], responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } } } } },
  },
  components: { schemas: { CabinList: { type: 'array', items: { type: 'object' } } } },
};
const RL = { 'ratelimit-policy': '"default";q=60;w=60', ratelimit: '"default";r=59;t=60' };
const good = () => ({
  '/': html('<h1>Nordlys</h1><form action="/search"><input name="q"></form>'),
  '/.well-known/api-catalog': { status: 200, headers: { 'content-type': LINKSET }, body: JSON.stringify(catalog) },
  '/openapi.json': json(openapi),
  '/developers.md': text('# API'),
  '/api/v1/cabins': json([], RL),
  '/api/v1/agent-ready-check-unknown-route': json({ type: `${O}/problems/not-found`, title: 'Not found', status: 404 }, { 'content-type': 'application/problem+json', ...RL }, 404),
});

test('api.catalog passes on the Nordlys linkset and fails when missing', async () => {
  const r = await mockSite(good()).run('api.catalog');
  assert.equal(r.status, 'pass'); assert.equal(r.compat.status, 'pass');
  const f = await mockSite({ '/': html('<p>x</p>') }).run('api.catalog');
  assert.equal(f.status, 'fail'); assert.equal(f.compat.status, 'fail');
  const w = await mockSite({ '/.well-known/api-catalog': json(catalog) }).run('api.catalog');
  assert.equal(w.status, 'warn'); assert.equal(w.compat.status, 'pass');
});

test('api.catalog-valid passes with working links, fails without anchors', async () => {
  assert.equal((await mockSite(good()).run('api.catalog-valid')).status, 'pass');
  const bad = { linkset: [{ 'service-desc': [{ href: '/nope.json' }] }] };
  const r = await mockSite({ '/.well-known/api-catalog': { status: 200, headers: { 'content-type': LINKSET }, body: JSON.stringify(bad) } }).run('api.catalog-valid');
  assert.equal(r.status, 'fail');
});

test('api.openapi finds the document via service-desc; fails when absent', async () => {
  const r = await mockSite(good()).run('api.openapi');
  assert.equal(r.status, 'pass'); assert.match(r.message, /service-desc/);
  const f = await mockSite({ '/.well-known/api-catalog': json(catalog) }).run('api.openapi');
  assert.equal(f.status, 'fail');
});

test('api.openapi-valid catches swagger 2 and broken refs', async () => {
  assert.equal((await mockSite(good()).run('api.openapi-valid')).status, 'pass');
  const broken = { ...openapi, paths: { '/x': { get: { responses: { 200: { $ref: '#/components/responses/Missing' } } } } } };
  assert.equal((await mockSite({ '/openapi.json': json(broken) }).run('api.openapi-valid')).status, 'fail');
  assert.equal((await mockSite({ '/openapi.json': json({ swagger: '2.0', info: { title: 'a', version: '1' }, paths: {} }) }).run('api.openapi-valid')).status, 'fail');
});

test('api.openapi-agent-quality scores described vs bare operations', async () => {
  assert.equal((await mockSite(good()).run('api.openapi-agent-quality')).status, 'pass');
  const bare = { openapi: '3.1.0', info: { title: 'a', version: '1' }, paths: { '/a': { get: { responses: { 200: { description: 'OK' } } } }, '/b': { post: { parameters: [{ name: 'x', in: 'query' }], responses: { 200: { description: 'OK' } } } } } };
  assert.equal((await mockSite({ '/openapi.json': json(bare) }).run('api.openapi-agent-quality')).status, 'fail');
});

test('api.problem-json: problem+json passes, HTML 404 fails, plain JSON warns', async () => {
  assert.equal((await mockSite(good()).run('api.problem-json')).status, 'pass');
  const h = good(); h['/api/v1/agent-ready-check-unknown-route'] = { status: 404, headers: { 'content-type': 'text/html' }, body: '<h1>404</h1>' };
  assert.equal((await mockSite(h).run('api.problem-json')).status, 'fail');
  const j = good(); j['/api/v1/agent-ready-check-unknown-route'] = json({ error: 'nope' }, {}, 404);
  assert.equal((await mockSite(j).run('api.problem-json')).status, 'warn');
});

test('api.ratelimit reads draft-11 fields; legacy X-RateLimit warns; none fails', async () => {
  assert.equal((await mockSite(good()).run('api.ratelimit')).status, 'pass');
  const l = good(); l['/api/v1/cabins'] = json([], { 'x-ratelimit-limit': '60' }); l['/api/v1/agent-ready-check-unknown-route'] = json({}, {}, 404);
  assert.equal((await mockSite(l).run('api.ratelimit')).status, 'warn');
  const n = good(); n['/api/v1/cabins'] = json([]); n['/api/v1/agent-ready-check-unknown-route'] = json({}, {}, 404);
  assert.equal((await mockSite(n).run('api.ratelimit')).status, 'fail');
  assert.deepEqual(parseRateLimit({ 'ratelimit-policy': '"x";w=60' }).problems.length, 1);
});

test('api.deprecation validates RFC 9745 and HTTP-date forms', async () => {
  assert.equal(isSfDate('@1798761600'), true); assert.equal(isSfDate('true'), false);
  assert.equal(isHttpDate('Sat, 01 Jan 2028 00:00:00 GMT'), true); assert.equal(isHttpDate('2028-01-01'), false);
  assert.equal((await mockSite(good()).run('api.deprecation')).status, 'info');
  const d = good(); d['/api/v1/cabins'] = json([], { deprecation: '@1798761600', sunset: 'Sat, 01 Jan 2028 00:00:00 GMT' });
  assert.equal((await mockSite(d).run('api.deprecation')).status, 'pass');
  const b = good(); b['/api/v1/cabins'] = json([], { deprecation: 'true' });
  assert.equal((await mockSite(b).run('api.deprecation')).status, 'warn');
});

test('api.actionable-interface: forms without interface fail, with API pass, no forms neutral', async () => {
  assert.equal((await mockSite(good()).run('api.actionable-interface')).status, 'pass');
  assert.equal((await mockSite({ '/': html('<form><input name="q"></form>') }).run('api.actionable-interface')).status, 'fail');
  assert.equal((await mockSite({ '/': html('<form toolname="search" tooldescription="Search"><input name="q"></form>') }).run('api.actionable-interface')).status, 'pass');
  assert.equal((await mockSite({ '/': html('<p>hello</p>') }).run('api.actionable-interface')).status, 'neutral');
});
