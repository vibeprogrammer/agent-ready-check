import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockSite, html, text, json, status } from '../helpers/mock-site.mjs';
import { parseLlms } from '../../src/core/parse/llms.mjs';

const MD = '# Fjellro cabin\n\nTwo-bedroom cabin with a wood-fired sauna near Hemsedal. Sleeps six guests.\n\n## Prices\n\n- High season: NOK 2,400 per night\n';
const HTML = '<!doctype html><html lang="en"><head><title>Fjellro</title></head><body><main><h1>Fjellro cabin</h1><p>Two-bedroom cabin with a wood-fired sauna near Hemsedal. Sleeps six guests.</p><h2>Prices</h2><p>High season: NOK 2,400 per night</p></main></body></html>';
const mdRes = (body = MD, headers = { vary: 'Accept' }) => ({ status: 200, headers: { 'content-type': 'text/markdown; charset=utf-8', ...headers }, body });
const negotiating = (mdR = mdRes(), htmlHeaders = { vary: 'Accept' }) => ({ '/': ({ headers }) => (/text\/markdown/.test(headers.accept) ? mdR : html(HTML, htmlHeaders)) });
const LLMS = '# Nordlys Cabins\n\n> Six holiday cabins in Norway you can book directly.\n\n## Cabins\n\n- [Fjellro](https://example.com/cabins/fjellro.md): Hemsedal\n- [Lofoten](/cabins/lofoten.md): rorbu\n\n## Optional\n\n- [Sitemap](https://example.com/sitemap.xml)\n';

test('markdown-negotiation: compat and ours', async () => {
  const a = await mockSite(negotiating()).run('content.markdown-negotiation');
  assert.equal(a.status, 'pass'); assert.equal(a.compat.status, 'pass');
  const b = await mockSite({ '/': html(HTML) }).run('content.markdown-negotiation');
  assert.equal(b.status, 'fail'); assert.equal(b.compat.status, 'fail');
  const c = await mockSite(negotiating({ status: 200, headers: { 'content-type': 'text/plain' }, body: MD })).run('content.markdown-negotiation');
  assert.equal(c.status, 'warn'); assert.equal(c.compat.status, 'fail');
});

test('markdown-negotiation compat reads the homepage when an inner page is scanned', async () => {
  const site = mockSite({ ...negotiating(), '/cabins': html(HTML) });
  const r = await site.run('content.markdown-negotiation', '/cabins');
  assert.equal(r.status, 'fail'); assert.equal(r.compat.status, 'pass');
});

test('markdown-vary', async () => {
  assert.equal((await mockSite(negotiating()).run('content.markdown-vary')).status, 'pass');
  assert.equal((await mockSite(negotiating(mdRes(MD, {}), { vary: 'Accept-Encoding' })).run('content.markdown-vary')).status, 'fail');
  assert.equal((await mockSite(negotiating(mdRes(MD, { vary: 'accept-encoding, Accept' }), {})).run('content.markdown-vary')).status, 'warn');
  assert.equal((await mockSite({ '/': html(HTML) }).run('content.markdown-vary')).status, 'neutral');
});

test('markdown-quality', async () => {
  assert.equal((await mockSite(negotiating()).run('content.markdown-quality')).status, 'pass');
  assert.equal((await mockSite(negotiating(mdRes(HTML))).run('content.markdown-quality')).status, 'fail');
  assert.equal((await mockSite(negotiating(mdRes('Just text without headings about Fjellro cabin sauna Hemsedal guests season night'))).run('content.markdown-quality')).status, 'warn');
});

test('markdown-alternate', async () => {
  const withAlt = HTML.replace('</head>', '<link rel="alternate" type="text/markdown" href="/index.md"></head>');
  assert.equal((await mockSite({ '/': html(withAlt), '/index.md': mdRes() }).run('content.markdown-alternate')).status, 'pass');
  assert.equal((await mockSite({ '/': html(withAlt) }).run('content.markdown-alternate')).status, 'fail');
  assert.equal((await mockSite({ '/': html(HTML) }).run('content.markdown-alternate')).status, 'fail');
  assert.equal((await mockSite(negotiating()).run('content.markdown-alternate')).status, 'warn');
});

test('llms.txt presence, format and links', async () => {
  const ok = { '/llms.txt': mdRes(LLMS), '/cabins/fjellro.md': mdRes(), '/cabins/lofoten.md': mdRes(), '/sitemap.xml': text('x') };
  assert.equal((await mockSite(ok).run('content.llms-txt')).status, 'pass');
  assert.equal((await mockSite(ok).run('content.llms-txt-format')).status, 'pass');
  assert.equal((await mockSite(ok).run('content.llms-txt-links')).status, 'pass');
  assert.equal((await mockSite({ '/llms.txt': html('<html>soft 404</html>') }).run('content.llms-txt')).status, 'fail');
  assert.equal((await mockSite({}).run('content.llms-txt')).status, 'fail');
  assert.equal((await mockSite({}).run('content.llms-txt-format')).status, 'neutral');
  assert.equal((await mockSite({ '/llms.txt': status(429) }).run('content.llms-txt-format')).status, 'fail');
  assert.equal((await mockSite({ '/llms.txt': text('Hello there') }).run('content.llms-txt-format')).status, 'fail');
  assert.equal((await mockSite({ '/llms.txt': text('# Site\n\nSee [docs](https://example.com/docs) for everything about this site.') }).run('content.llms-txt-format')).status, 'warn');
  const broken = await mockSite({ '/llms.txt': mdRes(LLMS), '/cabins/fjellro.md': mdRes() }).run('content.llms-txt-links');
  assert.equal(broken.status, 'fail'); assert.equal(broken.details.broken.length, 2);
});

test('llms.txt link checks respect robots.txt', async () => {
  const r = await mockSite({ '/robots.txt': text('User-agent: *\nDisallow: /cabins/'), '/llms.txt': mdRes(LLMS), '/sitemap.xml': text('x') }).run('content.llms-txt-links');
  assert.equal(r.status, 'pass'); assert.equal(r.details.skippedByRobots, 2);
});

test('parseLlms', () => {
  const p = parseLlms(LLMS, 'https://example.com/llms.txt');
  assert.equal(p.h1, 'Nordlys Cabins'); assert.match(p.summary, /Six holiday/);
  assert.equal(p.sections.length, 2); assert.equal(p.links[1].url, 'https://example.com/cabins/lofoten.md');
  assert.equal(parseLlms('```\n# not a heading\n```').h1, null);
});

test('llms-full', async () => {
  assert.equal((await mockSite({ '/llms-full.txt': mdRes('# Full\n\n' + 'x'.repeat(3000)) }).run('content.llms-full')).status, 'pass');
  assert.equal((await mockSite({}).run('content.llms-full')).status, 'info');
});

test('link-headers', async () => {
  const a = await mockSite({ '/': html(HTML, { link: '</.well-known/api-catalog>; rel="api-catalog", </sitemap.xml>; rel="sitemap"' }) }).run('content.link-headers');
  assert.equal(a.status, 'pass'); assert.equal(a.compat.status, 'pass');
  const b = await mockSite({ '/': html(HTML.replace('</head>', '<link rel="alternate" type="text/markdown" href="/index.md"></head>')) }).run('content.link-headers');
  assert.equal(b.status, 'warn'); assert.equal(b.compat.status, 'fail');
  const c = await mockSite({ '/': html(HTML, { link: '</style.css>; rel="preload"' }) }).run('content.link-headers');
  assert.equal(c.status, 'fail');
});

test('feeds', async () => {
  const page = HTML.replace('</head>', '<link rel="alternate" type="application/atom+xml" href="/feed.xml"></head>');
  assert.equal((await mockSite({ '/': html(page), '/feed.xml': { status: 200, headers: { 'content-type': 'application/atom+xml' }, body: '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>' } }).run('content.feeds')).status, 'pass');
  assert.equal((await mockSite({ '/': html(page) }).run('content.feeds')).status, 'warn');
  assert.equal((await mockSite({ '/': html(HTML) }).run('content.feeds')).status, 'info');
  const jf = HTML.replace('</head>', '<link rel="alternate" type="application/feed+json" href="/feed.json"></head>');
  assert.equal((await mockSite({ '/': html(jf), '/feed.json': json({ version: 'https://jsonfeed.org/version/1.1', items: [] }) }).run('content.feeds')).status, 'pass');
});

test('caching', async () => {
  const cond = ({ headers }) => (headers['if-none-match'] === '"v1"' ? status(304, { etag: '"v1"' }) : html(HTML, { etag: '"v1"' }));
  assert.equal((await mockSite({ '/': cond }).run('content.caching')).status, 'pass');
  assert.equal((await mockSite({ '/': html(HTML, { etag: '"v1"' }) }).run('content.caching')).status, 'warn');
  assert.equal((await mockSite({ '/': html(HTML) }).run('content.caching')).status, 'fail');
});
