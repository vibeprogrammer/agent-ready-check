// The Hono app shared by the Node server, Docker/Azure and the Cloudflare Worker. Runtime-neutral:
// no node: imports. Runtime specifics (scan function, store, rate limiter, static assets) are injected.
import { Hono } from 'hono';
import { normalizeUrl } from '../src/core/scan.mjs';
import { isBlockedIP, isIPLiteral } from '../src/core/net.mjs';
import { CHECKS, LAYERS, catalog } from '../src/checks/index.mjs';
import { createMcpHandler, checkInfo } from '../src/mcp/server.mjs';
import * as files from '../src/agent-files/index.mjs';
import { SITE, MCP_CARD_TYPE, LINKSET_TYPE, SKILL_NAME } from '../src/agent-files/site.mjs';
import { markdownToHtml, esc } from './markdown.mjs';
import { jsonLdData } from './layout.mjs';
import { rateLimitHeaders } from './ratelimit.mjs';
import * as defaultRenderers from './render.mjs';

export const DEFAULT_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";

const MD = 'text/markdown; charset=utf-8';
const HTML = 'text/html; charset=utf-8';
const PROBLEM = 'application/problem+json';
const STATUS_TITLES = { 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 413: 'Content Too Large', 415: 'Unsupported Media Type', 422: 'Unprocessable Content', 429: 'Too Many Requests', 500: 'Internal Server Error', 503: 'Service Unavailable' };

/** True when the Accept header prefers text/markdown to text/html. */
export function wantsMarkdown(accept) {
  if (!accept) return false;
  const q = {};
  for (const part of accept.split(',')) {
    const [type, ...params] = part.trim().toLowerCase().split(';');
    const qp = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    q[type.trim()] = qp ? Number(qp.slice(2)) || 0 : 1;
  }
  const md = q['text/markdown'] ?? q['text/x-markdown'] ?? 0;
  if (md <= 0) return false;
  const html = Math.max(q['text/html'] ?? 0, q['application/xhtml+xml'] ?? 0);
  return md >= html;
}

async function weakEtag(text) {
  const buf = await globalThis.crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return `W/"${[...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('')}"`;
}

class HttpError extends Error {
  constructor(status, detail, extra = {}) { super(detail); this.status = status; Object.assign(this, extra); }
}

/**
 * @param {object} o
 * @param {(url:string, opts:{browser:boolean})=>Promise<object>} o.scan   core scan for this runtime (returns a report)
 * @param {object} o.store         report store (src/store/*)
 * @param {object} o.rateLimit     limiter with hit(key) (server/ratelimit.mjs or d1RateLimiter)
 * @param {string} [o.baseUrl]     public origin; derived from the request when absent
 * @param {boolean} [o.browserAvailable]
 * @param {(host:string)=>Promise<string[]>} [o.resolve]  DNS lookup for the pre-scan address check (422)
 * @param {boolean} [o.allowPrivate]  tests/local only: allow private targets
 * @param {(path:string, request:Request)=>Promise<Response|null>} [o.assets]  static files (public/)
 * @param {string} [o.homeHtml]    the landing page HTML (Worker bundle inlines public/index.html)
 * @param {object} [o.renderers]   override src/report renderers (tests)
 * @param {number} [o.cacheMs]     result cache per URL (default 10 min)
 * @param {number} [o.maxBodyBytes]
 * @param {string[]} [o.allowedOrigins] extra browser origins for /mcp
 * @param {string} [o.csp]
 * @param {string} [o.runtime]
 */
export function createApp(o) {
  const {
    scan, store, rateLimit, browserAvailable = false, resolve = null, allowPrivate = false, assets = null,
    renderers = defaultRenderers, cacheMs = 600_000, maxBodyBytes = 16_384, allowedOrigins = [], csp = DEFAULT_CSP, runtime = 'node',
  } = o;
  const R = { ...defaultRenderers, ...renderers };
  const app = new Hono();
  const cache = new Map(); // key -> { report, at }
  const inflight = new Map(); // key -> promise
  let selfScans = 0;

  const baseOf = (c) => {
    if (o.baseUrl) return String(o.baseUrl).replace(/\/+$/, '');
    const u = new URL(c.req.url);
    const proto = (c.req.header('x-forwarded-proto') || '').split(',')[0].trim() || u.protocol.replace(':', '');
    const host = (c.req.header('x-forwarded-host') || '').split(',')[0].trim() || c.req.header('host') || u.host;
    return `${proto}://${host}`;
  };
  const clientKey = (c) => c.req.header('cf-connecting-ip') || (c.req.header('x-forwarded-for') || '').split(',')[0].trim() || c.env?.remoteAddress || c.env?.incoming?.socket?.remoteAddress || 'anonymous';

  const problem = (c, status, detail, extra = {}) => {
    const body = { type: extra.type || 'about:blank', title: extra.title || STATUS_TITLES[status] || 'Error', status, detail, instance: new URL(c.req.url).pathname, ...(extra.fields || {}) };
    return c.body(JSON.stringify(body, null, 2), status, { 'content-type': PROBLEM, ...(extra.headers || {}) });
  };

  /** Send text with a weak ETag and 304 handling. */
  const sendText = async (c, text, type, headers = {}) => {
    const etag = await weakEtag(text);
    const h = { 'content-type': type, etag, 'cache-control': headers['cache-control'] || 'public, max-age=300', ...headers };
    const inm = c.req.header('if-none-match');
    if (inm && inm.split(',').map((s) => s.trim()).includes(etag)) return c.body(null, 304, h);
    return c.body(c.req.method === 'HEAD' ? null : text, 200, h);
  };

  /** An HTML page that also answers Accept: text/markdown. */
  const htmlOrMd = async (c, { html, md, headers = {} }) => {
    c.header('Vary', 'Accept');
    if (wantsMarkdown(c.req.header('accept'))) return sendText(c, typeof md === 'function' ? await md() : md, MD, headers);
    return sendText(c, typeof html === 'function' ? await html() : html, HTML, headers);
  };

  const mdPage = (c, path, mdText, description) => {
    const base = baseOf(c);
    const { title, html } = markdownToHtml(mdText);
    const body = `<h1>${esc(title)}</h1>\n<p class="lead">${esc(description)}</p>\n<div class="prose">${html}</div>`;
    return htmlOrMd(c, { html: () => R.shell({ base, path, title, description, body, mdPath: `${path}.md`, jsonld: jsonLdData(base, { name: title, description, path }) }), md: mdText, headers: { link: `<${path}.md>; rel="alternate"; type="text/markdown"` } });
  };

  // ---- security headers and CORS on every response
  app.use('*', async (c, next) => {
    await next();
    const h = c.res.headers;
    const set = (k, v) => { if (!h.has(k)) h.set(k, v); };
    set('Content-Security-Policy', csp);
    set('X-Content-Type-Options', 'nosniff');
    set('X-Frame-Options', 'DENY');
    set('Referrer-Policy', 'strict-origin-when-cross-origin');
    set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
    const p = new URL(c.req.url).pathname;
    if (p !== '/mcp' && (p.startsWith('/api/') || p.startsWith('/.well-known/') || /\.(txt|json|xml|md|svg)$/.test(p) || p.startsWith('/badge') || p === '/mcp/server-card')) {
      set('Access-Control-Allow-Origin', '*');
      set('Access-Control-Expose-Headers', 'RateLimit, RateLimit-Policy, Retry-After, Link, ETag');
    }
  });
  app.options('/api/*', (c) => c.body(null, 204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, accept', 'Access-Control-Max-Age': '86400' }));

  // ---- scanning with cache, dedupe, rate limit, self-scan guard and storage
  async function preflight(url) {
    if (allowPrivate) return; // local testing: any port, any address
    if (!['80', '443', ''].includes(url.port)) throw new HttpError(422, `Port ${url.port} is not allowed; only 80 and 443 can be scanned.`);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) throw new HttpError(422, `${host} is a local name and cannot be scanned.`);
    if (isIPLiteral(host)) { if (isBlockedIP(host)) throw new HttpError(422, `${host} is a private or reserved address and cannot be scanned.`); return; }
    if (resolve) {
      let addrs = [];
      try { addrs = await resolve(host); } catch { throw new HttpError(422, `The host name ${host} does not resolve.`); }
      if (!addrs.length) throw new HttpError(422, `The host name ${host} does not resolve.`);
      if (addrs.some(isBlockedIP)) throw new HttpError(422, `${host} resolves to a private or reserved address and cannot be scanned.`);
    }
  }

  async function runScan(c, input, { browser = false } = {}) {
    let url;
    try { url = normalizeUrl(input); } catch (e) { throw new HttpError(400, e.message); }
    if (String(input).length > 2048) throw new HttpError(400, 'The URL is longer than 2048 characters.');
    const useBrowser = !!browser && browserAvailable;
    const key = `${url.href}${useBrowser ? '#browser' : ''}`;
    const base = baseOf(c);
    const withUrl = (r) => ({ ...r, report_url: r.id ? `${base}/r/${r.id}` : null });

    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < cacheMs) return { report: withUrl(hit.report), cached: true };
    if (store?.latestForUrl) {
      const prev = await store.latestForUrl(url.href, cacheMs).catch(() => null);
      if (prev && !!prev.mode?.browser === useBrowser) { cache.set(key, { report: prev, at: Date.parse(prev.scanned_at) || Date.now() }); return { report: withUrl(prev), cached: true }; }
    }
    if (inflight.has(key)) return { report: withUrl(await inflight.get(key)), cached: true };

    await preflight(url);
    const isSelf = url.host === new URL(base).host;
    if (isSelf && selfScans > 0) throw new HttpError(409, 'A scan of this service is already running; try again in a minute.');
    const rl = await rateLimit.hit(clientKey(c));
    c.set('rl', rl);
    if (!rl.allowed) throw new HttpError(429, `This client used its ${rl.limit} scans for the current ${rl.window}-second window. Retry after ${rl.reset} seconds.`, { retryAfter: rl.reset, rl });

    const job = (async () => {
      if (isSelf) selfScans++;
      try {
        const report = await scan(url.href, { browser: useBrowser });
        let id = null;
        try { id = await store.put(report); } catch (e) { report.storage_error = String(e?.message || e); }
        const stored = { ...report, id };
        cache.set(key, { report: stored, at: Date.now() });
        if (cache.size > 200) cache.delete(cache.keys().next().value);
        return stored;
      } finally { if (isSelf) selfScans--; }
    })();
    inflight.set(key, job);
    try { return { report: withUrl(await job), cached: false }; } finally { inflight.delete(key); }
  }

  const scanError = (c, e) => {
    if (e instanceof HttpError || e?.status) {
      const status = e.status || 500;
      const headers = {};
      if (status === 429) { Object.assign(headers, rateLimitHeaders(e.rl || { policy: rateLimit.policy || 'scans', limit: rateLimit.limit, remaining: 0, reset: e.retryAfter, window: rateLimit.windowSeconds })); headers['Retry-After'] = String(e.retryAfter ?? 60); }
      return problem(c, status, e.message, status === 429 ? { type: 'https://iana.org/assignments/http-problem-types#quota-exceeded', title: 'Request cannot be satisfied as assigned quota has been exceeded', headers, fields: { 'violated-policies': [rateLimit.policy || 'scans'] } } : { headers });
    }
    return problem(c, 500, `The scan failed: ${e?.message || e}`);
  };

  const rlHeaders = (c) => { const rl = c.get('rl'); return rl ? rateLimitHeaders(rl) : { 'RateLimit-Policy': `"${rateLimit.policy || 'scans'}";q=${rateLimit.limit};w=${rateLimit.windowSeconds}` }; };

  async function apiScanResponse(c, input, { browser, format }) {
    if (format && !['json', 'markdown', 'agent'].includes(format)) return problem(c, 400, 'format must be json, markdown or agent.');
    let out;
    try { out = await runScan(c, input, { browser }); } catch (e) { return scanError(c, e); }
    const headers = { ...rlHeaders(c), 'cache-control': 'no-store', 'x-cache': out.cached ? 'HIT' : 'MISS' };
    if (out.report.id) headers['content-location'] = `/api/reports/${out.report.id}`;
    if (format === 'markdown') return c.body(R.renderReportMarkdown(out.report, { baseUrl: baseOf(c), reportId: out.report.id }), 200, { ...headers, 'content-type': MD });
    if (format === 'agent') return c.body(R.renderFixPrompts(out.report, { baseUrl: baseOf(c), reportId: out.report.id }), 200, { ...headers, 'content-type': MD });
    return c.body(JSON.stringify(out.report), 200, { ...headers, 'content-type': 'application/json' });
  }

  // ---- API
  app.post('/api/scan', async (c) => {
    const len = Number(c.req.header('content-length') || 0);
    if (len > maxBodyBytes) return problem(c, 413, `The body is larger than ${maxBodyBytes} bytes.`);
    const type = c.req.header('content-type') || '';
    let body;
    try {
      const raw = await c.req.text();
      if (raw.length > maxBodyBytes) return problem(c, 413, `The body is larger than ${maxBodyBytes} bytes.`);
      if (type && !/json/i.test(type) && !/form-urlencoded/i.test(type)) return problem(c, 415, 'Send the body as application/json: {"url": "https://example.com"}.');
      body = /form-urlencoded/i.test(type) ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw || '{}');
    } catch { return problem(c, 400, 'The body is not valid JSON. Send {"url": "https://example.com"}.'); }
    if (!body || typeof body !== 'object' || typeof body.url !== 'string') return problem(c, 400, 'The body needs a "url" string, for example {"url": "https://example.com"}.');
    return apiScanResponse(c, body.url, { browser: body.browser === true || body.browser === 'true', format: body.format || 'json' });
  });
  app.get('/api/scan', (c) => {
    const url = c.req.query('url');
    if (!url) return problem(c, 400, 'The url query parameter is required, for example /api/scan?url=example.com.');
    return apiScanResponse(c, url, { browser: c.req.query('browser') === 'true', format: c.req.query('format') || 'json' });
  });
  app.get('/api/checks', (c) => {
    const layer = c.req.query('layer');
    if (layer && !LAYERS.some((l) => l.id === layer)) return problem(c, 400, `Unknown layer "${layer}". Layers: ${LAYERS.map((l) => l.id).join(', ')}.`);
    const checks = CHECKS.filter((x) => !layer || x.layer === layer).map((x) => checkInfo(x.id));
    return sendText(c, JSON.stringify({ version: SITE.version, checked: catalog.checked, count: checks.length, layers: LAYERS, checks }), 'application/json', rlHeaders(c));
  });
  app.get('/api/checks/:id', (c) => {
    const info = checkInfo(c.req.param('id'));
    if (!info) return problem(c, 404, `No check with id "${c.req.param('id')}". See /api/checks.`);
    return sendText(c, JSON.stringify(info), 'application/json', rlHeaders(c));
  });
  app.get('/api/reports/:id', async (c) => {
    const r = await store.get(c.req.param('id')).catch(() => null);
    if (!r) return problem(c, 404, 'No stored report with that id (reports are kept 30 days).', { headers: rlHeaders(c) });
    return c.body(JSON.stringify({ ...r, report_url: `${baseOf(c)}/r/${r.id}` }), 200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600', ...rlHeaders(c) });
  });
  app.get('/api/health', (c) => c.json({ status: 'ok', version: SITE.version, runtime, browser: browserAvailable, checks: CHECKS.length, store: store?.kind || null }, 200, { 'cache-control': 'no-store', ...rlHeaders(c) }));
  app.all('/api/*', (c) => problem(c, 404, `No API operation at ${new URL(c.req.url).pathname}. See /openapi.json.`, { headers: rlHeaders(c) }));

  // ---- MCP
  app.on(['POST', 'GET', 'DELETE'], '/mcp', async (c) => {
    const len = Number(c.req.header('content-length') || 0);
    if (len > 65_536) return problem(c, 413, 'The JSON-RPC message is larger than 64 KB.');
    // A tool call's scan needs this request's base URL and client key, so the handler is built per request (it is stateless).
    const local = { url: c.req.url, headers: c.req.raw.headers, env: c.env };
    const handler = createMcpHandler({
      allowedOrigins,
      getReport: (id) => store.get(id),
      scan: async (url, opts) => {
        const fake = { req: { url: local.url, header: (k) => local.headers.get(k) }, env: local.env, set: () => {}, get: () => undefined };
        try { return (await runScan(fake, url, opts)).report; } catch (e) { throw Object.assign(new Error(e.message), { status: e.status, retryAfter: e.retryAfter }); }
      },
    });
    const res = await handler(c.req.raw);
    return new Response(res.body, { status: res.status, headers: res.headers });
  });
  app.options('/mcp', (c) => c.body(null, 204, { allow: 'POST, OPTIONS' }));
  const card = (c) => JSON.stringify(files.serverCard(baseOf(c)), null, 2);
  app.get('/mcp/server-card', (c) => sendText(c, card(c), MCP_CARD_TYPE));

  // ---- agent files
  app.get('/robots.txt', (c) => sendText(c, files.robotsTxt(baseOf(c)), 'text/plain; charset=utf-8'));
  app.get('/llms.txt', (c) => sendText(c, files.llmsTxt(baseOf(c)), 'text/plain; charset=utf-8'));
  app.get('/llms-full.txt', (c) => sendText(c, files.llmsFullTxt(baseOf(c)), 'text/plain; charset=utf-8'));
  app.get('/sitemap.xml', (c) => sendText(c, files.sitemapXml(baseOf(c)), 'application/xml; charset=utf-8'));
  app.get('/openapi.json', (c) => sendText(c, JSON.stringify(files.openapi(baseOf(c)), null, 2), 'application/openapi+json'));
  app.get('/.well-known/openapi.json', (c) => c.redirect('/openapi.json', 301));
  app.get('/.well-known/api-catalog', (c) => sendText(c, JSON.stringify(files.apiCatalog(baseOf(c)), null, 2), LINKSET_TYPE));
  app.get('/.well-known/mcp/server-card.json', (c) => sendText(c, card(c), 'application/json'));
  app.get('/.well-known/mcp.json', (c) => sendText(c, card(c), 'application/json'));
  app.get('/.well-known/mcp/server-cards.json', (c) => sendText(c, JSON.stringify({ servers: [files.serverCard(baseOf(c))] }, null, 2), 'application/json'));
  app.get('/.well-known/agent-skills/index.json', async (c) => sendText(c, JSON.stringify(await files.agentSkillsIndex(baseOf(c)), null, 2), 'application/json'));
  app.get(`/.well-known/agent-skills/${SKILL_NAME}/SKILL.md`, (c) => sendText(c, files.skillMd(baseOf(c)), MD));
  app.get('/.well-known/ard.json', (c) => sendText(c, JSON.stringify(files.ardManifest(baseOf(c)), null, 2), 'application/json'));
  app.get('/.well-known/security.txt', (c) => sendText(c, files.securityTxt(baseOf(c)), 'text/plain; charset=utf-8', { 'cache-control': 'public, max-age=86400' }));
  app.get('/.well-known/gpc.json', (c) => sendText(c, JSON.stringify(files.gpcJson()), 'application/json'));
  for (const [path, a] of Object.entries(R.ASSETS || {})) {
    app.get(path, (c) => sendText(c, a.body, a.type, { 'cache-control': 'public, max-age=86400' }));
  }

  // ---- pages
  const homeLink = (base) => [
    '</.well-known/api-catalog>; rel="api-catalog"',
    `<${base}/openapi.json>; rel="service-desc"; type="application/openapi+json"`,
    '</docs>; rel="service-doc"; type="text/html"',
    '</llms.txt>; rel="describedby"; type="text/plain"',
    '</index.md>; rel="alternate"; type="text/markdown"',
    '</sitemap.xml>; rel="sitemap"; type="application/xml"',
    '</.well-known/ard.json>; rel="ard"; type="application/json"',
    '</mcp/server-card>; rel="mcp-server-card"; type="application/mcp-server-card+json"',
    '</privacy>; rel="privacy-policy"',
    '</terms>; rel="terms-of-service"',
  ].join(', ');
  const homeHtml = async (c) => {
    if (o.homeHtml) return o.homeHtml;
    if (assets) {
      const r = await assets('/index.html', c.req.raw).catch(() => null);
      if (r && r.ok) return r.text();
    }
    return R.renderHomeHtml({ baseUrl: baseOf(c), browserAvailable });
  };
  app.get('/', (c) => htmlOrMd(c, { html: () => homeHtml(c), md: () => files.homeMd(baseOf(c)), headers: { link: homeLink(baseOf(c)) } }));
  app.get('/index.html', (c) => c.redirect('/', 301));
  app.get('/index.md', (c) => sendText(c, files.homeMd(baseOf(c)), MD));
  const PAGE_GEN = { docs: files.docsMd, checks: files.checksMd, privacy: files.privacyMd, terms: files.termsMd };
  for (const p of files.PAGES.filter((x) => x.path !== '/')) {
    const name = p.path.slice(1);
    app.get(p.path, (c) => mdPage(c, p.path, PAGE_GEN[name](baseOf(c)), p.summary));
    app.get(`${p.path}.md`, (c) => sendText(c, PAGE_GEN[name](baseOf(c)), MD));
  }

  const errorPage = (c, status, detail) => {
    c.header('Vary', 'Accept');
    if (wantsMarkdown(c.req.header('accept'))) return c.body(`# ${STATUS_TITLES[status] || 'Error'}\n\n${detail}\n`, status, { 'content-type': MD });
    const title = STATUS_TITLES[status] || 'Error';
    const html = R.shell({ base: baseOf(c), path: new URL(c.req.url).pathname, title, description: detail, body: `<h1>${esc(title)}</h1>\n<p class="lead">${esc(detail)}</p>\n<p><a href="/">Scan another site</a></p>`, noindex: true });
    return c.body(html, status, { 'content-type': HTML, ...(status === 429 && c.get('rl') ? { 'Retry-After': String(c.get('rl').reset), ...rateLimitHeaders(c.get('rl')) } : {}) });
  };

  app.get('/scan', async (c) => {
    const input = c.req.query('url');
    if (!input) return c.redirect('/', 302);
    let out;
    try { out = await runScan(c, input, { browser: c.req.query('browser') === 'true' }); } catch (e) {
      if (e?.status === 429) c.set('rl', e.rl);
      return errorPage(c, e?.status || 500, e?.message || String(e));
    }
    const base = baseOf(c);
    const r = out.report;
    c.header('Vary', 'Accept');
    c.header('Cache-Control', 'no-store');
    if (r.id) c.header('Content-Location', `/r/${r.id}`);
    for (const [k, v] of Object.entries(rlHeaders(c))) c.header(k, v);
    if (wantsMarkdown(c.req.header('accept'))) return c.body(R.renderReportMarkdown(r, { baseUrl: base, reportId: r.id }), 200, { 'content-type': MD });
    return c.body(R.renderReportHtml(r, { baseUrl: base, reportId: r.id, filter: R.parseFilter ? R.parseFilter(new URL(c.req.url).searchParams) : undefined, browserAvailable }), 200, { 'content-type': HTML });
  });

  app.get('/r/:id', async (c) => {
    const id = c.req.param('id').replace(/\.(md|json)$/, '');
    const r = await store.get(id).catch(() => null);
    if (!r) return errorPage(c, 404, 'This report does not exist or has expired (reports are kept 30 days).');
    const base = baseOf(c);
    const report = { ...r, report_url: `${base}/r/${r.id}` };
    if (c.req.param('id').endsWith('.json')) return c.json(report);
    if (c.req.param('id').endsWith('.md')) return sendText(c, R.renderReportMarkdown(report, { baseUrl: base, reportId: r.id }), MD, { 'cache-control': 'public, max-age=3600' });
    return htmlOrMd(c, { html: () => R.renderReportHtml(report, { baseUrl: base, reportId: r.id, filter: R.parseFilter ? R.parseFilter(new URL(c.req.url).searchParams) : undefined, browserAvailable }), md: () => R.renderReportMarkdown(report, { baseUrl: base, reportId: r.id }), headers: { 'cache-control': 'public, max-age=3600', link: `</r/${r.id}.md>; rel="alternate"; type="text/markdown", </api/reports/${r.id}>; rel="alternate"; type="application/json"` } });
  });

  const badge = async (c, host) => {
    const r = host ? await store.latestForHost(host).catch(() => null) : null;
    const svg = R.renderBadge({ score: r ? r.score : null, level: r ? r.compat?.isitagentready?.level : null, label: 'agent-ready' });
    return c.body(svg, 200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=600' });
  };
  app.get('/badge/:file', (c) => {
    const f = c.req.param('file');
    if (!f.endsWith('.svg')) return problem(c, 404, 'Badges end in .svg, for example /badge/example.com.svg.');
    return badge(c, f.slice(0, -4).toLowerCase());
  });
  app.get('/badge', (c) => {
    const input = c.req.query('url');
    if (!input) return problem(c, 400, 'The url query parameter is required.');
    let u; try { u = normalizeUrl(input); } catch (e) { return problem(c, 400, e.message); }
    return badge(c, u.host.toLowerCase());
  });

  // ---- static assets (public/) and 404
  app.get('*', async (c, next) => {
    if (!assets) return next();
    const path = new URL(c.req.url).pathname;
    if (path.includes('..')) return next();
    const r = await assets(path, c.req.raw).catch(() => null);
    if (r && r.ok) return new Response(r.body, { status: r.status, headers: r.headers });
    return next();
  });
  app.notFound((c) => {
    const accept = c.req.header('accept') || '';
    if (/text\/html/.test(accept) || wantsMarkdown(accept)) return errorPage(c, 404, `Nothing at ${new URL(c.req.url).pathname}.`);
    return problem(c, 404, `Nothing at ${new URL(c.req.url).pathname}.`);
  });
  app.onError((e, c) => {
    console.error(e);
    return problem(c, 500, 'Something went wrong on our side.');
  });
  return app;
}

export { esc };
