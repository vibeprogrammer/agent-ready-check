// H4: routes of server/app.mjs through app.request (no network: fake scan, fake DNS).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, wantsMarkdown } from '../../server/app.mjs';
import { memoryStore } from '../../src/store/memory.mjs';
import { memoryRateLimiter } from '../../server/ratelimit.mjs';
import { parseRobots } from '../../src/core/parse/robots.mjs';
import { fakeReport } from './server-fake-report.mjs';

function makeApp(o = {}) {
  const calls = [];
  const app = createApp({
    scan: async (url, opts) => { calls.push({ url, opts }); if (o.scanError) throw o.scanError; return fakeReport(url); },
    store: o.store || memoryStore(),
    rateLimit: o.rateLimit || memoryRateLimiter({ limit: 3, windowSeconds: 600 }),
    resolve: o.resolve || (async () => ['93.184.216.34']),
    browserAvailable: false,
    ...o.app,
  });
  return { app, calls };
}
const get = (app, path, headers = {}) => app.request(`https://checker.example${path}`, { headers });
const post = (app, path, body, headers = { 'content-type': 'application/json' }) => app.request(`https://checker.example${path}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('wantsMarkdown follows Accept q-values', () => {
  assert.equal(wantsMarkdown('text/markdown'), true);
  assert.equal(wantsMarkdown('text/markdown, text/html;q=0.9'), true);
  assert.equal(wantsMarkdown('text/html,application/xhtml+xml,*/*;q=0.8'), false);
  assert.equal(wantsMarkdown('text/html, text/markdown;q=0.5'), false);
  assert.equal(wantsMarkdown(''), false);
});

test('home page: HTML with Link headers, Markdown on Accept, Vary: Accept, security headers', async () => {
  const { app } = makeApp();
  const r = await get(app, '/', { accept: 'text/html' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  const link = r.headers.get('link');
  for (const rel of ['api-catalog', 'service-desc', 'service-doc', 'describedby', 'alternate', 'sitemap', 'ard']) assert.match(link, new RegExp(`rel="${rel}"`), rel);
  assert.match(r.headers.get('vary'), /Accept/);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('strict-transport-security'), /max-age=31536000/);
  const html = await r.text();
  assert.match(html, /<html lang="en">/);
  const md = await get(app, '/', { accept: 'text/markdown' });
  assert.match(md.headers.get('content-type'), /^text\/markdown/);
  assert.match(md.headers.get('vary'), /Accept/);
  assert.match(await md.text(), /^# Agent-Ready Check/);
});

test('ETag and 304 on pages and agent files', async () => {
  const { app } = makeApp();
  for (const path of ['/', '/robots.txt', '/llms.txt']) {
    const r = await get(app, path);
    const etag = r.headers.get('etag');
    assert.ok(etag, path);
    const again = await get(app, path, { 'if-none-match': etag });
    assert.equal(again.status, 304, path);
  }
});

test('docs, checks and privacy pages exist as HTML and Markdown', async () => {
  const { app } = makeApp();
  for (const p of ['/docs', '/checks', '/privacy']) {
    const h = await get(app, p, { accept: 'text/html' });
    assert.equal(h.status, 200, p);
    const html = await h.text();
    assert.equal((html.match(/<main/g) || []).length, 1, `${p} has one main`);
    assert.equal((html.match(/<h1/g) || []).length, 1, `${p} has one h1`);
    assert.match(html, /application\/ld\+json/);
    const m = await get(app, `${p}.md`);
    assert.match(m.headers.get('content-type'), /text\/markdown/);
  }
});

test('POST /api/scan returns JSON with id, report_url and RateLimit headers; GET is cached', async () => {
  const { app, calls } = makeApp();
  const r = await post(app, '/api/scan', { url: 'example.com' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.url, 'https://example.com/');
  assert.match(j.id, /^[a-z0-9]{12}$/);
  assert.equal(j.report_url, `https://checker.example/r/${j.id}`);
  assert.match(r.headers.get('ratelimit-policy'), /^"scans";q=3;w=600$/);
  assert.match(r.headers.get('ratelimit'), /^"scans";r=2;t=\d+$/);
  const again = await get(app, '/api/scan?url=https://example.com/');
  assert.equal(again.headers.get('x-cache'), 'HIT');
  assert.equal(calls.length, 1, 'second request served from cache');
  const stored = await get(app, `/api/reports/${j.id}`);
  assert.equal(stored.status, 200);
  assert.equal((await stored.json()).id, j.id);
});

test('formats: markdown and agent', async () => {
  const { app } = makeApp();
  const md = await post(app, '/api/scan', { url: 'https://example.com', format: 'markdown' });
  assert.match(md.headers.get('content-type'), /text\/markdown/);
  const agent = await post(app, '/api/scan', { url: 'https://example.com', format: 'agent' });
  assert.match(agent.headers.get('content-type'), /text\/markdown/);
  assert.match(await agent.text(), /robots/i);
  const bad = await post(app, '/api/scan', { url: 'https://example.com', format: 'xml' });
  assert.equal(bad.status, 400);
});

test('problem+json errors: bad body, missing url, bad scheme, private address, unknown API path', async () => {
  const { app } = makeApp();
  const cases = [
    [await post(app, '/api/scan', '{not json'), 400],
    [await post(app, '/api/scan', {}), 400],
    [await post(app, '/api/scan', { url: 'ftp://example.com' }), 400],
    [await post(app, '/api/scan', { url: 'http://127.0.0.1/' }), 422],
    [await post(app, '/api/scan', { url: 'http://localhost:3000/' }), 422],
    [await post(app, '/api/scan', { url: 'https://example.com:8443/' }), 422],
    [await post(app, '/api/scan', 'url=x', { 'content-type': 'text/plain' }), 415],
    [await get(app, '/api/scan'), 400],
    [await get(app, '/api/nope'), 404],
    [await get(app, '/api/checks/nope.nope'), 404],
    [await get(app, '/api/reports/doesnotexist'), 404],
  ];
  for (const [r, status] of cases) {
    assert.equal(r.status, status);
    assert.match(r.headers.get('content-type'), /^application\/problem\+json/);
    const j = await r.json();
    assert.equal(j.status, status);
    assert.ok(j.title && j.detail);
  }
});

test('host names that resolve to private addresses are refused before scanning', async () => {
  const { app, calls } = makeApp({ resolve: async () => ['10.0.0.5'] });
  const r = await post(app, '/api/scan', { url: 'https://intranet.example' });
  assert.equal(r.status, 422);
  assert.equal(calls.length, 0);
});

test('body over the cap answers 413', async () => {
  const { app } = makeApp({ app: { maxBodyBytes: 100 } });
  const r = await post(app, '/api/scan', { url: `https://example.com/?q=${'a'.repeat(200)}` });
  assert.equal(r.status, 413);
});

test('rate limit: 429 with Retry-After and the quota-exceeded problem type', async () => {
  const { app } = makeApp({ rateLimit: memoryRateLimiter({ limit: 1, windowSeconds: 60 }) });
  assert.equal((await post(app, '/api/scan', { url: 'https://a.example' })).status, 200);
  const r = await post(app, '/api/scan', { url: 'https://b.example' });
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) > 0);
  assert.match(r.headers.get('ratelimit'), /r=0/);
  const j = await r.json();
  assert.match(j.type, /quota-exceeded/);
  // a cached URL is still served
  assert.equal((await post(app, '/api/scan', { url: 'https://a.example' })).status, 200);
});

test('only one self-scan at a time', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const app = createApp({
    scan: async (url) => { await gate; return fakeReport(url); },
    store: memoryStore(), rateLimit: memoryRateLimiter({ limit: 10 }), resolve: async () => ['93.184.216.34'],
  });
  const first = post(app, '/api/scan', { url: 'https://checker.example/' });
  await new Promise((r) => setTimeout(r, 10));
  const second = await post(app, '/api/scan', { url: 'https://checker.example/docs' });
  assert.equal(second.status, 409);
  release();
  assert.equal((await first).status, 200);
});

test('GET /api/checks and /api/checks/{id}', async () => {
  const { app } = makeApp();
  const r = await get(app, '/api/checks');
  const j = await r.json();
  assert.equal(j.count, j.checks.length);
  assert.ok(j.count >= 100);
  const crawl = await (await get(app, '/api/checks?layer=crawl')).json();
  assert.ok(crawl.checks.every((c) => c.layer === 'crawl'));
  assert.equal((await get(app, '/api/checks?layer=nope')).status, 400);
  const one = await (await get(app, '/api/checks/crawl.robots-txt')).json();
  assert.equal(one.id, 'crawl.robots-txt');
  assert.ok(one.standard.name);
});

test('HTML scan page, stored report page (HTML + Markdown), badges', async () => {
  const { app } = makeApp();
  const s = await get(app, '/scan?url=example.com', { accept: 'text/html' });
  assert.equal(s.status, 200);
  const id = s.headers.get('content-location').split('/').pop();
  const page = await get(app, `/r/${id}`, { accept: 'text/html' });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const md = await get(app, `/r/${id}`, { accept: 'text/markdown' });
  assert.match(md.headers.get('content-type'), /text\/markdown/);
  assert.equal((await get(app, '/r/nothinghere', { accept: 'text/html' })).status, 404);
  const badge = await get(app, '/badge/example.com.svg');
  assert.match(badge.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(await badge.text(), /42/);
  const none = await (await get(app, '/badge/never-scanned.example.svg')).text();
  assert.match(none, /not scanned/);
  const byUrl = await get(app, '/badge?url=https://example.com/page');
  assert.match(await byUrl.text(), /42/);
  assert.equal((await get(app, '/scan')).status, 302);
});

test('scan page errors render as HTML with the right status', async () => {
  const { app } = makeApp();
  const r = await get(app, '/scan?url=http://192.168.1.1', { accept: 'text/html' });
  assert.equal(r.status, 422);
  assert.match(r.headers.get('content-type'), /text\/html/);
});

test('agent files: robots, sitemap, llms, openapi, catalog, cards, skills, ard, security.txt, gpc', async () => {
  const { app } = makeApp();
  const robots = await (await get(app, '/robots.txt')).text();
  const parsed = parseRobots(robots);
  assert.equal(parsed.errors.length, 0);
  assert.ok(parsed.contentSignals.length >= 3);
  assert.deepEqual(parsed.sitemaps, ['https://checker.example/sitemap.xml']);
  assert.deepEqual(parsed.agentmaps, ['https://checker.example/.well-known/ard.json']);
  const types = {
    '/sitemap.xml': /application\/xml/, '/llms.txt': /text\/plain/, '/llms-full.txt': /text\/plain/, '/openapi.json': /application\/openapi\+json/,
    '/.well-known/api-catalog': /application\/linkset\+json/, '/.well-known/mcp/server-card.json': /application\/json/, '/.well-known/mcp.json': /application\/json/,
    '/.well-known/mcp/server-cards.json': /application\/json/, '/mcp/server-card': /application\/mcp-server-card\+json/, '/.well-known/agent-skills/index.json': /application\/json/,
    '/.well-known/agent-skills/agent-ready-check/SKILL.md': /text\/markdown/, '/.well-known/ard.json': /application\/json/, '/.well-known/security.txt': /text\/plain/, '/.well-known/gpc.json': /application\/json/,
  };
  for (const [p, re] of Object.entries(types)) {
    const r = await get(app, p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), re, p);
    assert.equal(r.headers.get('access-control-allow-origin'), '*', p);
  }
  const card = await (await get(app, '/.well-known/mcp/server-card.json')).json();
  assert.equal(card.remotes[0].url, 'https://checker.example/mcp');
});

test('unknown paths: 404 HTML for browsers, problem+json otherwise (no soft 404)', async () => {
  const { app } = makeApp();
  const h = await get(app, '/.well-known/does-not-exist', { accept: 'text/html' });
  assert.equal(h.status, 404);
  const j = await get(app, '/does-not-exist');
  assert.equal(j.status, 404);
  assert.match(j.headers.get('content-type'), /problem\+json/);
});

test('H3 static assets are served', async () => {
  const { app } = makeApp();
  const css = await get(app, '/assets/app.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
});

test('health endpoint', async () => {
  const { app } = makeApp();
  const j = await (await get(app, '/api/health')).json();
  assert.equal(j.status, 'ok');
  assert.equal(j.store, 'memory');
});
