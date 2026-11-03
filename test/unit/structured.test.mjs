import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockSite, html, json, status } from '../helpers/mock-site.mjs';
import { isA } from '../../src/checks/structured.mjs';
import vocab from '../../src/data/schemaorg.json' with { type: 'json' };

const ld = (obj) => `<script type="application/ld+json">${typeof obj === 'string' ? obj : JSON.stringify(obj)}</script>`;
const page = (head, body = '') => `<!doctype html><html lang="en"><head><title>T</title>${head}</head><body>${body}</body></html>`;
const run = (h, b, id, path = '/') => mockSite({ [path]: html(page(h, b)) }).run(id, path);

const CABIN = { '@context': 'https://schema.org', '@type': 'LodgingBusiness', name: 'Fjellro cabin', url: 'https://example.com/', address: 'Fjellveien 1, Hemsedal', description: 'Two-bedroom cabin with a wood-fired sauna near Hemsedal.', makesOffer: { '@type': 'Offer', price: '2400.00', priceCurrency: 'NOK' } };
const BODY = '<h1>Fjellro cabin</h1><p>Two-bedroom cabin with a wood-fired sauna near Hemsedal.</p><p>From NOK 2,400 a night.</p>';

test('vocabulary file is current and small', () => {
  assert.ok(vocab.release, 'release recorded');
  assert.ok(vocab.classes.LodgingBusiness && vocab.properties.priceCurrency);
  assert.ok(isA('LodgingBusiness', 'Organization'));
  assert.ok(!isA('Product', 'Organization'));
  assert.ok(JSON.stringify(vocab).length < 150_000);
});

test('jsonld-present', async () => {
  assert.equal((await run(ld(CABIN), BODY, 'structured.jsonld-present')).status, 'pass');
  assert.equal((await run('', '<div itemscope itemtype="https://schema.org/Product">x</div>', 'structured.jsonld-present')).status, 'warn');
  assert.equal((await run('', '<p>x</p>', 'structured.jsonld-present')).status, 'fail');
});

test('jsonld-syntax', async () => {
  assert.equal((await run(ld(CABIN), BODY, 'structured.jsonld-syntax')).status, 'pass');
  const r = await run(ld('{"@type": "Thing",}'), '', 'structured.jsonld-syntax');
  assert.equal(r.status, 'fail'); assert.equal(r.details.errors.length, 1);
  assert.equal((await run('', '', 'structured.jsonld-syntax')).status, 'neutral');
});

test('jsonld-context', async () => {
  assert.equal((await run(ld(CABIN), BODY, 'structured.jsonld-context')).status, 'pass');
  assert.equal((await run(ld({ '@type': 'Thing', name: 'x' }), '', 'structured.jsonld-context')).status, 'fail');
  assert.equal((await run(ld({ '@context': { '@vocab': 'https://schema.org/' }, '@graph': [{ '@type': 'Thing' }] }), '', 'structured.jsonld-context')).status, 'pass');
  assert.equal((await run(ld(CABIN) + ld({ '@type': 'Thing' }), BODY, 'structured.jsonld-context')).status, 'warn');
});

test('schema-types: unknown types fail, with a suggestion', async () => {
  assert.equal((await run(ld(CABIN), BODY, 'structured.schema-types')).status, 'pass');
  const r = await run(ld({ '@context': 'https://schema.org', '@type': 'lodgingbusiness' }), '', 'structured.schema-types');
  assert.equal(r.status, 'fail'); assert.equal(r.details.suggestions.lodgingbusiness, 'LodgingBusiness');
});

test('schema-properties: unknown properties warn', async () => {
  assert.equal((await run(ld(CABIN), BODY, 'structured.schema-properties')).status, 'pass');
  const r = await run(ld({ ...CABIN, pricePerNight: 2400 }), BODY, 'structured.schema-properties');
  assert.equal(r.status, 'warn'); assert.deepEqual(r.details.unknown, ['pricePerNight']);
});

test('key-properties', async () => {
  assert.equal((await run(ld(CABIN), BODY, 'structured.key-properties')).status, 'pass');
  const r = await run(ld({ '@context': 'https://schema.org', '@type': 'Offer', price: '10' }), '', 'structured.key-properties');
  assert.equal(r.status, 'fail'); assert.match(r.message, /priceCurrency/);
  assert.equal((await run(ld({ '@context': 'https://schema.org', '@type': 'Thing', name: 'x' }), '', 'structured.key-properties')).status, 'neutral');
});

test('visible-parity: matching values pass, a stale price and name fail', async () => {
  const ok = await run(ld(CABIN), BODY, 'structured.visible-parity');
  assert.equal(ok.status, 'pass', ok.message);
  const stale = { ...CABIN, name: 'Old cabin name', description: 'Something entirely unrelated to this page text', makesOffer: { '@type': 'Offer', price: '1999', priceCurrency: 'NOK' } };
  assert.equal((await run(ld(stale), BODY, 'structured.visible-parity')).status, 'fail');
});

test('identity: Organization subtype passes; none fails; inner page reads the homepage', async () => {
  assert.equal((await run(ld({ ...CABIN, logo: 'https://example.com/l.png' }), BODY, 'structured.identity')).status, 'pass');
  assert.equal((await run(ld({ '@context': 'https://schema.org', '@type': 'Product', name: 'x' }), '', 'structured.identity')).status, 'fail');
  const site = mockSite({ '/': html(page(ld({ '@context': 'https://schema.org', '@type': 'WebSite', name: 'N', url: 'https://example.com/' }))), '/cabins': html(page('', '<p>x</p>')) });
  assert.equal((await site.run('structured.identity', '/cabins')).status, 'pass');
});

test('canonical', async () => {
  assert.equal((await run('<link rel="canonical" href="https://example.com/">', '', 'structured.canonical')).status, 'pass');
  assert.equal((await run('', '', 'structured.canonical')).status, 'fail');
  assert.equal((await run('<link rel="canonical" href="/">', '', 'structured.canonical')).status, 'warn');
  assert.equal((await run('<link rel="canonical" href="https://other.org/">', '', 'structured.canonical')).status, 'warn');
  const s = mockSite({ '/': html(page('<link rel="canonical" href="https://example.com/gone">')), '/gone': status(404) });
  assert.equal((await s.run('structured.canonical')).status, 'fail');
});

test('meta-description', async () => {
  assert.equal((await run('<meta name="description" content="Cabins"><meta property="og:title" content="N"><meta property="og:description" content="C">', '', 'structured.meta-description')).status, 'pass');
  assert.equal((await run('<meta name="Description" content="Cabins">', '', 'structured.meta-description')).status, 'warn');
  assert.equal((await run('', '', 'structured.meta-description')).status, 'fail');
  assert.equal((await mockSite({ '/': json({}) }).run('structured.meta-description')).status, 'neutral');
});
