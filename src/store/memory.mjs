// In-memory report store (tests, CLI, single-process servers). Same interface as fs/d1.
import { RETENTION_MS, newId, hostOf, normHost } from './common.mjs';

export function memoryStore({ retentionMs = RETENTION_MS, max = 500, now = () => Date.now() } = {}) {
  const items = new Map(); // id -> { report, at, host, url }
  const prune = () => {
    const t = now();
    for (const [id, v] of items) if (t - v.at > retentionMs) items.delete(id);
    while (items.size > max) items.delete(items.keys().next().value);
  };
  return {
    kind: 'memory',
    async put(report) {
      prune();
      const id = report.id || newId();
      items.set(id, { report: { ...report, id }, at: now(), host: hostOf(report), url: report.url });
      return id;
    },
    async get(id) {
      prune();
      return items.get(id)?.report || null;
    },
    async latestForHost(host) {
      prune();
      const h = normHost(host);
      let best = null;
      for (const v of items.values()) if (v.host === h && (!best || v.at >= best.at)) best = v;
      return best?.report || null;
    },
    async latestForUrl(url, maxAgeMs = retentionMs) {
      prune();
      let best = null;
      for (const v of items.values()) if (v.url === url && now() - v.at <= maxAgeMs && (!best || v.at >= best.at)) best = v;
      return best?.report || null;
    },
  };
}
