import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockSite, text, html } from '../helpers/mock-site.mjs';
import { parseRobots, isAllowed } from '../../src/core/parse/robots.mjs';

test('crawl.robots-txt passes on a plain-text robots.txt with a group', async () => {
  const r = await mockSite({ '/': html('<h1>x</h1>'), '/robots.txt': text('User-agent: *\nAllow: /\n') }).run('crawl.robots-txt');
  assert.equal(r.status, 'pass');
  assert.equal(r.compat.status, 'pass');
});

test('crawl.robots-txt fails on an HTML soft-404', async () => {
  const r = await mockSite({ '/robots.txt': html('<html>not found</html>') }).run('crawl.robots-txt');
  assert.equal(r.status, 'fail');
});

test('RFC 9309 matching: specific group wins, longest rule wins, allow wins ties', () => {
  const p = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: GPTBot\nUser-agent: ClaudeBot\nAllow: /\nDisallow: /private\nAllow: /private/ok$\n');
  assert.equal(isAllowed(p, 'gptbot', '/').allowed, true);
  assert.equal(isAllowed(p, 'ClaudeBot', '/private/x').allowed, false);
  assert.equal(isAllowed(p, 'ClaudeBot', '/private/ok').allowed, true);
  assert.equal(isAllowed(p, 'CCBot', '/').allowed, false);
  assert.equal(isAllowed(p, 'CCBot', '/').group, '*');
});
