// File-system report store (Node, Docker, Azure Files mount). One JSON file per report plus a small index.
// Node-only (uses node:fs); the core never imports it.
import { mkdir, readFile, writeFile, readdir, stat, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { RETENTION_MS, newId, hostOf, normHost, ID_RE, serialize } from './common.mjs';

export function fsStore({ dir, retentionMs = RETENTION_MS, now = () => Date.now() } = {}) {
  if (!dir) throw new Error('fsStore needs a dir');
  let ready = null;
  const ensure = () => (ready ||= mkdir(dir, { recursive: true }));
  const file = (id) => join(dir, `${id}.json`);
  const indexFile = join(dir, 'index.json');
  let index = null; // [{ id, host, url, at }]
  let lastPrune = 0;

  async function loadIndex() {
    if (index) return index;
    await ensure();
    try { index = JSON.parse(await readFile(indexFile, 'utf8')); if (!Array.isArray(index)) index = []; } catch { index = []; }
    return index;
  }
  async function saveIndex() {
    const tmp = `${indexFile}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(index));
    await rename(tmp, indexFile);
  }
  async function prune() {
    const t = now();
    if (t - lastPrune < 60_000) return;
    lastPrune = t;
    await loadIndex();
    const keep = []; const drop = [];
    for (const e of index) (t - e.at > retentionMs ? drop : keep).push(e);
    if (!drop.length) return;
    index = keep;
    await saveIndex();
    await Promise.all(drop.map((e) => unlink(file(e.id)).catch(() => {})));
  }

  return {
    kind: 'fs',
    dir,
    async put(report) {
      await loadIndex();
      const id = report.id || newId();
      const at = now();
      await writeFile(file(id), serialize({ ...report, id }, 20_000_000));
      index.push({ id, host: hostOf(report), url: report.url, at });
      await saveIndex();
      prune().catch(() => {});
      return id;
    },
    async get(id) {
      if (!ID_RE.test(String(id))) return null;
      await loadIndex();
      const e = index.find((x) => x.id === id);
      if (e && now() - e.at > retentionMs) return null;
      try { return JSON.parse(await readFile(file(id), 'utf8')); } catch { return null; }
    },
    async latestForHost(host) {
      await loadIndex();
      const h = normHost(host);
      for (let i = index.length - 1; i >= 0; i--) if (index[i].host === h && now() - index[i].at <= retentionMs) return this.get(index[i].id);
      return null;
    },
    async latestForUrl(url, maxAgeMs = retentionMs) {
      await loadIndex();
      for (let i = index.length - 1; i >= 0; i--) if (index[i].url === url && now() - index[i].at <= maxAgeMs) return this.get(index[i].id);
      return null;
    },
    /** Rebuild the index from the files on disk (after a manual copy). */
    async reindex() {
      await ensure();
      index = [];
      for (const name of await readdir(dir)) {
        const m = /^([a-z0-9]+)\.json$/.exec(name);
        if (!m || name === 'index.json') continue;
        try {
          const r = JSON.parse(await readFile(join(dir, name), 'utf8'));
          index.push({ id: m[1], host: hostOf(r), url: r.url, at: Date.parse(r.scanned_at) || (await stat(join(dir, name))).mtimeMs });
        } catch { /* skip */ }
      }
      index.sort((a, b) => a.at - b.at);
      await saveIndex();
      return index.length;
    },
  };
}
