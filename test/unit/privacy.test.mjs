import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockSite, html, json } from '../helpers/mock-site.mjs';

const page = (head, body = '') => html(`<!doctype html><html><head>${head}</head><body>${body}</body></html>`);

test('privacy.policy-link: rel links pass, plain anchors warn, nothing fails', async () => {
  assert.equal((await mockSite({ '/': page('<link rel="privacy-policy" href="/privacy"><link rel="terms-of-service" href="/terms">') }).run('privacy.policy-link')).status, 'pass');
  assert.equal((await mockSite({ '/': page('', '<a href="/privacy">Privacy policy</a>') }).run('privacy.policy-link')).status, 'warn');
  assert.equal((await mockSite({ '/': page('', '<p>x</p>') }).run('privacy.policy-link')).status, 'fail');
});

test('privacy.gpc: gpc true passes, absent is informational', async () => {
  assert.equal((await mockSite({ '/.well-known/gpc.json': json({ gpc: true, lastUpdate: '2026-11-01' }) }).run('privacy.gpc')).status, 'pass');
  assert.equal((await mockSite({}).run('privacy.gpc')).status, 'info');
  assert.equal((await mockSite({ '/.well-known/gpc.json': json({ gpc: false }) }).run('privacy.gpc')).status, 'info');
});

test('privacy.human-confirmation: declarative forms without autosubmit pass; autosubmit booking warns; no write tools neutral', async () => {
  assert.equal((await mockSite({ '/': page('', '<form toolname="book_cabin" tooldescription="Book a cabin" method="post"></form>') }).run('privacy.human-confirmation')).status, 'pass');
  assert.equal((await mockSite({ '/': page('', '<form toolname="book_cabin" tooldescription="Book a cabin" method="post" toolautosubmit></form>') }).run('privacy.human-confirmation')).status, 'warn');
  assert.equal((await mockSite({ '/': page('', '<form toolname="search_cabins" tooldescription="Search"></form>') }).run('privacy.human-confirmation')).status, 'neutral');
  const b = { ok: true, webmcp: { tools: [{ name: 'book_cabin', description: 'Books a cabin. The guest must confirm in the page.', annotations: {}, source: 'imperative' }] } };
  assert.equal((await mockSite({ '/': page('', '<p>x</p>') }, { browserData: b }).run('privacy.human-confirmation')).status, 'pass');
});
