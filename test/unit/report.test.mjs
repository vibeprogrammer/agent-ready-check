import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockSite, html, text } from '../helpers/mock-site.mjs';
import { parseDocument } from '../../src/core/html.mjs';
import { renderReportHtml, renderHomeHtml, renderReportMarkdown, renderFixPrompts, renderBadge, badgeWidth, parseFilter, chapterLink, reportLinks, ASSETS } from '../../src/report/index.mjs';

const EVIL = '<script>alert(1)</script><img src=x onerror=alert(2)>';
async function evilReport() {
  const site = mockSite({
    '/': html(`<!doctype html><html lang="en"><head><title>${EVIL}</title></head><body><main><h1>${EVIL}</h1><form action="/s"><input name="q"></form></main></body></html>`, { 'x-evil': EVIL }),
    '/robots.txt': text(`User-agent: *\nAllow: /\n# ${EVIL}\n`),
  });
  const report = await site.scan({});
  // make sure untrusted text reaches every rendered field
  report.checks[0].message = `Found ${EVIL}`;
  report.checks[0].details = { title: EVIL };
  report.checks[0].fix.hint = EVIL;
  report.checks[0].evidence.push({ note: EVIL });
  report.final_url = `https://example.com/${encodeURIComponent('"><script>')}`;
  return report;
}

test('renderReportHtml escapes every site-controlled string', async () => {
  const report = await evilReport();
  const out = renderReportHtml(report, { baseUrl: 'https://check.example', reportId: 'r1' });
  assert.ok(!out.includes('<script>alert'), 'no raw script from the site');
  assert.ok(!out.includes('<img src=x'), 'no raw img from the site');
  assert.ok(out.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  // only our own script tags: the module and the JSON-LD block
  assert.deepEqual([...out.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]).sort(), ['<script type="application/ld+json">', '<script type="module" src="/assets/app.js?v=1">'].sort());
  const doc = parseDocument(out);
  const handlers = [...doc.querySelectorAll('*')].filter((el) => [...el.attributes].some((a) => /^on/i.test(a.name)));
  assert.equal(handlers.length, 0, 'no inline event handlers');
  assert.equal(doc.querySelectorAll('img').length, 1, 'only our badge image');
  assert.equal(doc.querySelectorAll('[style], style').length, 0, 'no inline styles (CSP style-src self)');
});

test('renderReportHtml has the key parts', async () => {
  const report = await evilReport();
  const out = renderReportHtml(report, { baseUrl: 'https://check.example', reportId: 'r1' });
  for (const part of ['<main id="main">', 'aria-label="Agent-Ready score', 'isitagentready-compatible level', 'Lighthouse Agentic Browsing view', 'id="layers-h"', 'id="filters"', 'toolname="filter_findings"', 'toolname="scan_site"', 'Copy all fix prompts', 'Where we differ from Cloudflare', 'https://check.example/r/r1', '/badge/example.com.svg', 'What the standard badges mean', 'id="requests"', '<meta name="robots" content="noindex">']) {
    assert.ok(out.includes(part), `missing ${part}`);
  }
  assert.equal((out.match(/<details class="finding/g) || []).length, report.checks.length);
  assert.equal((out.match(/<h1\b/g) || []).length, 1);
});

test('server-side filters hide non-matching findings with the hidden attribute', async () => {
  const report = await evilReport();
  const f = parseFilter(new URLSearchParams('role=security&status=fail'));
  assert.deepEqual(f, { role: 'security', status: ['fail'] });
  const out = renderReportHtml(report, { filter: f });
  const shown = [...out.matchAll(/<details class="finding[^>]*>/g)].filter((m) => !m[0].includes(' hidden'));
  const expected = report.checks.filter((c) => c.roles.includes('security') && c.status === 'fail').length;
  assert.equal(shown.length, expected);
  assert.equal(parseFilter({ role: 'nope', status: 'fail,bogus' }).role, 'all');
  assert.deepEqual(parseFilter({ status: 'fail,bogus' }).status, ['fail']);
});

test('unstored reports keep the url parameter in filter links', async () => {
  const report = await evilReport();
  const out = renderReportHtml(report, {});
  assert.ok(out.includes('<input type="hidden" name="url" value="example.com">'));
});

test('renderReportMarkdown escapes Markdown and HTML from the site', async () => {
  const report = await evilReport();
  const md = renderReportMarkdown(report, { baseUrl: 'https://check.example', reportId: 'r1' });
  assert.ok(md.startsWith('# Agent-readiness report'));
  assert.ok(md.includes('Agent-Ready score: **'));
  assert.ok(!md.includes('<script>'));
  assert.ok(md.includes('\\<script\\>'));
  const agent = renderReportMarkdown(report, { format: 'agent' });
  assert.ok(agent.includes('## Fixes, most important first'));
  assert.ok(!agent.includes('## Layers'));
});

test('renderFixPrompts lists every fail and warn with its prompt, fences cannot be broken', async () => {
  const report = await evilReport();
  report.checks[0].status = 'fail';
  report.checks[0].fix.snippet = 'a\n```\nbreak out';
  const p = renderFixPrompts(report, { baseUrl: 'https://check.example' });
  const todo = report.checks.filter((c) => c.status === 'fail' || c.status === 'warn').length;
  assert.equal((p.match(/^## \d+\. /gm) || []).length, todo);
  assert.ok(p.includes('````\na\n```\nbreak out\n````'));
  assert.ok(p.includes('When done, re-scan: https://check.example/scan?url=example.com'));
});

test('renderBadge: valid SVG, escaped label, colours by score, width helper', () => {
  const svg = renderBadge({ score: 92, level: 4 });
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(svg.includes('92/100 · L4'));
  assert.ok(svg.includes('#1a7f37'));
  assert.ok(renderBadge({ score: 10 }).includes('#c62828'));
  assert.ok(renderBadge({}).includes('not scanned'));
  assert.ok(!renderBadge({ score: 50, label: '<x>' }).includes('<x>'));
  assert.equal(badgeWidth({ score: 92, level: 4 }), Number(/width="(\d+)"/.exec(svg)[1]));
});

test('home page: real GET form, declarative scan_site tool, landmarks', () => {
  const out = renderHomeHtml({ baseUrl: 'https://check.example', browserAvailable: true });
  assert.ok(out.includes('<form class="scan" id="scan" action="/scan" method="get"'));
  assert.ok(out.includes('toolname="scan_site"'));
  assert.ok(out.includes('toolparamdescription='));
  assert.ok(out.includes('name="browser"'));
  assert.ok(out.includes('<link rel="canonical" href="https://check.example/">'));
  for (const l of ['<header class="site">', '<nav aria-label="Main">', '<main id="main">', '<footer class="site">', '<html lang="en">']) assert.ok(out.includes(l), l);
  assert.ok(!renderHomeHtml({}).includes('name="browser"'));
});

test('links and assets', () => {
  assert.equal(chapterLink(9), 'https://github.com/webmaxru/agent-ready-web-demos/tree/main/nordlys-cabins/layers/09-webmcp');
  assert.equal(chapterLink(3), 'https://github.com/webmaxru/agent-ready-web-demos/tree/main/chapters/03-how-agents-see-a-page');
  assert.equal(chapterLink(1), 'https://github.com/webmaxru/agent-ready-web-demos');
  assert.equal(reportLinks('https://x.example/', 'a b').html, 'https://x.example/r/a%20b');
  assert.deepEqual(Object.keys(ASSETS).sort(), ['/assets/app.css', '/assets/app.js', '/assets/favicon.svg']);
  assert.match(ASSETS['/assets/app.js'].body, /registerTool/);
  assert.match(ASSETS['/assets/app.css'].body, /prefers-color-scheme:dark/);
});
