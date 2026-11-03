// SafeFetcher: every network read of a scan goes through here.
// - SSRF guard on every hop (scheme, port, DNS -> blocked ranges), redirects followed by hand
// - per-request timeout and byte cap, per-scan request budget, concurrency limit and deadline
// - identifying User-Agent, memoisation of identical requests, an evidence log for the report
// Runtime-neutral: the transport (Node http/https or Worker fetch) and the resolver are injected.
import { isBlockedIP, isIPLiteral } from './net.mjs';

export const VERSION = '0.1.0';
export const DEFAULT_UA = `AgentReadyCheck/${VERSION} (+https://github.com/vibeprogrammer/agent-ready-check; agent-readiness checker)`;

export class FetchBlockedError extends Error {
  constructor(message, code = 'blocked') { super(message); this.code = code; }
}

class Semaphore {
  constructor(n) { this.n = n; this.q = []; }
  async acquire() {
    if (this.n > 0) { this.n--; return; }
    await new Promise((r) => this.q.push(r));
  }
  release() { const r = this.q.shift(); if (r) r(); else this.n++; }
}

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });

/**
 * @typedef {object} Exchange  one request/response pair, as the report shows it
 * @property {number} id
 * @property {string} method
 * @property {string} url            the URL asked for
 * @property {string} finalUrl       after redirects
 * @property {object} requestHeaders
 * @property {number} status         0 when no response
 * @property {boolean} ok            2xx
 * @property {Record<string,string>} headers  lowercased names; repeated headers joined with ", " (set-cookie dropped)
 * @property {string} contentType    media type only, lowercased ('' if none)
 * @property {string} text           decoded body (up to the cap)
 * @property {number} bytes
 * @property {boolean} truncated
 * @property {number} ms             total time
 * @property {number} ttfb           time to response headers (first hop)
 * @property {{status:number,url:string,location:string}[]} redirects
 * @property {string|null} error     network/guard error text
 * @property {string|null} errorCode 'blocked' | 'timeout' | 'budget' | 'deadline' | 'network' | 'too-large' | 'robots'
 */

export class SafeFetcher {
  /**
   * @param {object} o
   * @param {(req:{method:string,url:URL,headers:object,body?:string,timeoutMs:number,maxBytes:number,address?:string})=>Promise<{status:number,headers:object,body:Uint8Array,truncated:boolean,ttfb:number}>} o.transport
   * @param {(host:string)=>Promise<string[]>} o.resolve  DNS A/AAAA addresses
   * @param {boolean} [o.allowPrivate]  CLI/tests only: skip the address guard (localhost fixtures)
   * @param {number[]} [o.allowedPorts]
   */
  constructor(o) {
    this.transport = o.transport;
    this.resolve = o.resolve;
    this.allowPrivate = !!o.allowPrivate;
    this.allowedPorts = o.allowedPorts || [80, 443];
    this.userAgent = o.userAgent || DEFAULT_UA;
    this.timeoutMs = o.timeoutMs ?? 10_000;
    this.maxBytes = o.maxBytes ?? 1_048_576;
    this.maxRequests = o.maxRequests ?? 120;
    this.maxRedirects = o.maxRedirects ?? 5;
    this.deadline = Date.now() + (o.scanTimeoutMs ?? 60_000);
    this.sem = new Semaphore(o.concurrency ?? 8);
    this.count = 0;
    this.log = [];
    this.memo = new Map();
    this.dnsCache = new Map();
  }

  async checkUrl(url) {
    if (!['http:', 'https:'].includes(url.protocol)) throw new FetchBlockedError(`scheme ${url.protocol} is not allowed`);
    if (url.username || url.password) throw new FetchBlockedError('URLs with credentials are not allowed');
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    if (!this.allowPrivate && !this.allowedPorts.includes(port)) throw new FetchBlockedError(`port ${port} is not allowed`);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (this.allowPrivate) return undefined;
    if (/(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i.test(host)) throw new FetchBlockedError(`host ${host} is not public`);
    let addrs;
    if (isIPLiteral(host)) addrs = [host];
    else {
      if (!this.dnsCache.has(host)) this.dnsCache.set(host, this.resolve(host).catch((e) => { throw new FetchBlockedError(`DNS lookup failed for ${host}: ${e.message}`, 'network'); }));
      addrs = await this.dnsCache.get(host);
    }
    if (!addrs || !addrs.length) throw new FetchBlockedError(`no address for ${host}`, 'network');
    const bad = addrs.find(isBlockedIP);
    if (bad) throw new FetchBlockedError(`${host} resolves to a non-public address (${bad})`);
    return addrs[0];
  }

  /**
   * Fetch with the guard. Never throws: failures come back as an Exchange with error set.
   * @param {string|URL} input
   * @param {{method?:string, headers?:object, accept?:string, body?:string, maxBytes?:number, timeoutMs?:number, follow?:boolean, memo?:boolean, purpose?:string}} [opts]
   * @returns {Promise<Exchange>}
   */
  fetch(input, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    const headers = { 'user-agent': this.userAgent, accept: opts.accept || '*/*', 'accept-encoding': 'gzip, deflate, br', ...lower(opts.headers) };
    const key = JSON.stringify([method, String(input), headers, opts.body || '', opts.follow !== false]);
    if (opts.memo !== false && this.memo.has(key)) return this.memo.get(key);
    const p = this.#run(String(input), method, headers, opts);
    if (opts.memo !== false) this.memo.set(key, p);
    return p;
  }

  async #run(input, method, headers, opts) {
    const ex = { id: this.log.length + 1, method, url: input, finalUrl: input, requestHeaders: { ...headers }, status: 0, ok: false, headers: {}, contentType: '', text: '', bytes: 0, truncated: false, ms: 0, ttfb: 0, redirects: [], error: null, errorCode: null, purpose: opts.purpose || null };
    this.log.push(ex);
    const t0 = Date.now();
    let url;
    try { url = new URL(input); } catch { ex.error = `invalid URL: ${input}`; ex.errorCode = 'invalid'; return ex; }
    await this.sem.acquire();
    try {
      for (let hop = 0; ; hop++) {
        if (Date.now() > this.deadline) throw new FetchBlockedError('scan deadline reached', 'deadline');
        if (this.count >= this.maxRequests) throw new FetchBlockedError(`request budget of ${this.maxRequests} used up`, 'budget');
        const address = await this.checkUrl(url);
        this.count++;
        const remaining = Math.max(1000, Math.min(opts.timeoutMs ?? this.timeoutMs, this.deadline - Date.now()));
        const h0 = Date.now();
        const res = await withTimeout(this.transport({ method, url, headers, body: opts.body, timeoutMs: remaining, maxBytes: opts.maxBytes ?? this.maxBytes, address }), remaining + 500);
        if (hop === 0) ex.ttfb = res.ttfb ?? Date.now() - h0;
        const rh = lower(res.headers);
        const loc = rh.location;
        if (opts.follow !== false && [301, 302, 303, 307, 308].includes(res.status) && loc) {
          if (hop >= this.maxRedirects) throw new FetchBlockedError(`more than ${this.maxRedirects} redirects`, 'redirects');
          const next = new URL(loc, url);
          ex.redirects.push({ status: res.status, url: url.href, location: next.href });
          url = next;
          if (res.status === 303) method = 'GET';
          continue;
        }
        ex.finalUrl = url.href;
        ex.status = res.status;
        ex.ok = res.status >= 200 && res.status < 300;
        ex.headers = rh;
        ex.contentType = (rh['content-type'] || '').split(';')[0].trim().toLowerCase();
        ex.bytes = res.body?.byteLength || 0;
        ex.truncated = !!res.truncated;
        ex.text = res.body ? TEXT_DECODER.decode(res.body) : '';
        Object.defineProperty(ex, 'raw', { value: res.body || new Uint8Array(0), enumerable: false });
        break;
      }
    } catch (e) {
      ex.error = e?.message || String(e);
      ex.errorCode = e?.code && typeof e.code === 'string' ? (e.code.startsWith('E') ? 'network' : e.code) : 'network';
    } finally {
      this.sem.release();
      ex.ms = Date.now() - t0;
    }
    return ex;
  }

  /** Compact evidence for the report: request line, headers, status, a body excerpt. */
  static evidence(ex, excerpt = 2048) {
    if (!ex) return null;
    return {
      id: ex.id, request: { method: ex.method, url: ex.url, headers: pick(ex.requestHeaders, ['accept', 'user-agent', 'origin', 'content-type', 'if-none-match', 'if-modified-since']) },
      response: ex.status ? { status: ex.status, finalUrl: ex.finalUrl, headers: dropCookies(ex.headers), bytes: ex.bytes, truncated: ex.truncated, ms: ex.ms, body: ex.text.slice(0, excerpt) } : null,
      redirects: ex.redirects, error: ex.error,
    };
  }
}

function lower(h) {
  const o = {};
  if (!h) return o;
  const entries = typeof h.entries === 'function' && !(h instanceof Array) && !(Object.getPrototypeOf(h) === Object.prototype) ? [...h.entries()] : Object.entries(h);
  for (const [k, v] of entries) {
    const n = k.toLowerCase();
    if (n === 'set-cookie') continue;
    const val = Array.isArray(v) ? v.join(', ') : String(v);
    o[n] = o[n] ? `${o[n]}, ${val}` : val;
  }
  return o;
}
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const dropCookies = (h) => Object.fromEntries(Object.entries(h).filter(([k]) => k !== 'set-cookie' && k !== 'cookie'));

function withTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new FetchBlockedError(`timed out after ${ms} ms`, 'timeout')), ms); })]).finally(() => clearTimeout(t));
}
