// Shared helpers for report stores. Runtime-neutral (no node: imports).
// Store interface (memory, fs, d1):
//   put(report) -> Promise<string id>      stores a report for RETENTION_MS and returns its id
//   get(id) -> Promise<report|null>        null when unknown or expired
//   latestForHost(host) -> Promise<report|null>   newest stored report for that host (badges)
//   latestForUrl(url, maxAgeMs) -> Promise<report|null>  newest report for that exact URL, if younger than maxAgeMs
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const ALPHABET = 'abcdefghijkmnopqrstuvwxyz23456789';

/** A short, URL-safe, unguessable id (12 chars, about 60 bits). */
export function newId(len = 12) {
  const bytes = new Uint8Array(len);
  globalThis.crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s;
}

export const ID_RE = /^[a-z0-9]{6,32}$/;

export function hostOf(report) {
  try { return new URL(report.final_url || report.url).host.toLowerCase(); } catch { return ''; }
}

/** Normalise a host from user input ("Example.com", "example.com:443"). */
export function normHost(host) {
  return String(host || '').trim().toLowerCase().replace(/\.$/, '').replace(/:443$/, '');
}

/**
 * Keep a report under a byte budget (D1 rows are capped at about 2 MB): drop exchange bodies first,
 * then exchange headers. Returns a JSON string.
 */
export function serialize(report, maxBytes = 1_800_000) {
  let s = JSON.stringify(report);
  if (s.length <= maxBytes) return s;
  const slim = { ...report, exchanges: {} };
  for (const [k, ex] of Object.entries(report.exchanges || {})) {
    slim.exchanges[k] = { ...ex, response: ex.response ? { ...ex.response, body: ex.response.body ? String(ex.response.body).slice(0, 300) : ex.response.body } : ex.response };
  }
  s = JSON.stringify(slim);
  if (s.length <= maxBytes) return s;
  for (const ex of Object.values(slim.exchanges)) { if (ex.response) { ex.response.body = null; ex.response.headers = {}; } if (ex.request) ex.request.headers = {}; }
  slim.truncated_for_storage = true;
  return JSON.stringify(slim);
}
