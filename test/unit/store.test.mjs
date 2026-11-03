// H4: report stores (memory, fs in a temp dir, d1 against a tiny fake binding) and rate limiters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryStore } from '../../src/store/memory.mjs';
import { fsStore } from '../../src/store/fs.mjs';
import { d1Store, d1RateLimiter } from '../../src/store/d1.mjs';
import { serialize, newId } from '../../src/store/common.mjs';
import { memoryRateLimiter, rateLimitHeaders } from '../../server/ratelimit.mjs';
import { fakeReport } from './server-fake-report.mjs';

async function exercise(store, clock) {
  const a = await store.put(fakeReport('https://a.example/'));
  clock.t += 1000;
  const b = await store.put(fakeReport('https://a.example/page'));
  clock.t += 1000;
  const c = await store.put(fakeReport('https://b.example/'));
  assert.match(a, /^[a-z0-9]{12}$/);
  assert.equal((await store.get(a)).id, a);
  assert.equal(await store.get('unknownid123'), null);
  assert.equal(await store.get('../etc/passwd'), null);
  assert.equal((await store.latestForHost('A.example')).id, b);
  assert.equal((await store.latestForHost('b.example')).id, c);
  assert.equal(await store.latestForHost('c.example'), null);
  assert.equal((await store.latestForUrl('https://a.example/', 10_000)).id, a);
  clock.t += 20_000;
  assert.equal(await store.latestForUrl('https://a.example/', 10_000), null, 'older than maxAge');
  clock.t += 31 * 24 * 3600 * 1000;
  assert.equal(await store.get(a), null, 'expired after 30 days');
}

test('memory store', async () => {
  const clock = { t: 1_000_000 };
  await exercise(memoryStore({ now: () => clock.t }), clock);
});

test('fs store (temp dir), survives a new instance, reindex', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arc-store-'));
  try {
    const clock = { t: Date.now() };
    const s1 = fsStore({ dir, now: () => clock.t });
    const id = await s1.put(fakeReport('https://x.example/'));
    const s2 = fsStore({ dir, now: () => clock.t });
    assert.equal((await s2.get(id)).url, 'https://x.example/');
    assert.equal(await s2.reindex(), 1);
    assert.ok((await readdir(dir)).includes(`${id}.json`));
    await exercise(fsStore({ dir: join(dir, 'sub'), now: () => clock.t }), clock);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// A minimal in-memory stand-in for the D1 binding: enough SQL for d1.mjs.
function fakeD1() {
  const reports = []; const rate = new Map();
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    async run() {
      if (sql.startsWith('INSERT INTO reports')) reports.push({ id: args[0], host: args[1], url: args[2], created: args[3], body: args[4] });
      else if (sql.startsWith('DELETE FROM reports')) { for (let i = reports.length - 1; i >= 0; i--) if (reports[i].created < args[0]) reports.splice(i, 1); }
      else if (sql.startsWith('INSERT INTO rate')) rate.set(args[0], { start: args[1], used: args[2] });
      return { success: true };
    },
    async first() {
      if (sql.startsWith('SELECT start, used FROM rate')) return rate.get(args[0]) || null;
      let rows = reports;
      if (sql.includes('WHERE id = ?')) rows = rows.filter((r) => r.id === args[0] && r.created >= args[1]);
      else if (sql.includes('WHERE host = ?')) rows = rows.filter((r) => r.host === args[0] && r.created >= args[1]);
      else if (sql.includes('WHERE url = ?')) rows = rows.filter((r) => r.url === args[0] && r.created >= args[1]);
      rows = [...rows].sort((x, y) => y.created - x.created);
      return rows[0] || null;
    },
  });
  return { prepare: (sql) => stmt(sql), batch: async (list) => Promise.all(list.map((s) => s.run())), reports };
}

test('d1 store against a fake binding', async () => {
  const clock = { t: 5_000_000 };
  await exercise(d1Store(fakeD1(), { now: () => clock.t }), clock);
});

test('d1 and memory rate limiters', async () => {
  const clock = { t: 0 };
  for (const rl of [d1RateLimiter(fakeD1(), { limit: 2, windowSeconds: 10, now: () => clock.t }), memoryRateLimiter({ limit: 2, windowSeconds: 10, now: () => clock.t })]) {
    clock.t = 0;
    assert.equal((await rl.hit('ip')).remaining, 1);
    assert.equal((await rl.hit('ip')).remaining, 0);
    const third = await rl.hit('ip');
    assert.equal(third.allowed, false);
    assert.equal(third.reset, 10);
    assert.equal((await rl.hit('other')).allowed, true);
    clock.t = 10_001;
    assert.equal((await rl.hit('ip')).allowed, true, 'new window');
  }
  assert.deepEqual(rateLimitHeaders({ policy: 'scans', limit: 10, remaining: 3, reset: 42, window: 600 }), { 'RateLimit-Policy': '"scans";q=10;w=600', RateLimit: '"scans";r=3;t=42' });
});

test('serialize trims oversized reports for D1 rows', () => {
  const big = fakeReport('https://big.example/');
  big.exchanges = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [i, { id: i, request: { headers: { a: 'b' } }, response: { headers: { x: 'y' }, body: 'x'.repeat(5000) } }]));
  const s = serialize(big, 30_000);
  assert.ok(s.length <= 30_000 || JSON.parse(s).truncated_for_storage);
  assert.equal(JSON.parse(s).score, 42);
  assert.notEqual(newId(), newId());
});
