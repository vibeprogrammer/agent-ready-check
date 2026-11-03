import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockSite, html, text } from '../helpers/mock-site.mjs';
import { decodeOriginTrial, lintDeclarative, lintSchema } from '../../src/checks/webmcp.mjs';
import { parseDocument } from '../../src/core/html.mjs';

const page = (body, head = '') => html(`<!doctype html><html lang="en"><head><title>T</title>${head}</head><body><main>${body}</main></body></html>`);
const tool = (o) => ({ name: 'get_cabin', description: 'Get one cabin by its slug, with price and photos.', inputSchema: { type: 'object', properties: { cabin: { type: 'string', description: 'Cabin slug' } }, required: ['cabin'] }, annotations: { readOnlyHint: true }, source: 'imperative', ...o });
const bd = (tools, extra = {}) => ({ ok: true, renderedHtml: extra.renderedHtml || '', webmcp: { supported: true, tools, error: null }, ...extra });
const run = (id, routes, browserData = null) => mockSite(routes, { browserData }).run(id);

// A real Chrome origin-trial token layout: version byte, 64-byte signature, 4-byte length, JSON payload.
function token(payload) {
  const json = JSON.stringify(payload);
  const bytes = [3, ...new Array(64).fill(7), (json.length >>> 24) & 255, (json.length >>> 16) & 255, (json.length >>> 8) & 255, json.length & 255, ...[...json].map((c) => c.charCodeAt(0))];
  return btoa(String.fromCharCode(...bytes));
}

test('webmcp.tools: static fallback passes on a declarative form (isitagentready rule)', async () => {
  const r = await run('webmcp.tools', { '/': page('<form toolname="search_x" tooldescription="Search x by keyword"><input name="q"></form>') });
  assert.equal(r.status, 'pass');
  assert.equal(r.compat.status, 'pass');
});

test('webmcp.tools: static fallback finds registerTool in a same-origin script', async () => {
  const r = await run('webmcp.tools', { '/': page('<script src="/app.js"></script>'), '/app.js': text("document.modelContext.registerTool({ name: 'a', inputSchema: {} })", { 'content-type': 'text/javascript' }) });
  assert.equal(r.status, 'pass');
  assert.equal(r.details.staticScripts.length, 1);
});

test('webmcp.tools: fails without tools, compat fail', async () => {
  const r = await run('webmcp.tools', { '/': page('<p>Hello</p>') });
  assert.equal(r.status, 'fail');
  assert.equal(r.compat.status, 'fail');
});

test('webmcp.tools: browser tools pass; source code without registration warns', async () => {
  const ok = await run('webmcp.tools', { '/': page('<p>x</p>') }, bd([tool()]));
  assert.equal(ok.status, 'pass');
  assert.match(ok.message, /1 imperative/);
  const broken = await run('webmcp.tools', { '/': page('<script>document.modelContext.registerTool({name:"x"})</script>') }, bd([]));
  assert.equal(broken.status, 'warn');
  assert.equal(broken.compat.status, 'pass');
});

test('webmcp.form-coverage: pass, partial warn, none fail; login forms are not counted', async () => {
  const covered = '<form toolname="a_b" tooldescription="Do a thing for b"><input name="q"></form>';
  const bare = '<form action="/c"><input name="c"></form>';
  const login = '<form action="/login"><input name="u"><input type="password" name="p"></form>';
  assert.equal((await run('webmcp.form-coverage', { '/': page(covered + login) })).status, 'pass');
  assert.equal((await run('webmcp.form-coverage', { '/': page(covered + bare) })).status, 'warn');
  assert.equal((await run('webmcp.form-coverage', { '/': page(bare) })).status, 'fail');
  assert.equal((await run('webmcp.form-coverage', { '/': page(login) })).status, 'neutral');
});

test('webmcp.schema-validity: Lighthouse 0 / 0.5 / 1', async () => {
  const clean = '<form toolname="find_booking" tooldescription="Find a booking by reference"><label>Ref <input name="ref" required></label><input name="note" toolparamdescription="Optional note"></form>';
  const warnOnly = '<form toolname="find_booking" tooldescription="Find a booking by reference"><input name="note"></form>';
  const error = '<form tooldescription="No name here"><input required></form>';
  const a = await run('webmcp.schema-validity', { '/': page(clean) });
  assert.equal(a.status, 'pass'); assert.equal(a.details.lighthouseScore, 1);
  const b = await run('webmcp.schema-validity', { '/': page(warnOnly) });
  assert.equal(b.status, 'warn'); assert.equal(b.details.lighthouseScore, 0.5);
  const c = await run('webmcp.schema-validity', { '/': page(error) });
  assert.equal(c.status, 'fail'); assert.equal(c.details.lighthouseScore, 0);
  assert.deepEqual(c.details.errors.map((e) => e.rule).sort(), ['missing-toolname', 'required-field-unnamed']);
  assert.equal((await run('webmcp.schema-validity', { '/': page('<form><input name="x"></form>') })).status, 'neutral');
});

test('lintDeclarative flags duplicate and badly formed tool names', () => {
  const doc = parseDocument('<form toolname="a b" tooldescription="x"></form><form toolname="dup" tooldescription="x"></form><form toolname="dup" tooldescription="y"></form>');
  const rules = lintDeclarative(doc).errors.map((e) => e.rule);
  assert.ok(rules.includes('toolname-pattern'));
  assert.ok(rules.includes('duplicate-toolname'));
});

test('webmcp.tool-schemas: valid passes, required outside properties fails, undescribed warns, no tools neutral', async () => {
  const r = { '/': page('<p>x</p>') };
  assert.equal((await run('webmcp.tool-schemas', r, bd([tool()]))).status, 'pass');
  assert.equal((await run('webmcp.tool-schemas', r, bd([tool({ inputSchema: { type: 'object', properties: {}, required: ['x'] } })]))).status, 'fail');
  assert.equal((await run('webmcp.tool-schemas', r, bd([tool({ inputSchema: { type: 'object', properties: { x: { type: 'string' } } } })]))).status, 'warn');
  assert.equal((await run('webmcp.tool-schemas', r, bd([tool({ source: 'declarative' })]))).status, 'neutral');
  assert.equal(lintSchema({ inputSchema: { type: 'array' } }).errors.length, 1);
});

test('webmcp.tool-count: Lighthouse warns above 40', async () => {
  const r = { '/': page('<p>x</p>') };
  assert.equal((await run('webmcp.tool-count', r, bd([tool()]))).status, 'pass');
  const many = Array.from({ length: 41 }, (_, i) => tool({ name: `get_${i}` }));
  assert.equal((await run('webmcp.tool-count', r, bd(many))).status, 'warn');
  assert.equal((await run('webmcp.tool-count', r, bd([]))).status, 'neutral');
});

test('webmcp.descriptions: verb-first, length and duplicates', async () => {
  const r = { '/': page('<p>x</p>') };
  assert.equal((await run('webmcp.descriptions', r, bd([tool()]))).status, 'pass');
  const dup = [tool({ name: 'a_x' }), tool({ name: 'b_x' })];
  assert.equal((await run('webmcp.descriptions', r, bd(dup))).status, 'warn');
  const noVerb = await run('webmcp.descriptions', r, bd([tool({ description: 'This tool is for cabins and their details.' })]));
  assert.equal(noVerb.status, 'warn');
  assert.equal((await run('webmcp.descriptions', r, bd([tool({ description: 'Get' }), tool({ name: 'b', description: '' })]))).status, 'fail');
  // static fallback: declarative forms in the server HTML
  const s = await run('webmcp.descriptions', { '/': page('<form toolname="search_x" tooldescription="Searches the catalogue for products by keyword."><input name="q"></form>') });
  assert.equal(s.status, 'pass');
});

test('webmcp.annotations: write tool marked read-only fails, read tool without hint warns', async () => {
  const r = { '/': page('<p>x</p>') };
  assert.equal((await run('webmcp.annotations', r, bd([tool(), tool({ name: 'book_cabin', annotations: { readOnlyHint: false } })]))).status, 'pass');
  assert.equal((await run('webmcp.annotations', r, bd([tool({ name: 'cancel_booking', annotations: { readOnlyHint: true } })]))).status, 'fail');
  assert.equal((await run('webmcp.annotations', r, bd([tool({ name: 'search_cabins', annotations: { readOnlyHint: false } })]))).status, 'warn');
  assert.equal((await run('webmcp.annotations', r, bd([]))).status, 'neutral');
});

test('webmcp.origin-trial: decodes the token and checks feature, origin and expiry', async () => {
  const future = Math.floor(Date.now() / 1000) + 86400 * 30;
  const good = token({ origin: 'https://example.com:443', feature: 'WebMCP', expiry: future });
  assert.equal(decodeOriginTrial(good).feature, 'WebMCP');
  const form = '<form toolname="a_b" tooldescription="Do a thing"><input name="q"></form>';
  assert.equal((await run('webmcp.origin-trial', { '/': page(form, `<meta http-equiv="origin-trial" content="${good}">`) })).status, 'pass');
  const expired = token({ origin: 'https://example.com:443', feature: 'WebMCP', expiry: 1_000_000 });
  assert.equal((await run('webmcp.origin-trial', { '/': html(`<html><body>${form}</body></html>`, { 'origin-trial': expired }) })).status, 'warn');
  const other = token({ origin: 'https://other.example:443', feature: 'WebMCP', expiry: future });
  assert.equal((await run('webmcp.origin-trial', { '/': page(form, `<meta http-equiv="Origin-Trial" content="${other}">`) })).status, 'warn');
  assert.equal((await run('webmcp.origin-trial', { '/': page(form) })).status, 'info');
  assert.equal((await run('webmcp.origin-trial', { '/': page('<p>x</p>') })).status, 'neutral');
});
