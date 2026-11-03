// H4: CLI argument parsing, gates and table output (no network: main() is not run against a site).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, gates, table, main, USAGE } from '../../bin/agent-ready-check.mjs';
import { fakeReport } from './server-fake-report.mjs';

test('parseArgs: defaults and every option', () => {
  assert.deepEqual(parseArgs(['example.com']), { url: 'example.com', format: 'table', browser: false, allowPrivate: false, failUnder: null, levelAtLeast: null, only: null, help: false, version: false });
  const o = parseArgs(['--json', 'https://x.example', '--browser', '--allow-private', '--fail-under', '70', '--level-at-least=3', '--only', 'crawl.robots-txt, content.llms-txt']);
  assert.equal(o.format, 'json');
  assert.equal(o.url, 'https://x.example');
  assert.equal(o.browser, true);
  assert.equal(o.allowPrivate, true);
  assert.equal(o.failUnder, 70);
  assert.equal(o.levelAtLeast, 3);
  assert.deepEqual(o.only, ['crawl.robots-txt', 'content.llms-txt']);
  assert.equal(parseArgs(['x', '--md']).format, 'md');
  assert.equal(parseArgs(['x', '--prompts']).format, 'prompts');
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-v']).version, true);
});

test('parseArgs: errors', () => {
  assert.throws(() => parseArgs([]), /URL is required/);
  assert.throws(() => parseArgs(['a', 'b']), /only one URL/);
  assert.throws(() => parseArgs(['x', '--nope']), /unknown option/);
  assert.throws(() => parseArgs(['x', '--fail-under', '101']), /0 to 100/);
  assert.throws(() => parseArgs(['x', '--fail-under']), /number/);
  assert.throws(() => parseArgs(['x', '--level-at-least', '6']), /0 to 5/);
  assert.throws(() => parseArgs(['x', '--only']), /comma-separated/);
});

test('gates', () => {
  const r = fakeReport();
  assert.deepEqual(gates(r, { failUnder: 40, levelAtLeast: 1 }), []);
  assert.equal(gates(r, { failUnder: 50 }).length, 1);
  assert.equal(gates(r, { levelAtLeast: 2 }).length, 1);
  assert.equal(gates(r, { failUnder: 90, levelAtLeast: 4 }).length, 2);
});

test('table output lists score, level, layers and checks, failures first', () => {
  const t = table(fakeReport());
  assert.match(t, /Score 42\/100/);
  assert.match(t, /level 1 \(Basic Web Presence\)/);
  assert.match(t, /Crawler access/);
  assert.ok(t.indexOf('FAIL crawl.robots-txt') < t.indexOf('PASS crawl.sitemap'));
  assert.match(t, /Next isitagentready level \(2\)/);
});

test('main: usage errors exit 2, --help and --version exit 0', async () => {
  const out = []; const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s) };
  assert.equal(await main([], io), 2);
  assert.match(err.join(''), /URL is required/);
  assert.equal(await main(['--help'], io), 0);
  assert.ok(out.join('').includes(USAGE.split('\n')[0]));
  assert.equal(await main(['--version'], io), 0);
  assert.match(out.at(-1), /^\d+\.\d+\.\d+/);
});

test('main: a scan of a refused URL exits 2 with a message', async () => {
  const err = [];
  assert.equal(await main(['ftp://example.com'], { out: () => {}, err: (s) => err.push(s) }), 2);
  assert.match(err.join(''), /http and https/);
});
