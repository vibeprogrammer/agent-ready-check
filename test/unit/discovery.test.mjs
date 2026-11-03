import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mockSite, html, json, text, status } from '../helpers/mock-site.mjs';
import { sha256Hex } from '../../src/checks/discovery.mjs';

// Fixtures adapted from agent-ready-web-demos (MIT), nordlys-cabins/layers/11-discovery.
const O = 'https://example.com';
const SKILL = '---\nname: book-a-nordlys-cabin\ndescription: Book a cabin\n---\n# Book a Nordlys cabin\n';
const digest = 'sha256:' + createHash('sha256').update(SKILL).digest('hex');
const ard = { specVersion: '1.0', entries: [
  { identifier: 'urn:air:example.com:mcp:booking', displayName: 'Nordlys Cabins booking', type: 'application/mcp-server-card+json', url: `${O}/mcp/server-card` },
  { identifier: 'urn:air:example.com:skill:book-a-nordlys-cabin', displayName: 'Book a Nordlys cabin', type: 'application/agent-skills+md', url: `${O}/.well-known/agent-skills/book-a-nordlys-cabin/SKILL.md` },
] };
const skills = { $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json', skills: [{ name: 'book-a-nordlys-cabin', type: 'skill-md', description: 'Find, price and book a holiday cabin.', url: '/.well-known/agent-skills/book-a-nordlys-cabin/SKILL.md', digest }] };
const good = () => ({
  '/': html('<h1>x</h1>', { link: '</.well-known/ard.json>; rel="ard"' }),
  '/.well-known/ard.json': json(ard),
  '/.well-known/agent-skills/index.json': json(skills),
  '/.well-known/agent-skills/book-a-nordlys-cabin/SKILL.md': text(SKILL, { 'content-type': 'text/markdown; charset=utf-8' }),
});

test('sha256Hex matches node:crypto', async () => {
  assert.equal(await sha256Hex('abc'), createHash('sha256').update('abc').digest('hex'));
});

test('discovery.ard finds the manifest via Link header; legacy location warns; none fails', async () => {
  const r = await mockSite(good()).run('discovery.ard');
  assert.equal(r.status, 'pass'); assert.equal(r.compat.status, 'pass'); assert.match(r.message, /Link header/);
  const robots = await mockSite({ '/robots.txt': text('User-agent: *\nAllow: /\nAgentmap: https://example.com/x/ard.json\n'), '/x/ard.json': json(ard) }).run('discovery.ard');
  assert.equal(robots.status, 'pass');
  const legacy = await mockSite({ '/.well-known/ai-catalog.json': json(ard) }).run('discovery.ard');
  assert.equal(legacy.status, 'warn'); assert.equal(legacy.compat.status, 'pass');
  const none = await mockSite({ '/': html('<p>x</p>') }).run('discovery.ard');
  assert.equal(none.status, 'fail'); assert.equal(none.compat.status, 'fail');
});

test('discovery.ard-valid: neutral when absent, pass for Nordlys, fail on bad entries', async () => {
  assert.equal((await mockSite({}).run('discovery.ard-valid')).status, 'neutral');
  assert.equal((await mockSite(good()).run('discovery.ard-valid')).status, 'pass');
  const bad = { specVersion: '1.0', entries: [{ identifier: 'booking', type: 'mcp', url: 'x', data: {} }] };
  const r = await mockSite({ '/.well-known/ard.json': json(bad) }).run('discovery.ard-valid');
  assert.equal(r.status, 'fail'); assert.ok(r.details.errors.length >= 3);
});

test('discovery.agent-skills: index passes, legacy warns, missing fails', async () => {
  const r = await mockSite(good()).run('discovery.agent-skills');
  assert.equal(r.status, 'pass'); assert.equal(r.compat.status, 'pass');
  const l = await mockSite({ '/.well-known/skills/index.json': json(skills) }).run('discovery.agent-skills');
  assert.equal(l.status, 'warn'); assert.equal(l.compat.status, 'pass');
  assert.equal((await mockSite({}).run('discovery.agent-skills')).compat.status, 'fail');
});

test('discovery.agent-skills-valid verifies digests', async () => {
  const r = await mockSite(good()).run('discovery.agent-skills-valid');
  assert.equal(r.status, 'pass'); assert.equal(r.details.digestsMatched, 1);
  const g = good(); g['/.well-known/agent-skills/book-a-nordlys-cabin/SKILL.md'] = text(SKILL + 'changed');
  const f = await mockSite(g).run('discovery.agent-skills-valid');
  assert.equal(f.status, 'fail'); assert.match(f.message, /digest/);
  const arch = { $schema: skills.$schema, skills: [{ name: 'tools', type: 'archive', description: 'Zip of tools', url: '/s/tools.zip', digest: 'sha256:00' }] };
  const a = await mockSite({ '/.well-known/agent-skills/index.json': json(arch), '/s/tools.zip': { status: 200, headers: { 'content-type': 'application/zip' }, body: 'PK' } }).run('discovery.agent-skills-valid');
  assert.equal(a.status, 'fail'); // archives are hashed over the raw bytes too, and sha256:00 does not match
  const m = await mockSite({ '/.well-known/agent-skills/index.json': json({ skills: [{ name: 'x' }] }) }).run('discovery.agent-skills-valid');
  assert.equal(m.status, 'fail');
});

test('discovery.a2a-card follows the iia rule', async () => {
  const r = await mockSite({ '/.well-known/agent-card.json': json({ name: 'a', version: '1', supportedInterfaces: [{ url: 'https://example.com/a2a' }] }) }).run('discovery.a2a-card');
  assert.equal(r.status, 'pass');
  assert.equal((await mockSite({ '/.well-known/agent-card.json': json({ name: 'a' }) }).run('discovery.a2a-card')).compat.status, 'fail');
});

test('discovery.dns-aid needs the AD flag and a ServiceMode record', async () => {
  const doh = (ad, data) => ({ url }) => (url.searchParams.get('name').startsWith('_index') && url.searchParams.get('type') === 'SVCB'
    ? json({ AD: ad, Answer: [{ type: 64, data }] }, { 'content-type': 'application/dns-json' })
    : json({ AD: ad, Answer: [] }, { 'content-type': 'application/dns-json' }));
  // the mock site routes by pathname too, so the DoH handler sits under /dns-query
  const mk = (ad, data) => mockSite({ '/dns-query': doh(ad, data) });
  assert.equal((await mk(true, '1 agents.example.com. alpn=h2').run('discovery.dns-aid')).status, 'pass');
  assert.equal((await mk(false, '1 agents.example.com.').run('discovery.dns-aid')).status, 'warn');
  assert.equal((await mk(true, '0 alias.example.com.').run('discovery.dns-aid')).status, 'fail');
});

test('discovery.poppy: valid manifest passes; missing fails', async () => {
  assert.equal((await mockSite({ '/.well-known/poppy.json': json({ organization: 'Ex', domain: 'example.com', interfaces: { web: {} } }) }).run('discovery.poppy')).status, 'pass');
  const a = await mockSite({ '/.well-known/poppy.json': json({ organization: 'Ex', interfaces: { web: {} }, auth: {} }), '/.well-known/oauth-authorization-server': json({ issuer: O }) }).run('discovery.poppy');
  assert.equal(a.status, 'fail'); assert.match(a.message, /poppy_domains/);
  assert.equal((await mockSite({}).run('discovery.poppy')).status, 'fail');
});

test('discovery.soft-404: real 404s pass, 200 well-known fails, 200 pages warn', async () => {
  assert.equal((await mockSite({ '/': html('x') }).run('discovery.soft-404')).status, 'pass');
  const spa = (code) => ({ url }) => (url.pathname.startsWith('/.well-known/') ? status(code) : html('<div id=app></div>'));
  // every path answers through the same handler (a single-page app with an HTML fallback)
  const site = (fn) => mockSite(new Proxy({}, { get: (_, k) => (typeof k === 'string' && k.startsWith('/') ? fn : undefined) }));
  assert.equal((await site(spa(200)).run('discovery.soft-404')).status, 'fail');
  assert.equal((await site(spa(404)).run('discovery.soft-404')).status, 'warn');
});

test('discovery.wellknown-types: JSON types pass, text/plain warns, broken JSON fails, none neutral', async () => {
  assert.equal((await mockSite({ '/.well-known/ard.json': json(ard) }).run('discovery.wellknown-types')).status, 'pass');
  assert.equal((await mockSite({ '/.well-known/ard.json': text(JSON.stringify(ard)) }).run('discovery.wellknown-types')).status, 'warn');
  assert.equal((await mockSite({ '/.well-known/gpc.json': json('{"gpc": tru') }).run('discovery.wellknown-types')).status, 'fail');
  assert.equal((await mockSite({}).run('discovery.wellknown-types')).status, 'neutral');
});
