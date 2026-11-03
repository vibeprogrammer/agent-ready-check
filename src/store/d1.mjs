// Cloudflare D1 report store and rate limiter. Runtime-neutral: only uses the D1 binding API
// (prepare/bind/run/first/all/batch). Creates its tables on first use.
import { RETENTION_MS, newId, hostOf, normHost, ID_RE, serialize } from './common.mjs';

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, host TEXT NOT NULL, url TEXT NOT NULL, created INTEGER NOT NULL, body TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS reports_host ON reports (host, created)',
  'CREATE INDEX IF NOT EXISTS reports_url ON reports (url, created)',
  'CREATE TABLE IF NOT EXISTS rate (k TEXT PRIMARY KEY, start INTEGER NOT NULL, used INTEGER NOT NULL)',
];

function schema(db) {
  if (!db.__arcSchema) db.__arcSchema = db.batch(SCHEMA.map((s) => db.prepare(s))).catch((e) => { db.__arcSchema = null; throw e; });
  return db.__arcSchema;
}

export function d1Store(db, { retentionMs = RETENTION_MS, now = () => Date.now() } = {}) {
  if (!db) throw new Error('d1Store needs a D1 binding');
  let lastPrune = 0;
  const prune = async () => {
    const t = now();
    if (t - lastPrune < 3_600_000) return;
    lastPrune = t;
    await db.prepare('DELETE FROM reports WHERE created < ?').bind(t - retentionMs).run();
  };
  const parse = (row) => { try { return row ? JSON.parse(row.body) : null; } catch { return null; } };
  return {
    kind: 'd1',
    async put(report) {
      await schema(db);
      const id = report.id || newId();
      await db.prepare('INSERT INTO reports (id, host, url, created, body) VALUES (?, ?, ?, ?, ?)')
        .bind(id, hostOf(report), report.url, now(), serialize({ ...report, id })).run();
      prune().catch(() => {});
      return id;
    },
    async get(id) {
      if (!ID_RE.test(String(id))) return null;
      await schema(db);
      return parse(await db.prepare('SELECT body FROM reports WHERE id = ? AND created >= ?').bind(id, now() - retentionMs).first());
    },
    async latestForHost(host) {
      await schema(db);
      return parse(await db.prepare('SELECT body FROM reports WHERE host = ? AND created >= ? ORDER BY created DESC LIMIT 1').bind(normHost(host), now() - retentionMs).first());
    },
    async latestForUrl(url, maxAgeMs = retentionMs) {
      await schema(db);
      return parse(await db.prepare('SELECT body FROM reports WHERE url = ? AND created >= ? ORDER BY created DESC LIMIT 1').bind(url, now() - maxAgeMs).first());
    },
  };
}

/**
 * Fixed-window rate limiter on D1 (shared by every Worker isolate). Same interface as server/ratelimit.mjs:
 * hit(key) -> { allowed, limit, remaining, reset (seconds), window (seconds), policy }
 */
export function d1RateLimiter(db, { limit = 10, windowSeconds = 600, policy = 'scans', now = () => Date.now() } = {}) {
  return {
    limit, windowSeconds, policy,
    async hit(key) {
      await schema(db);
      const t = now();
      const k = `${policy}:${key}`;
      const row = await db.prepare('SELECT start, used FROM rate WHERE k = ?').bind(k).first();
      let start = row?.start ?? t; let used = row?.used ?? 0;
      if (t - start >= windowSeconds * 1000) { start = t; used = 0; }
      const reset = Math.max(0, Math.ceil((start + windowSeconds * 1000 - t) / 1000));
      if (used >= limit) return { allowed: false, limit, remaining: 0, reset, window: windowSeconds, policy };
      used += 1;
      await db.prepare('INSERT INTO rate (k, start, used) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET start = excluded.start, used = excluded.used').bind(k, start, used).run();
      return { allowed: true, limit, remaining: limit - used, reset, window: windowSeconds, policy };
    },
  };
}
