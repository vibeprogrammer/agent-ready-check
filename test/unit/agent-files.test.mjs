// H4: the service's own agent files are well-formed and agree with each other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as files from '../../src/agent-files/index.mjs';
import { parseRobots, isAllowed } from '../../src/core/parse/robots.mjs';
import { AI_CRAWLERS } from '../../src/agent-files/crawlers.mjs';
import { TOOLS } from '../../src/mcp/server.mjs';

const BASE = 'https://checker.example';

test('robots.txt: valid RFC 9309, named AI groups, Content-Signal in every group, Sitemap and Agentmap', () => {
  const p = parseRobots(files.robotsTxt(BASE));
  assert.equal(p.errors.length, 0);
  assert.equal(p.unknown.length, 0, JSON.stringify(p.unknown));
  const named = p.groups.flatMap((g) => g.agents);
  for (const t of [...AI_CRAWLERS.search, ...AI_CRAWLERS.training, ...AI_CRAWLERS.user]) assert.ok(named.includes(t), t);
  assert.equal(p.contentSignals.length, p.groups.length, 'one Content-Signal per group');
  for (const cs of p.contentSignals) assert.deepEqual(cs.pairs, { search: 'yes', 'ai-input': 'yes', 'ai-train': 'yes' });
  assert.deepEqual(p.sitemaps, [`${BASE}/sitemap.xml`]);
  assert.deepEqual(p.agentmaps, [`${BASE}/.well-known/ard.json`]);
  assert.equal(isAllowed(p, 'GPTBot', '/').allowed, true);
  assert.equal(isAllowed(p, 'OAI-SearchBot', '/docs').allowed, true);
  assert.equal(isAllowed(p, 'SomeBot', '/api/scan').allowed, false, 'crawlers do not start scans');
  assert.equal(isAllowed(p, 'ChatGPT-User', '/scan').allowed, true, 'assistants acting for a person may');
});

test('sitemap.xml lists every page with W3C lastmod, same origin', () => {
  const x = files.sitemapXml(BASE);
  const locs = [...x.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.equal(locs.length, files.PAGES.length);
  assert.ok(locs.every((l) => l.startsWith(BASE)));
  const mods = [...x.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1]);
  assert.equal(mods.length, locs.length);
  assert.ok(mods.every((m) => /^\d{4}-\d{2}-\d{2}$/.test(m)));
});

test('llms.txt follows the llmstxt.org shape: H1, blockquote, H2 sections, Markdown links, >= 50 chars', () => {
  const t = files.llmsTxt(BASE);
  const lines = t.split('\n');
  assert.match(lines[0], /^# \S/);
  assert.ok(lines.some((l) => l.startsWith('> ')));
  assert.ok(lines.filter((l) => l.startsWith('## ')).length >= 2);
  assert.ok(/\[[^\]]+\]\(https?:\/\/[^)]+\)/.test(t));
  assert.ok(t.length >= 50);
  assert.ok(!/<html/i.test(t));
  const full = files.llmsFullTxt(BASE);
  assert.ok(full.length > t.length * 3);
  assert.ok(full.includes('`crawl.robots-txt`') && full.includes('`mcp.server-card`'), 'llms-full lists the checks');
});

test('API catalog is an RFC 9727 linkset with anchors and service-desc', () => {
  const c = files.apiCatalog(BASE);
  assert.ok(Array.isArray(c.linkset) && c.linkset.length >= 1);
  for (const e of c.linkset) {
    assert.ok(e.anchor.startsWith(BASE));
    assert.ok(e['service-desc']?.[0]?.href.startsWith(BASE));
  }
  assert.match(files.LINKSET_TYPE, /^application\/linkset\+json/);
});

test('OpenAPI 3.1: every operation has operationId, summary, description, responses with schemas and problem+json errors', () => {
  const o = files.openapi(BASE);
  assert.equal(o.openapi, '3.1.0');
  assert.ok(o.info.title && o.info.version);
  const ids = new Set();
  for (const [path, item] of Object.entries(o.paths)) {
    for (const [method, op] of Object.entries(item)) {
      assert.ok(op.operationId && !ids.has(op.operationId), `${method} ${path} operationId`);
      ids.add(op.operationId);
      assert.ok(op.summary && op.description, `${method} ${path} summary/description`);
      for (const p of op.parameters || []) assert.ok(p.$ref || p.description, `${op.operationId} parameter described`);
      assert.ok(op.responses['200'], `${op.operationId} 200`);
      const errs = Object.entries(op.responses).filter(([s]) => Number(s) >= 400);
      for (const [, r] of errs) assert.ok(r.content['application/problem+json'], `${op.operationId} problem+json`);
    }
  }
  // every $ref resolves
  const json = JSON.stringify(o);
  for (const [, ref] of json.matchAll(/"\$ref":"#\/([^"]+)"/g)) {
    let node = o;
    for (const part of ref.split('/')) node = node?.[part];
    assert.ok(node, `ref #/${ref}`);
  }
});

test('MCP server card has a flat name, version, remotes with our protocols and capabilities', () => {
  const c = files.serverCard(BASE);
  assert.match(c.name, /^example\.checker\/agent-ready-check$/);
  assert.ok(c.version);
  assert.equal(c.remotes[0].url, `${BASE}/mcp`);
  assert.deepEqual(c.remotes[0].supportedProtocolVersions, files.MCP_PROTOCOLS);
  assert.ok(c.capabilities.tools);
  assert.equal(TOOLS.length, 4);
});

test('Agent Skills index v0.2.0: digest is the sha256 of SKILL.md as served', async () => {
  const idx = await files.agentSkillsIndex(BASE);
  assert.match(idx.$schema, /0\.2\.0/);
  const s = idx.skills[0];
  for (const k of ['name', 'type', 'description', 'url', 'digest']) assert.ok(s[k], k);
  const md = files.skillMd(BASE);
  assert.equal(s.digest, `sha256:${createHash('sha256').update(md).digest('hex')}`);
  assert.match(md, /^---\nname: agent-ready-check\ndescription: /);
  assert.ok(md.includes(`${BASE}/mcp`));
});

test('ARD manifest: specVersion, host, urn:air identifiers, media types, exactly one of url/data', () => {
  const a = files.ardManifest(BASE);
  assert.ok(a.specVersion);
  assert.ok(a.host?.displayName);
  for (const e of a.entries) {
    assert.match(e.identifier, /^urn:air:checker\.example:[a-z]+:[a-z0-9-]+$/);
    assert.ok(e.displayName);
    assert.match(e.type, /^[a-z]+\/[a-z0-9.+-]+$/);
    assert.ok(('url' in e) !== ('data' in e));
  }
});

test('security.txt: Contact and an Expires less than a year away', () => {
  const now = Date.UTC(2026, 10, 3);
  const t = files.securityTxt(BASE, now);
  assert.match(t, /^Contact: https:\/\/github\.com\/.+\/issues$/m);
  const exp = Date.parse(/^Expires: (.+)$/m.exec(t)[1]);
  assert.ok(exp > now && exp - now < 365 * 24 * 3600 * 1000);
});

test('pages Markdown: docs, checks, privacy, home', () => {
  assert.match(files.docsMd(BASE), /^# API, MCP, WebMCP and CLI/);
  const checks = files.checksMd(BASE);
  assert.ok((checks.match(/^- `/gm) || []).length >= 100);
  assert.match(files.privacyMd(BASE), /30 days/);
  assert.match(files.homeMd(BASE), /^# Agent-Ready Check/);
  assert.deepEqual(files.gpcJson().gpc, true);
});
