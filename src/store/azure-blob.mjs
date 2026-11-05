// Azure Blob Storage report store (the Azure Static Web Apps / Functions deployment). Same interface as memory/fs/d1.
// Runtime-neutral: fetch + WebCrypto, no SDK, so the function bundle stays small.
//
// Layout in one container (default "reports"):
//   r/<id>.json            the report (serialize(): bodies trimmed past ~1.8 MB)
//   host/<host>.json       { id, at } pointer to the newest report for a host (badges)
//   url/<sha256(url)>.json { id, at } pointer to the newest report for an exact URL (10-minute cache)
// Retention: get() hides reports older than RETENTION_MS, and the storage account's lifecycle rule (infra/main.bicep)
// deletes blobs 30 days after their last write, so nothing needs a cleanup job.
//
// Auth: Shared Key (the account key from the connection string, kept in an app setting, never in the repo).
// https://learn.microsoft.com/en-us/rest/api/storageservices/authorize-with-shared-key
import { RETENTION_MS, newId, hostOf, normHost, serialize, ID_RE } from './common.mjs';

const API_VERSION = '2025-01-05';
const enc = new TextEncoder();

/** Parse an Azure Storage connection string ("UseDevelopmentStorage=true" means Azurite on 127.0.0.1:10000). */
export function parseConnectionString(cs) {
  const s = String(cs || '').trim();
  if (/^UseDevelopmentStorage=true;?$/i.test(s)) {
    return { account: 'devstoreaccount1', key: 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==', blobEndpoint: 'http://127.0.0.1:10000/devstoreaccount1' };
  }
  const kv = Object.fromEntries(s.split(';').filter(Boolean).map((p) => { const i = p.indexOf('='); return [p.slice(0, i).trim(), p.slice(i + 1).trim()]; }));
  const account = kv.AccountName;
  const key = kv.AccountKey;
  if (!account || !key) throw new Error('The storage connection string needs AccountName and AccountKey.');
  const blobEndpoint = (kv.BlobEndpoint || `${kv.DefaultEndpointsProtocol || 'https'}://${account}.blob.${kv.EndpointSuffix || 'core.windows.net'}`).replace(/\/+$/, '');
  return { account, key, blobEndpoint };
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}

async function sha256Hex(text) {
  const d = await globalThis.crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The Shared Key string-to-sign for the Blob service (version 2009-09-19 and later). Exported for tests. */
export function stringToSign({ method, url, headers, account }) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const len = h['content-length'];
  const canonHeaders = Object.keys(h).filter((k) => k.startsWith('x-ms-')).sort().map((k) => `${k}:${h[k].trim()}\n`).join('');
  const u = new URL(url);
  const params = [...new Set([...u.searchParams.keys()].map((k) => k.toLowerCase()))].sort()
    .map((k) => `\n${k}:${u.searchParams.getAll(k).sort().join(',')}`).join('');
  const resource = `/${account}${u.pathname}${params}`;
  return [
    method.toUpperCase(),
    h['content-encoding'] || '',
    h['content-language'] || '',
    len && len !== '0' ? len : '',
    h['content-md5'] || '',
    h['content-type'] || '',
    '', // Date: x-ms-date is used instead
    h['if-modified-since'] || '',
    h['if-match'] || '',
    h['if-none-match'] || '',
    h['if-unmodified-since'] || '',
    h.range || '',
  ].join('\n') + '\n' + canonHeaders + resource;
}

/**
 * @param {object} o
 * @param {string} o.connectionString
 * @param {string} [o.container]
 * @param {Function} [o.fetch]  injectable for tests
 */
export function azureBlobStore({ connectionString, container = 'reports', retentionMs = RETENTION_MS, fetch: f = globalThis.fetch, now = () => Date.now() }) {
  const cfg = parseConnectionString(connectionString);
  let keyPromise = null;
  const signingKey = () => (keyPromise ||= globalThis.crypto.subtle.importKey('raw', b64ToBytes(cfg.key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']));
  let containerReady = false;

  async function call(method, path, { body = null, headers = {}, query = '' } = {}) {
    const url = `${cfg.blobEndpoint}/${container}${path}${query}`;
    const bytes = body == null ? null : enc.encode(body);
    const h = { 'x-ms-date': new Date(now()).toUTCString(), 'x-ms-version': API_VERSION, ...headers };
    if (bytes) h['content-length'] = String(bytes.byteLength);
    const sig = await globalThis.crypto.subtle.sign('HMAC', await signingKey(), enc.encode(stringToSign({ method, url, headers: h, account: cfg.account })));
    h.authorization = `SharedKey ${cfg.account}:${bytesToB64(sig)}`;
    const send = { ...h }; delete send['content-length']; // fetch sets it from the body
    return f(url, { method, headers: send, body: bytes });
  }

  async function ensureContainer() {
    if (containerReady) return;
    const r = await call('PUT', '', { query: '?restype=container' });
    if (r.status !== 201 && r.status !== 409) throw new Error(`Could not create the blob container (HTTP ${r.status}).`);
    containerReady = true;
  }

  async function putJson(path, value) {
    const opts = { body: typeof value === 'string' ? value : JSON.stringify(value), headers: { 'x-ms-blob-type': 'BlockBlob', 'content-type': 'application/json' } };
    let r = await call('PUT', path, opts);
    if (r.status === 404) { await ensureContainer(); r = await call('PUT', path, opts); }
    if (r.status !== 201) throw new Error(`Blob write failed (HTTP ${r.status}).`);
  }

  async function getJson(path) {
    const r = await call('GET', path);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Blob read failed (HTTP ${r.status}).`);
    return r.json();
  }

  async function viaPointer(path, maxAgeMs) {
    const p = await getJson(path).catch(() => null);
    if (!p?.id || now() - Number(p.at || 0) > maxAgeMs) return null;
    return api.get(p.id);
  }

  const api = {
    kind: 'azure-blob',
    async put(report) {
      const id = report.id || newId();
      const at = now();
      const host = hostOf(report);
      await putJson(`/r/${id}.json`, serialize({ ...report, id, stored_at: at }));
      const pointer = { id, at };
      await Promise.all([
        host ? putJson(`/host/${encodeURIComponent(host)}.json`, pointer) : null,
        report.url ? sha256Hex(report.url).then((k) => putJson(`/url/${k}.json`, pointer)) : null,
      ]);
      return id;
    },
    async get(id) {
      if (!ID_RE.test(String(id || ''))) return null;
      const rep = await getJson(`/r/${id}.json`);
      if (!rep) return null;
      if (rep.stored_at && now() - rep.stored_at > retentionMs) return null;
      return rep;
    },
    async latestForHost(host) {
      const h = normHost(host);
      if (!h) return null;
      return viaPointer(`/host/${encodeURIComponent(h)}.json`, retentionMs);
    },
    async latestForUrl(url, maxAgeMs = retentionMs) {
      if (!url) return null;
      return viaPointer(`/url/${await sha256Hex(url)}.json`, maxAgeMs);
    },
  };
  return api;
}
