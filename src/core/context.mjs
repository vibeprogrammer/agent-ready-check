// ScanContext: the shared, lazily computed view of one site. Checks ask it for artifacts;
// each artifact is fetched/parsed once per scan (memoised promises).
/** @typedef {import('./fetcher.mjs').SafeFetcher} SafeFetcher */
import { parseDocument, visibleText } from './html.mjs';
import { parseRobots, isAllowed } from './parse/robots.mjs';
import { parseLinkHeader } from './parse/link-header.mjs';

export const HTML_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
export const JSON_ACCEPT = 'application/json, */*;q=0.5';
export const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
export const ROBOTS_TOKEN = 'AgentReadyCheck';

export class ScanContext {
  /**
   * @param {object} o
   * @param {URL} o.url            the page the person asked about
   * @param {SafeFetcher} o.fetcher
   * @param {object|null} [o.browser]  browserData from src/browser/collect.mjs, or null when no browser ran
   * @param {object} [o.options]
   */
  constructor({ url, fetcher, browser = null, options = {} }) {
    this.url = url;
    this.origin = url.origin;
    this.host = url.hostname;
    this.fetcher = fetcher;
    this._browser = browser; // object, promise of one, or null
    this.options = options;
    this._memo = new Map();
    this.notes = [];
  }

  /** browserData from the browser collector, or null when no browser ran (always await it). */
  async browserData() { try { return (await this._browser) || null; } catch { return null; } }

  /** Memoise any async artifact by key: ctx.memo('openapi', () => locateOpenApi(ctx)) */
  memo(key, fn) {
    if (!this._memo.has(key)) this._memo.set(key, Promise.resolve().then(fn));
    return this._memo.get(key);
  }

  abs(pathOrUrl) { return new URL(pathOrUrl, this.origin).href; }

  /** Fetch through the guard (never throws). opts: method, headers, accept, body, maxBytes, timeoutMs, follow, memo, purpose */
  fetch(pathOrUrl, opts = {}) { return this.fetcher.fetch(this.abs(pathOrUrl), opts); }

  /** GET a JSON resource; returns { ex, json, error } where json is null unless 2xx and it parses (HTML soft-404s give error). */
  async json(pathOrUrl, opts = {}) {
    const ex = await this.fetch(pathOrUrl, { accept: JSON_ACCEPT, ...opts });
    if (!ex.ok) return { ex, json: null, error: ex.error || `HTTP ${ex.status}` };
    if (/html/.test(ex.contentType) || /^\s*</.test(ex.text)) return { ex, json: null, error: `served ${ex.contentType || 'HTML'}, not JSON` };
    try { return { ex, json: JSON.parse(ex.text), error: null }; } catch (e) { return { ex, json: null, error: `invalid JSON: ${e.message}` }; }
  }

  /** The page itself, fetched like a browser would ask for it (HTML Accept, our UA). */
  home() { return this.memo('home', () => this.fetch(this.url.href, { accept: HTML_ACCEPT, maxBytes: 3_145_728, purpose: 'page' })); }

  /** The origin root (same as home() when the person entered the origin). */
  root() { return this.url.pathname === '/' && !this.url.search ? this.home() : this.memo('root', () => this.fetch('/', { accept: HTML_ACCEPT, maxBytes: 3_145_728, purpose: 'root' })); }

  async isHtml() { const h = await this.home(); return h.ok && (/html/.test(h.contentType) || /^\s*<(!doctype|html)/i.test(h.text)); }

  /** linkedom Document of the server HTML (empty document when the page is not HTML). */
  dom() { return this.memo('dom', async () => { const h = await this.home(); return parseDocument(await this.isHtml() ? h.text : ''); }); }

  /** Visible text of the server HTML. */
  text() { return this.memo('text', async () => visibleText(await this.dom())); }

  /** All links: Link header + <link> elements + <a rel>. [{rel, href, type, title, source}] */
  links() {
    return this.memo('links', async () => {
      const h = await this.home();
      const base = h.finalUrl || this.url.href;
      const out = parseLinkHeader(h.headers.link, base);
      const doc = await this.dom();
      for (const el of doc.querySelectorAll('link[rel][href]')) {
        let href = el.getAttribute('href'); try { href = new URL(href, base).href; } catch { /* keep */ }
        for (const rel of el.getAttribute('rel').toLowerCase().split(/\s+/).filter(Boolean)) out.push({ rel, href, type: el.getAttribute('type'), title: el.getAttribute('title'), source: 'html' });
      }
      return out;
    });
  }

  /** robots.txt: { ex, ok, text, parsed, allowed(token, path) } — parsed is null if missing/not text. */
  robots() {
    return this.memo('robots', async () => {
      const ex = await this.fetch('/robots.txt', { accept: 'text/plain, */*;q=0.5', maxBytes: 600_000, purpose: 'robots' });
      const isText = ex.ok && !/html/.test(ex.contentType) && !/^\s*<(!doctype|html)/i.test(ex.text);
      const parsed = isText ? parseRobots(ex.text) : null;
      return {
        ex, ok: isText, text: isText ? ex.text : '', parsed,
        allowed: (token, path = '/') => (parsed ? isAllowed(parsed, token, path) : { allowed: true, group: null, rule: null }),
      };
    });
  }

  /** May our crawl part fetch this URL? (robots.txt for our token; same-origin only) */
  async mayCrawl(url) {
    try {
      const u = new URL(url, this.origin);
      if (u.origin !== this.origin) return true;
      const r = await this.robots();
      return r.allowed(ROBOTS_TOKEN, u.pathname + u.search).allowed;
    } catch { return false; }
  }

  /** JSON-LD blocks of the server HTML: [{ index, raw, data, error, nodes }] (nodes = every object with @type, flattened). */
  jsonld() {
    return this.memo('jsonld', async () => {
      const doc = await this.dom();
      return [...doc.querySelectorAll('script[type="application/ld+json"]')].map((s, index) => {
        const raw = s.textContent || '';
        try { const data = JSON.parse(raw); return { index, raw, data, error: null, nodes: flattenNodes(data) }; } catch (e) { return { index, raw, data: null, error: e.message, nodes: [] }; }
      });
    });
  }

  /** Does a random path answer 200? { soft404: bool, page: Exchange, wellKnown: Exchange } */
  soft404() {
    return this.memo('soft404', async () => {
      const r = Math.random().toString(36).slice(2, 10);
      const [page, wellKnown] = await Promise.all([
        this.fetch(`/agent-ready-check-${r}`, { accept: HTML_ACCEPT, purpose: 'soft-404 probe' }),
        this.fetch(`/.well-known/agent-ready-check-${r}.json`, { accept: JSON_ACCEPT, purpose: 'soft-404 probe' }),
      ]);
      return { soft404: page.status === 200 || wellKnown.status === 200, page, wellKnown };
    });
  }

  /** Capability predicates used for "applies" (set by src/core/discover.mjs). */
  async applies(kind) {
    const d = await import('./discover.mjs');
    switch (kind) {
      case 'always': case 'optin': return true;
      case 'commerce': return (await d.commerceSignals(this)).isCommerce;
      case 'api': return (await d.apiSignals(this)).hasApi;
      case 'mcp': return (await d.mcpSignals(this)).hasMcp;
      case 'auth': return (await d.authSignals(this)).hasAuth;
      case 'forms': return (await this.dom()).querySelectorAll('form').length > 0;
      default: return true;
    }
  }
}

/** Every object with @type in a JSON-LD value (handles @graph, arrays, nesting). */
export function flattenNodes(data, out = [], depth = 0) {
  if (depth > 12 || data == null) return out;
  if (Array.isArray(data)) { for (const d of data) flattenNodes(d, out, depth + 1); return out; }
  if (typeof data === 'object') {
    if (data['@type']) out.push(data);
    for (const [k, v] of Object.entries(data)) if (k !== '@context' && typeof v === 'object') flattenNodes(v, out, depth + 1);
  }
  return out;
}

export const typesOf = (node) => [].concat(node?.['@type'] || []).map((t) => String(t).replace(/^https?:\/\/schema\.org\//, ''));
