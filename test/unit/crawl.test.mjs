import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockSite, text, html, json, status } from '../helpers/mock-site.mjs';
import { parseSitemap } from '../../src/core/parse/sitemap.mjs';
import { challengeOf } from '../../src/checks/crawl.mjs';

const xml = (body, headers = {}) => ({ status: 200, headers: { 'content-type': 'application/xml', ...headers }, body });
const urlset = (urls) => `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(([l, m]) => `<url><loc>${l}</loc>${m ? `<lastmod>${m}</lastmod>` : ''}</url>`).join('')}</urlset>`;

const GOOD_ROBOTS = `User-agent: OAI-SearchBot
User-agent: Claude-SearchBot
User-agent: PerplexityBot
User-agent: Amzn-SearchBot
User-agent: MistralAI-Index
User-agent: ChatGPT-User
User-agent: Claude-User
User-agent: Perplexity-User
User-agent: Amzn-User
User-agent: MistralAI-User
Allow: /

User-agent: GPTBot
User-agent: ClaudeBot
Disallow: /

User-agent: *
Content-Signal: search=yes, ai-input=yes, ai-train=no
Content-Usage: train-ai=n, search=y
Allow: /

Sitemap: https://example.com/sitemap.xml
`;

test('robots-syntax: clean passes, stray rule fails, unknown field warns', async () => {
  assert.equal((await mockSite({ '/robots.txt': text(GOOD_ROBOTS) }).run('crawl.robots-syntax')).status, 'pass');
  assert.equal((await mockSite({ '/robots.txt': text('Disallow: /x\nUser-agent: *\nAllow: /') }).run('crawl.robots-syntax')).status, 'fail');
  assert.equal((await mockSite({ '/robots.txt': text('User-agent: *\nDisalow: /x') }).run('crawl.robots-syntax')).status, 'warn');
  assert.equal((await mockSite({}).run('crawl.robots-syntax')).status, 'neutral');
});

test('ai-bot-rules: named tokens pass; wildcard only warns but is compat pass; none fails', async () => {
  const a = await mockSite({ '/robots.txt': text(GOOD_ROBOTS) }).run('crawl.ai-bot-rules');
  assert.equal(a.status, 'pass'); assert.equal(a.compat.status, 'pass');
  const b = await mockSite({ '/robots.txt': text('User-agent: *\nAllow: /') }).run('crawl.ai-bot-rules');
  assert.equal(b.status, 'warn'); assert.equal(b.compat.status, 'pass');
  const c = await mockSite({ '/robots.txt': text('User-agent: Googlebot\nAllow: /') }).run('crawl.ai-bot-rules');
  assert.equal(c.status, 'fail'); assert.equal(c.compat.status, 'fail');
});

test('ai-crawler-matrix: consistent policy passes with 17 rows; search blocked while training allowed warns', async () => {
  const a = await mockSite({ '/robots.txt': text(GOOD_ROBOTS) }).run('crawl.ai-crawler-matrix');
  assert.equal(a.status, 'pass');
  assert.equal(a.details.agents.length, 17);
  assert.equal(a.details.tally.search.allowed, 5);
  const b = await mockSite({ '/robots.txt': text('User-agent: OAI-SearchBot\nDisallow: /\n\nUser-agent: *\nAllow: /') }).run('crawl.ai-crawler-matrix');
  assert.equal(b.status, 'warn');
  assert.match(b.message, /OAI-SearchBot/);
  const c = await mockSite({ '/robots.txt': text('User-agent: *\nDisallow: /') }).run('crawl.ai-crawler-matrix');
  assert.equal(c.status, 'warn');
  assert.match(c.message, /every AI crawler/);
  assert.equal((await mockSite({}).run('crawl.ai-crawler-matrix')).status, 'info');
});

test('content-signal and content-signal-valid', async () => {
  const a = await mockSite({ '/robots.txt': text(GOOD_ROBOTS) }).run('crawl.content-signal');
  assert.equal(a.status, 'pass'); assert.equal(a.compat.status, 'pass');
  const b = await mockSite({ '/robots.txt': text('User-agent: *\nAllow: /') }).run('crawl.content-signal');
  assert.equal(b.status, 'fail'); assert.equal(b.compat.status, 'fail');
  assert.equal((await mockSite({ '/robots.txt': text(GOOD_ROBOTS) }).run('crawl.content-signal-valid')).status, 'pass');
  const c = await mockSite({ '/robots.txt': text('Content-Signal: ai-train=maybe\nUser-agent: *\nAllow: /') }).run('crawl.content-signal-valid');
  assert.equal(c.status, 'fail');
  assert.equal((await mockSite({ '/robots.txt': text('User-agent: *\nAllow: /') }).run('crawl.content-signal-valid')).status, 'neutral');
});

test('aipref-usage: valid passes, Content-Signal keys warn, absent is info', async () => {
  assert.equal((await mockSite({ '/robots.txt': text(GOOD_ROBOTS), '/': html('<p>x</p>') }).run('crawl.aipref-usage')).status, 'pass');
  const b = await mockSite({ '/robots.txt': text('User-agent: *\nContent-Usage: ai-train=no\nAllow: /'), '/': html('<p>x</p>') }).run('crawl.aipref-usage');
  assert.equal(b.status, 'warn');
  assert.equal((await mockSite({ '/robots.txt': text('User-agent: *\nAllow: /'), '/': html('<p>x</p>') }).run('crawl.aipref-usage')).status, 'info');
  const d = await mockSite({ '/robots.txt': text('User-agent: *\nContent-Usage: /ok/ train-ai=y\nAllow: /'), '/': html('<p>x</p>', { 'content-usage': 'train-ai=n' }) }).run('crawl.aipref-usage');
  assert.equal(d.status, 'pass');
});

test('robots-meta: noindex for all fails, scoped warns, clean passes', async () => {
  assert.equal((await mockSite({ '/': html('<meta name="robots" content="noindex"><p>x</p>') }).run('crawl.robots-meta')).status, 'fail');
  assert.equal((await mockSite({ '/': html('<p>x</p>', { 'x-robots-tag': 'none' }) }).run('crawl.robots-meta')).status, 'fail');
  assert.equal((await mockSite({ '/': html('<p>x</p>', { 'x-robots-tag': 'googlebot: noindex' }) }).run('crawl.robots-meta')).status, 'warn');
  assert.equal((await mockSite({ '/': html('<meta name="robots" content="index, follow"><p>x</p>') }).run('crawl.robots-meta')).status, 'pass');
});

test('bot-challenge: bot-only block fails, both blocked warns, open passes', async () => {
  const byUa = (bot, browser) => ({ '/': ({ headers }) => (/Mozilla/.test(headers['user-agent']) ? browser : bot) });
  const ok = html('<h1>Hi</h1>');
  const wall = { status: 403, headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' }, body: '<title>Just a moment...</title>' };
  assert.equal((await mockSite(byUa(wall, ok)).run('crawl.bot-challenge')).status, 'fail');
  assert.equal((await mockSite(byUa(wall, wall)).run('crawl.bot-challenge')).status, 'warn');
  assert.equal((await mockSite(byUa(ok, ok)).run('crawl.bot-challenge')).status, 'pass');
  assert.equal(challengeOf({ status: 200, headers: {}, text: '<title>Just a moment...</title>' }).kind, 'challenge');
});

test('sitemap: well-known XML passes; a robots line to a missing sitemap fails compat (like the live scanner); none fails', async () => {
  const s = urlset([['https://example.com/', '2026-10-01'], ['https://example.com/a', '2026-10-02']]);
  const a = await mockSite({ '/sitemap.xml': xml(s) }).run('crawl.sitemap');
  assert.equal(a.status, 'pass'); assert.equal(a.compat.status, 'pass');
  const b = await mockSite({ '/robots.txt': text('User-agent: *\nAllow: /\nSitemap: https://example.com/missing.xml') }).run('crawl.sitemap');
  assert.equal(b.status, 'warn'); assert.equal(b.compat.status, 'fail');
  const okLine = await mockSite({ '/robots.txt': text('User-agent: *\nAllow: /\nSitemap: https://example.com/s.xml'), '/s.xml': xml(s) }).run('crawl.sitemap');
  assert.equal(okLine.compat.status, 'pass');
  const c = await mockSite({ '/sitemap.xml': html('<html>home</html>') }).run('crawl.sitemap');
  assert.equal(c.status, 'fail'); assert.equal(c.compat.status, 'fail');
});

test('sitemap-valid and sitemap-lastmod', async () => {
  const good = urlset([['https://example.com/', '2026-10-01'], ['https://example.com/a', '2026-10-02T10:00:00+01:00']]);
  assert.equal((await mockSite({ '/sitemap.xml': xml(good) }).run('crawl.sitemap-valid')).status, 'pass');
  assert.equal((await mockSite({ '/sitemap.xml': xml(good) }).run('crawl.sitemap-lastmod')).status, 'pass');
  const off = urlset([['https://other.org/', null], ['https://other.org/a', null]]);
  assert.equal((await mockSite({ '/sitemap.xml': xml(off) }).run('crawl.sitemap-valid')).status, 'fail');
  assert.equal((await mockSite({ '/sitemap.xml': xml(off) }).run('crawl.sitemap-lastmod')).status, 'fail');
  const same = urlset([1, 2, 3, 4, 5].map((i) => [`https://example.com/${i}`, '2026-10-01']));
  assert.equal((await mockSite({ '/sitemap.xml': xml(same) }).run('crawl.sitemap-lastmod')).status, 'warn');
  const fut = urlset([['https://example.com/', '2099-01-01']]);
  assert.equal((await mockSite({ '/sitemap.xml': xml(fut) }).run('crawl.sitemap-lastmod')).status, 'warn');
  assert.equal((await mockSite({}).run('crawl.sitemap-valid')).status, 'neutral');
});

test('sitemap index: the first child is sampled', async () => {
  const idx = '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://example.com/s1.xml</loc></sitemap></sitemapindex>';
  const r = await mockSite({ '/sitemap.xml': xml(idx), '/s1.xml': xml(urlset([['https://example.com/x', '2026-10-01']])) }).run('crawl.sitemap-valid');
  assert.equal(r.status, 'pass');
  assert.equal(r.details.sampledChild, 'https://example.com/s1.xml');
});

test('parseSitemap handles prefixes, CDATA and entities', () => {
  const p = parseSitemap('<s:urlset xmlns:s="x"><s:url><s:loc><![CDATA[https://e.com/?a=1&b=2]]></s:loc></s:url><s:url><s:loc>https://e.com/?a=1&amp;b=2</s:loc></s:url></s:urlset>');
  assert.equal(p.kind, 'urlset');
  assert.deepEqual(p.entries.map((e) => e.loc), ['https://e.com/?a=1&b=2', 'https://e.com/?a=1&b=2']);
  assert.equal(parseSitemap('<html></html>').kind, null);
});

test('sitemap-in-robots', async () => {
  assert.equal((await mockSite({ '/robots.txt': text(GOOD_ROBOTS) }).run('crawl.sitemap-in-robots')).status, 'pass');
  assert.equal((await mockSite({ '/robots.txt': text('User-agent: *\nAllow: /\nSitemap: /sitemap.xml') }).run('crawl.sitemap-in-robots')).status, 'warn');
  assert.equal((await mockSite({ '/robots.txt': text('User-agent: *\nAllow: /') }).run('crawl.sitemap-in-robots')).status, 'fail');
});

test('tdmrep: absent info, valid pass, invalid warn', async () => {
  assert.equal((await mockSite({ '/': html('<p>x</p>') }).run('crawl.tdmrep')).status, 'info');
  assert.equal((await mockSite({ '/': html('<p>x</p>'), '/.well-known/tdmrep.json': json([{ location: '/', 'tdm-reservation': 1 }]) }).run('crawl.tdmrep')).status, 'pass');
  assert.equal((await mockSite({ '/': html('<p>x</p>'), '/.well-known/tdmrep.json': json({ location: '/' }) }).run('crawl.tdmrep')).status, 'warn');
  assert.equal((await mockSite({ '/': html('<meta name="tdm-reservation" content="yes"><p>x</p>') }).run('crawl.tdmrep')).status, 'warn');
});

test('rsl: absent info, valid pass, broken pointer warns', async () => {
  const site = (lic) => mockSite({ '/': html('<p>x</p>'), '/robots.txt': text('User-agent: *\nAllow: /\nLicense: https://example.com/license.xml'), '/license.xml': lic });
  assert.equal((await site(xml('<rsl xmlns="https://rslstandard.org/rsl"><content url="/"/></rsl>')).run('crawl.rsl')).status, 'pass');
  assert.equal((await site(status(404)).run('crawl.rsl')).status, 'warn');
  assert.equal((await mockSite({ '/': html('<p>x</p>') }).run('crawl.rsl')).status, 'info');
});
