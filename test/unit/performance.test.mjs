import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockSite, html, status } from '../helpers/mock-site.mjs';

const PAGE = '<!doctype html><html><head><title>t</title></head><body><p>hello</p></body></html>';

test('ttfb thresholds (web.dev)', async () => {
  assert.equal((await mockSite({ '/': { ...html(PAGE), ttfb: 120 } }).run('performance.ttfb')).status, 'pass');
  assert.equal((await mockSite({ '/': { ...html(PAGE), ttfb: 1200 } }).run('performance.ttfb')).status, 'warn');
  assert.equal((await mockSite({ '/': { ...html(PAGE), ttfb: 2500 } }).run('performance.ttfb')).status, 'fail');
});

test('compression', async () => {
  const big = PAGE.replace('hello', 'x'.repeat(5000));
  assert.equal((await mockSite({ '/': html(big, { 'content-encoding': 'br' }) }).run('performance.compression')).status, 'pass');
  assert.equal((await mockSite({ '/': html(big) }).run('performance.compression')).status, 'fail');
  assert.equal((await mockSite({ '/': html(PAGE) }).run('performance.compression')).status, 'info');
});

test('redirects', async () => {
  assert.equal((await mockSite({ '/': html(PAGE) }).run('performance.redirects')).status, 'pass');
  const chain = { '/': status(301, { location: '/a' }), '/a': status(302, { location: '/b' }), '/b': status(301, { location: '/c' }), '/c': html(PAGE) };
  const r = await mockSite(chain).run('performance.redirects');
  assert.equal(r.status, 'warn'); assert.equal(r.details.hops, 3);
  const loop = { '/': status(301, { location: '/' }) };
  assert.equal((await mockSite(loop).run('performance.redirects')).status, 'fail');
});

test('page-weight: informational under 2 MB, warns above', async () => {
  assert.equal((await mockSite({ '/': html(PAGE) }).run('performance.page-weight')).status, 'info');
  const huge = PAGE.replace('hello', 'x'.repeat(2_200_000));
  assert.equal((await mockSite({ '/': html(huge) }).run('performance.page-weight')).status, 'warn');
});
