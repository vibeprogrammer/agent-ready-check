import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockSite, html } from '../helpers/mock-site.mjs';
import { makeGuard, clsFromShifts, AGENT_RULES, browserUserAgent, findChromium } from '../../src/browser/collect.mjs';

const words = (n, prefix = 'word') => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');
const run = (id, browserData, body = `<p>${words(60)}</p>`) => mockSite({ '/': html(`<!doctype html><html lang="en"><body><main>${body}</main></body></html>`) }, { browserData }).run(id);
const bd = (o) => ({ ok: true, error: null, renderedText: words(60), axe: { version: '4.14.0', rules: AGENT_RULES, violations: [], incomplete: [], passes: ['button-name'] }, a11y: { interactive: [], unnamed: [], total: 0 }, clickables: [], consent: { overlays: [] }, cls: { value: 0, shifts: [], observedMs: 3000 }, ...o });

test('the 33 Lighthouse agent axe rules are listed', () => {
  assert.equal(AGENT_RULES.length, 33);
  assert.equal(new Set(AGENT_RULES).size, 33);
});

test('browser checks are skipped without a browser and error when the browser failed', async () => {
  const site = mockSite({ '/': html('<p>x</p>') });
  const report = await site.scan({ only: ['performance.cls', 'perception.axe-agent-rules'] });
  assert.deepEqual(report.checks.map((c) => c.status), ['skipped', 'skipped']);
  const failed = mockSite({ '/': html('<p>x</p>') }, { browserData: { ok: false, error: 'boom' } });
  assert.equal((await failed.run('performance.cls')).status, 'error');
});

test('perception.rendered-parity: same text passes, JS-only text fails, partial warns', async () => {
  assert.equal((await run('perception.rendered-parity', bd({}))).status, 'pass');
  assert.equal((await run('perception.rendered-parity', bd({ renderedText: words(60, 'js') }))).status, 'fail');
  assert.equal((await run('perception.rendered-parity', bd({ renderedText: `${words(30)} ${words(30, 'js')}` }))).status, 'warn');
  assert.equal((await run('perception.rendered-parity', bd({ renderedText: 'tiny page' }))).status, 'pass');
});

test('perception.axe-agent-rules: any violation fails (binary like Lighthouse)', async () => {
  assert.equal((await run('perception.axe-agent-rules', bd({}))).status, 'pass');
  const r = await run('perception.axe-agent-rules', bd({ axe: { version: '4.14.0', rules: AGENT_RULES, violations: [{ id: 'button-name', impact: 'critical', help: 'x', nodes: ['main > button'], count: 1 }], incomplete: [], passes: [] } }));
  assert.equal(r.status, 'fail');
  assert.match(r.message, /button-name/);
  assert.equal((await run('perception.axe-agent-rules', bd({ axe: { error: 'CSP' } }))).status, 'error');
});

test('perception.a11y-tree: all named pass, >=90 % warn, less fail', async () => {
  const named = (n) => Array.from({ length: n }, (_, i) => ({ role: 'link', name: `L${i}`, selector: `a${i}` }));
  const un = (n) => Array.from({ length: n }, (_, i) => ({ role: 'button', selector: `b${i}`, html: '<button></button>' }));
  assert.equal((await run('perception.a11y-tree', bd({ a11y: { interactive: named(10), unnamed: [], total: 10 } }))).status, 'pass');
  assert.equal((await run('perception.a11y-tree', bd({ a11y: { interactive: named(19), unnamed: un(1), total: 20 } }))).status, 'warn');
  assert.equal((await run('perception.a11y-tree', bd({ a11y: { interactive: named(5), unnamed: un(5), total: 10 } }))).status, 'fail');
});

test('perception.focusable-controls: click-only div fails; native and focusable custom controls pass', async () => {
  const div = { selector: 'div.card', tag: 'div', role: null, focusable: false, native: false, inNative: false, listener: true, pointer: true };
  assert.equal((await run('perception.focusable-controls', bd({ clickables: [div] }))).status, 'fail');
  assert.equal((await run('perception.focusable-controls', bd({ clickables: [{ ...div, focusable: true, role: 'button' }] }))).status, 'pass');
  assert.equal((await run('perception.focusable-controls', bd({ clickables: [{ ...div, tag: 'a', native: true }] }))).status, 'pass');
  assert.equal((await run('perception.focusable-controls', bd({ clickables: [{ ...div, listener: false }] }))).status, 'pass'); // cursor:pointer alone is not evidence
});

test('privacy.consent-overlay: small banner passes, large warns, wall or scroll lock fails', async () => {
  const ov = (coverage, blocksScroll = false) => bd({ consent: { overlays: [{ selector: 'div#cmp', coverage, text: 'We use cookies', blocksScroll }] } });
  assert.equal((await run('privacy.consent-overlay', bd({}))).status, 'pass');
  assert.equal((await run('privacy.consent-overlay', ov(0.15))).status, 'pass');
  assert.equal((await run('privacy.consent-overlay', ov(0.4))).status, 'warn');
  assert.equal((await run('privacy.consent-overlay', ov(0.4, true))).status, 'fail');
  assert.equal((await run('privacy.consent-overlay', ov(0.9))).status, 'fail');
});

test('performance.cls: web.dev thresholds 0.1 and 0.25', async () => {
  const c = (value) => bd({ cls: { value, shifts: [{ value, time: 100, sources: ['main'] }], observedMs: 3000 } });
  assert.equal((await run('performance.cls', c(0.05))).status, 'pass');
  assert.equal((await run('performance.cls', c(0.18))).status, 'warn');
  assert.equal((await run('performance.cls', c(0.4))).status, 'fail');
});

test('clsFromShifts: largest session window (1 s gap, 5 s cap)', () => {
  assert.equal(clsFromShifts([]), 0);
  assert.equal(clsFromShifts([{ value: 0.1, time: 0 }, { value: 0.1, time: 500 }, { value: 0.05, time: 3000 }]), 0.2);
  const steady = Array.from({ length: 12 }, (_, i) => ({ value: 0.05, time: i * 800 })); // one shift every 0.8 s for 9.6 s
  assert.ok(clsFromShifts(steady) <= 0.35); // capped by the 5 s window
});

test('makeGuard blocks private addresses, odd ports and schemes, unless allowPrivate', async () => {
  const resolve = async (h) => ({ 'public.example': ['93.184.216.34'], 'rebind.example': ['10.0.0.5'], 'mixed.example': ['93.184.216.34', '::1'] }[h] || []);
  const g = makeGuard({ resolve });
  assert.equal(await g('https://public.example/a'), null);
  assert.match(await g('https://rebind.example/'), /not a public address/);
  assert.match(await g('https://mixed.example/'), /::1/);
  assert.match(await g('http://127.0.0.1/'), /not a public address/);
  assert.match(await g('http://[::ffff:192.168.1.1]/'), /not a public address/);
  assert.match(await g('http://localhost/'), /localhost/);
  assert.match(await g('https://public.example:8443/'), /port/);
  assert.match(await g('file:///etc/passwd'), /scheme/);
  assert.equal(await g('data:text/html,hi'), null);
  assert.equal(await makeGuard({ allowPrivate: true, resolve })('http://127.0.0.1:3000/'), null);
});

test('browser user agent names the checker; findChromium never throws', () => {
  assert.match(browserUserAgent('156.0.8078.4'), /Chrome\/156\.0\.0\.0 .*AgentReadyCheck\//);
  const p = findChromium();
  assert.ok(p === undefined || typeof p === 'string');
});
