import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockSite, html, json, status } from '../helpers/mock-site.mjs';
import { readX402 } from '../../src/checks/commerce.mjs';

// UCP profile adapted from agent-ready-web-demos (MIT), nordlys-cabins/layers/12-commerce/ucp.js.
const O = 'https://example.com';
const ucp = { ucp: { version: '2026-08-25', services: { 'dev.ucp.lodging': [{ version: '2026-10-31', transport: 'rest', endpoint: `${O}/ucp/v1` }] }, capabilities: { 'dev.ucp.lodging.booking': [{ version: '2026-10-31' }] }, payment_handlers: {} } };
const product = (price, currency = 'NOK', availability = 'https://schema.org/InStock') => `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name: 'Fjellro', offers: { '@type': 'Offer', price, priceCurrency: currency, availability } })}</script>`;
const shop = (body) => html(`<!doctype html><html><head><title>Fjellro</title></head><body><h1>Fjellro</h1>${body}<a href="/cart">Cart</a></body></html>`);

test('commerce.detected reports signals as info', async () => {
  const r = await mockSite({ '/': shop(product('1290')) }).run('commerce.detected');
  assert.equal(r.status, 'info'); assert.equal(r.details.isCommerce, true);
  assert.equal((await mockSite({ '/': html('<p>blog</p>') }).run('commerce.detected')).details.isCommerce, false);
  // a docs site that links /payments/checkout and mentions WooCommerce is not a shop
  assert.equal((await mockSite({ '/': html('<p>Works with WooCommerce</p><a href="/payments/checkout">Checkout docs</a>') }).run('commerce.detected')).details.isCommerce, false);
});

test('commerce.product-data: complete visible offers pass; hidden price warns; none fails', async () => {
  assert.equal((await mockSite({ '/': shop(`${product('1290')}<p>NOK 1 290 per night</p>`) }).run('commerce.product-data')).status, 'pass');
  assert.equal((await mockSite({ '/': shop(`${product('1290')}<p>NOK 990 per night</p>`) }).run('commerce.product-data')).status, 'warn');
  assert.equal((await mockSite({ '/': shop(`${product('1290', 'NOK', 'yes')}<p>1290</p>`) }).run('commerce.product-data')).status, 'warn');
  assert.equal((await mockSite({ '/': shop('<p>no data</p>') }).run('commerce.product-data')).status, 'fail');
});

test('commerce.ucp and ucp-valid accept the nested UCP profile', async () => {
  const site = mockSite({ '/': shop(product('1')), '/.well-known/ucp': json(ucp) });
  const r = await site.run('commerce.ucp');
  assert.equal(r.status, 'pass'); assert.equal(r.compat.status, 'pass');
  assert.equal((await site.run('commerce.ucp-valid')).status, 'pass');
  const flat = await mockSite({ '/.well-known/ucp': json({ protocol_version: '2026-08-25', services: [{ name: 'x', transport: 'rest', endpoint: 'http://example.com/u' }] }) });
  assert.equal((await flat.run('commerce.ucp')).compat.status, 'pass');
  assert.equal((await flat.run('commerce.ucp-valid')).status, 'warn');
  assert.equal((await mockSite({}).run('commerce.ucp')).status, 'fail');
});

test('commerce.acp follows the iia field list', async () => {
  const doc = { protocol: { name: 'acp', version: '2026-09-30' }, api_base_url: `${O}/acp`, transports: ['rest'], capabilities: { services: ['checkout'] } };
  assert.equal((await mockSite({ '/.well-known/acp.json': json(doc) }).run('commerce.acp')).status, 'pass');
  const r = await mockSite({ '/.well-known/acp.json': json({ protocol: { name: 'acp' } }) }).run('commerce.acp');
  assert.equal(r.status, 'fail'); assert.ok(r.details.missing.includes('api_base_url'));
});

test('commerce.x402 reads V2 header and V1 body; plain 402 fails', async () => {
  const req = btoa(JSON.stringify({ x402Version: 2, accepts: [{ scheme: 'exact', amount: '10000' }] }));
  assert.equal(readX402({ status: 402, headers: { 'payment-required': req }, text: '' }).version, 2);
  assert.equal(readX402({ status: 402, headers: {}, text: JSON.stringify({ x402Version: 1, accepts: [{}] }) }).version, 1);
  const openapi = { openapi: '3.1.0', info: { title: 'a', version: '1' }, servers: [{ url: `${O}/api` }], paths: { '/report': { get: { responses: { 402: { description: 'Pay' } } } } } };
  const paid = mockSite({ '/openapi.json': json(openapi), '/api/report': status(402, { 'payment-required': req }) });
  assert.equal((await paid.run('commerce.x402')).status, 'pass');
  assert.ok(!paid.calls.some((c) => c.headers['payment-signature']));
  assert.equal((await mockSite({ '/openapi.json': json(openapi), '/api/report': status(402) }).run('commerce.x402')).status, 'fail');
  assert.equal((await mockSite({ '/': html('x') }).run('commerce.x402')).compat.status, 'fail');
});

test('commerce.mpp counts x-payment-info operations', async () => {
  const openapi = { openapi: '3.1.0', info: { title: 'a', version: '1' }, paths: { '/r': { post: { 'x-payment-info': { price: '0.05' }, responses: { 200: { description: 'ok' } } } } } };
  assert.equal((await mockSite({ '/openapi.json': json(openapi) }).run('commerce.mpp')).status, 'pass');
  assert.equal((await mockSite({}).run('commerce.mpp')).status, 'fail');
});

test('commerce.ap2 needs an AP2 extension with a role', async () => {
  const card = (ext) => json({ name: 'a', version: '1', supportedInterfaces: [], capabilities: { extensions: ext } });
  assert.equal((await mockSite({ '/.well-known/agent-card.json': card([{ uri: 'https://github.com/google-agentic-commerce/ap2/tree/v0.1', params: { roles: ['merchant'] } }]) }).run('commerce.ap2')).status, 'pass');
  assert.equal((await mockSite({ '/.well-known/agent-card.json': card([{ uri: 'https://github.com/google-agentic-commerce/ap2' }]) }).run('commerce.ap2')).status, 'fail');
});

test('commerce.vrp is informational', async () => {
  assert.equal((await mockSite({ '/': shop(product('1')) }).run('commerce.vrp')).status, 'info');
  assert.equal((await mockSite({ '/': shop(product('1')), '/.well-known/vacation-rental.json': json({ offers: [] }) }).run('commerce.vrp')).status, 'pass');
});
