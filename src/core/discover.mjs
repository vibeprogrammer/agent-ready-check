// Capability discovery shared by several layers (memoised on the context).
// Decides which capability layers apply: commerce, api, mcp, auth.
import { typesOf } from './context.mjs';

const COMMERCE_TYPES = new Set(['Product', 'ProductGroup', 'Offer', 'AggregateOffer', 'OfferCatalog', 'IndividualProduct', 'ProductModel', 'Store', 'OnlineStore']);

/** { isCommerce, signals:[string] } */
export function commerceSignals(ctx) {
  return ctx.memo('discover:commerce', async () => {
    const signals = [];
    // An Offer only means "shop" when it is not the price tag of software, a service, an event or a course
    // (vercel.com's SoftwareApplication offer made it look like a shop; isitagentready does not count it).
    const NON_SHOP_PARENTS = new Set(['SoftwareApplication', 'WebApplication', 'MobileApplication', 'VideoGame', 'Service', 'Event', 'Course', 'CourseInstance', 'Book', 'Movie']);
    const OFFER_TYPES = new Set(['Offer', 'AggregateOffer', 'OfferCatalog']);
    const walk = (v, parentTypes = [], depth = 0) => {
      if (!v || typeof v !== 'object' || depth > 12) return;
      if (Array.isArray(v)) { for (const x of v) walk(x, parentTypes, depth + 1); return; }
      const types = typesOf(v);
      for (const t of types) {
        if (!COMMERCE_TYPES.has(t)) continue;
        if (OFFER_TYPES.has(t) && parentTypes.some((p) => NON_SHOP_PARENTS.has(p))) continue;
        signals.push(`JSON-LD ${t}`);
      }
      for (const [k, val] of Object.entries(v)) if (k !== '@context' && typeof val === 'object') walk(val, types.length ? types : parentTypes, depth + 1);
    };
    for (const b of await ctx.jsonld()) walk(b.data);
    const doc = await ctx.dom();
    const html = (await ctx.home()).text || '';
    // Top-level same-site cart links only: docs sites link deep pages such as /payments/checkout.
    const cartRe = new RegExp(`^(https?://${ctx.host.replace(/[.]/g, '\\.')})?/(cart|basket|bag|warenkorb|handlekurv|panier|carrito)(/|$|\\?|\\.)`, 'i');
    if ([...doc.querySelectorAll('a[href]')].some((a) => cartRe.test(a.getAttribute('href')))) signals.push('cart link');
    if (/cdn\.shopify\.com|Shopify\.shop|myshopify\.com/i.test(html)) signals.push('Shopify markers');
    if (/wp-content\/plugins\/woocommerce|class=["'][^"']*\bwoocommerce\b/i.test(html)) signals.push('WooCommerce markers');
    if (/<meta[^>]+property=["']og:type["'][^>]+content=["']product/i.test(html)) signals.push('og:type product');
    if (/"@type"\s*:\s*"Product"/.test(html) && !signals.length) signals.push('Product in page');
    return { isCommerce: signals.length > 0, signals: [...new Set(signals)] };
  });
}

/** { hasApi, catalog:{ex,json,error}, openapi:{url, ex, doc, format, error, via}|null, serviceDescs:[url] } */
export function apiSignals(ctx) {
  return ctx.memo('discover:api', async () => {
    const catalog = await ctx.json('/.well-known/api-catalog', { accept: 'application/linkset+json, application/json;q=0.9, */*;q=0.5', purpose: 'api-catalog' });
    const serviceDescs = [];
    const linkset = Array.isArray(catalog.json?.linkset) ? catalog.json.linkset : [];
    for (const entry of linkset) for (const sd of [].concat(entry['service-desc'] || [])) if (sd?.href) serviceDescs.push(new URL(sd.href, ctx.origin).href);
    for (const l of await ctx.links()) if (l.rel === 'service-desc') serviceDescs.push(l.href);
    const candidates = [...new Set([...serviceDescs, ctx.abs('/openapi.json'), ctx.abs('/openapi.yaml'), ctx.abs('/.well-known/openapi.json')])];
    let openapi = null;
    for (const url of candidates.slice(0, 6)) {
      const ex = await ctx.fetch(url, { accept: 'application/openapi+json, application/json, application/yaml, text/yaml;q=0.9, */*;q=0.5', maxBytes: 3_145_728, purpose: 'openapi' });
      if (!ex.ok || /html/.test(ex.contentType) || /^\s*</.test(ex.text)) continue;
      if (/mcp-server-card|linkset|agent-card/.test(ex.contentType)) continue;
      let doc = null; let format = 'json'; let error = null;
      try { doc = JSON.parse(ex.text); } catch {
        try { const YAML = await import('yaml'); doc = YAML.parse(ex.text); format = 'yaml'; } catch (e) { error = e.message; }
      }
      if (doc && (doc.openapi || doc.swagger)) { openapi = { url, ex, doc, format, error, via: serviceDescs.includes(url) ? 'service-desc' : 'well-known path' }; break; }
    }
    return { hasApi: linkset.length > 0 || !!openapi || serviceDescs.length > 0, catalog, openapi, serviceDescs: [...new Set(serviceDescs)] };
  });
}

export const MCP_CARD_PATHS = ['/.well-known/mcp/server-card.json', '/.well-known/mcp/server-cards.json', '/.well-known/mcp.json'];
export const MCP_PROTOCOL = '2026-07-28';

/** { hasMcp, card:{path, ex, json}|null, cards:[...], endpoint:string|null, endpointSource, init:{ex, ok, result, authRequired, challenge, error}|null } */
export function mcpSignals(ctx) {
  return ctx.memo('discover:mcp', async () => {
    const cards = await Promise.all(MCP_CARD_PATHS.map(async (path) => ({ path, ...(await ctx.json(path, { purpose: 'mcp server card' })) })));
    const found = cards.find((c) => c.json && typeof c.json === 'object');
    const card = found || null;
    let cardData = card?.json;
    if (Array.isArray(cardData)) cardData = cardData[0];
    if (cardData && Array.isArray(cardData.servers)) cardData = cardData.servers[0];
    let endpoint = null; let endpointSource = null;
    const fromCard = cardData && (cardData.transport?.url || cardData.transport?.endpoint || cardData.url || cardData.endpoint || cardData.remotes?.[0]?.url || cardData.remotes?.[0]?.href);
    if (fromCard) { try { endpoint = new URL(fromCard, ctx.origin).href; endpointSource = `server card ${card.path}`; } catch { /* ignore */ } }
    if (!endpoint) { endpoint = ctx.abs('/mcp'); endpointSource = 'conventional /mcp path'; }
    const init = await mcpInitialize(ctx, endpoint);
    const hasMcp = !!card || init.ok || init.authRequired;
    return { hasMcp, card, cardData, cards, endpoint, endpointSource, init };
  });
}

const MCP_LEGACY_PROTOCOL = '2025-11-25';
const CLIENT_INFO = { name: 'agent-ready-check', version: '0.1.0' };
/** The 2026-07-28 per-request envelope (book chapter 8: no handshake, _meta on every request). */
export const mcpMeta = (v = MCP_PROTOCOL) => ({ 'io.modelcontextprotocol/protocolVersion': v, 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': CLIENT_INFO });

/**
 * Ask an MCP endpoint what it is. Modern servers (2026-07-28, stateless) answer server/discover; 2025-era
 * servers answer the initialize handshake. Tries server/discover first, then initialize.
 * Returns { ex, ok, era:'modern'|'legacy'|null, result:{protocolVersion, serverInfo, capabilities, instructions,
 * supportedVersions}, sessionId, authRequired, challenge, error, attempts:[{method, status, error}] }
 */
export async function mcpInitialize(ctx, endpoint, extraHeaders = {}) {
  const base = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extraHeaders };
  const out = { ex: null, ok: false, era: null, result: null, sessionId: null, authRequired: false, challenge: null, error: null, attempts: [] };
  const errOf = (ex, msg) => (msg?.error ? `JSON-RPC error ${msg.error.code}: ${msg.error.message}` : (ex.error || `HTTP ${ex.status}`));
  // 1. server/discover (2026-07-28)
  const dBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: mcpMeta() } });
  const d = await ctx.fetch(endpoint, { method: 'POST', body: dBody, headers: { ...base, 'mcp-protocol-version': MCP_PROTOCOL, 'mcp-method': 'server/discover' }, follow: false, memo: false, purpose: 'mcp server/discover' });
  out.ex = d;
  if (d.status === 401) { out.authRequired = true; out.challenge = d.headers['www-authenticate'] || null; return out; }
  if (d.status === 403) { out.error = 'server/discover: HTTP 403'; out.attempts.push({ method: 'server/discover', status: 403, error: 'HTTP 403' }); return out; }
  const dm = parseJsonRpc(d.text, d.contentType);
  out.attempts.push({ method: 'server/discover', status: d.status, error: d.ok && dm?.result ? null : errOf(d, dm) });
  if (d.ok && dm?.result) {
    const r = dm.result; const meta = r._meta || {};
    const versions = Array.isArray(r.supportedVersions) ? r.supportedVersions : [];
    out.ok = true; out.era = 'modern';
    out.result = { protocolVersion: versions.includes(MCP_PROTOCOL) ? MCP_PROTOCOL : (versions[0] || MCP_PROTOCOL), supportedVersions: versions, serverInfo: meta['io.modelcontextprotocol/serverInfo'] || r.serverInfo || null, capabilities: r.capabilities || null, instructions: r.instructions || null };
    return out;
  }
  // 2. initialize (2025 revisions)
  const iBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_LEGACY_PROTOCOL, capabilities: {}, clientInfo: CLIENT_INFO } });
  const ex = await ctx.fetch(endpoint, { method: 'POST', body: iBody, headers: base, follow: false, memo: false, purpose: 'mcp initialize' });
  out.ex = ex; out.sessionId = ex.headers['mcp-session-id'] || null;
  if (ex.status === 401) { out.authRequired = true; out.challenge = ex.headers['www-authenticate'] || null; return out; }
  const msg = parseJsonRpc(ex.text, ex.contentType);
  out.attempts.push({ method: 'initialize', status: ex.status, error: ex.ok && msg?.result ? null : errOf(ex, msg) });
  if (ex.ok && msg?.result) { out.ok = true; out.era = 'legacy'; out.result = { ...msg.result, supportedVersions: msg.result.protocolVersion ? [msg.result.protocolVersion] : [] }; }
  else out.error = out.attempts.map((a) => `${a.method}: ${a.error}`).join('; ');
  return out;
}

/** Parse a JSON-RPC response from a JSON body or an SSE stream (first message with id). */
export function parseJsonRpc(text, contentType = '') {
  if (!text) return null;
  if (/event-stream/.test(contentType) || /^(event|data):/m.test(text)) {
    for (const block of text.split(/\n\n/)) {
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      if (!data) continue;
      try { const j = JSON.parse(data); if (j.id !== undefined) return j; } catch { /* next */ }
    }
    return null;
  }
  try { return JSON.parse(text); } catch { return null; }
}

/** { hasAuth, prm:{ex,json,error}, as:{ex,json,error,path}|null, oidc, oauth } */
export function authSignals(ctx) {
  return ctx.memo('discover:auth', async () => {
    const [prm, oauth, oidc] = await Promise.all([
      ctx.json('/.well-known/oauth-protected-resource', { purpose: 'oauth protected resource' }),
      ctx.json('/.well-known/oauth-authorization-server', { purpose: 'oauth AS metadata' }),
      ctx.json('/.well-known/openid-configuration', { purpose: 'openid configuration' }),
    ]);
    const as = oauth.json?.issuer ? { ...oauth, path: '/.well-known/oauth-authorization-server' } : oidc.json?.issuer ? { ...oidc, path: '/.well-known/openid-configuration' } : null;
    const mcp = await mcpSignals(ctx);
    return { hasAuth: !!(prm.json || as || mcp.init?.authRequired), prm, as, oauth, oidc, mcpChallenge: mcp.init?.challenge || null };
  });
}

/** Base URL of the site's API: OpenAPI servers[0], else the first catalog anchor, else <origin>/api/. { url, source } */
export function apiBase(ctx) {
  return ctx.memo('discover:apibase', async () => {
    const api = await apiSignals(ctx);
    const srv = api.openapi?.doc?.servers?.[0]?.url;
    if (typeof srv === 'string' && !srv.includes('{')) { try { return { url: new URL(srv, api.openapi.url).href.replace(/\/?$/, '/'), source: 'OpenAPI servers[0]' }; } catch { /* next */ } }
    const anchor = Array.isArray(api.catalog.json?.linkset) ? api.catalog.json.linkset.map((e) => e?.anchor).find((a) => typeof a === 'string' && !/\/mcp\/?$/.test(a)) : null;
    if (anchor) { try { return { url: new URL(anchor, ctx.origin).href.replace(/\/?$/, '/'), source: 'API catalog anchor' }; } catch { /* next */ } }
    return { url: ctx.abs('/api/'), source: 'conventional /api/ path' };
  });
}

/**
 * Send one JSON-RPC request to an MCP endpoint (after initialize). Never used for tools/call.
 * Stateless servers (2026-07-28) need nothing else; stateful ones get the session id and an initialized notification.
 * @returns {Promise<{ex, msg, result, error}>}
 */
export async function mcpRequest(ctx, endpoint, method, params = {}, { init = null } = {}) {
  if (method === 'tools/call') throw new Error('agent-ready-check never calls tools');
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  let body;
  if (init?.era === 'legacy') {
    headers['mcp-protocol-version'] = init.result?.protocolVersion || MCP_LEGACY_PROTOCOL;
    if (init.sessionId) headers['mcp-session-id'] = init.sessionId;
    await ctx.fetch(endpoint, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), headers, follow: false, memo: false, purpose: 'mcp initialized notification' });
    body = { jsonrpc: '2.0', id: 2, method, params };
  } else {
    const v = init?.result?.protocolVersion || MCP_PROTOCOL;
    headers['mcp-protocol-version'] = v; headers['mcp-method'] = method;
    body = { jsonrpc: '2.0', id: 2, method, params: { ...params, _meta: { ...mcpMeta(v), ...(params._meta || {}) } } };
  }
  const ex = await ctx.fetch(endpoint, { method: 'POST', body: JSON.stringify(body), headers, follow: false, memo: false, purpose: `mcp ${method}` });
  const msg = parseJsonRpc(ex.text, ex.contentType);
  return { ex, msg, result: msg?.result ?? null, error: msg?.error ? `JSON-RPC error ${msg.error.code}: ${msg.error.message}` : (msg ? null : (ex.error || `HTTP ${ex.status}`)) };
}

/** MCP tools/list on a public endpoint (memoised). { tools:[]|null, ex, error, skipped } */
export function mcpTools(ctx) {
  return ctx.memo('discover:mcptools', async () => {
    const mcp = await mcpSignals(ctx);
    if (!mcp.init?.ok) return { tools: null, ex: null, error: mcp.init?.authRequired ? 'endpoint requires authorization' : 'initialize did not succeed', skipped: true };
    if (mcp.init.result?.capabilities && !mcp.init.result.capabilities.tools) return { tools: [], ex: null, error: null, skipped: false, noToolsCapability: true };
    const r = await mcpRequest(ctx, mcp.endpoint, 'tools/list', {}, { init: mcp.init });
    const tools = Array.isArray(r.result?.tools) ? r.result.tools : null;
    return { tools, ex: r.ex, error: tools ? null : (r.error || 'no tools array in the answer'), skipped: false, nextCursor: r.result?.nextCursor || null };
  });
}

/** One real API response for header checks: the first GET operation without required parameters. { ex, op } | null */
export function apiSample(ctx) {
  return ctx.memo('discover:apisample', async () => {
    const api = await apiSignals(ctx);
    const doc = api.openapi?.doc;
    if (!doc?.paths) return null;
    const { operations } = await import('./parse/openapi.mjs');
    const base = (await apiBase(ctx)).url;
    const op = operations(doc).find((o) => o.method === 'get' && !o.path.includes('{') && !o.params.some((p) => p.required));
    if (!op) return null;
    let url; try { url = new URL(op.path.replace(/^\//, ''), base).href; } catch { return null; }
    if (new URL(url).origin !== ctx.origin && !new URL(url).hostname.endsWith(ctx.host.replace(/^www\./, ''))) return null;
    const ex = await ctx.fetch(url, { accept: 'application/json, application/problem+json;q=0.9, */*;q=0.5', purpose: 'api sample' });
    return { ex, op: `${op.method.toUpperCase()} ${op.path}` };
  });
}

/** WebMCP tools visible without running scripts, plus the browser's list when there is one. */
export function webmcpSignals(ctx) {
  return ctx.memo('discover:webmcp', async () => {
    const doc = await ctx.dom();
    const forms = [...doc.querySelectorAll('form[toolname]')].map((f) => ({ name: f.getAttribute('toolname'), description: f.getAttribute('tooldescription') || '', source: 'declarative', annotations: {}, autosubmit: f.hasAttribute('toolautosubmit'), method: (f.getAttribute('method') || 'get').toLowerCase() }));
    const inline = [...doc.querySelectorAll('script:not([src])')].map((s) => s.textContent || '').join('\n');
    const imperativeHint = /modelContext/.test(inline) && /registerTool\s*\(/.test(inline);
    const b = await ctx.browserData();
    const browserTools = b?.ok && Array.isArray(b.webmcp?.tools) ? b.webmcp.tools : null;
    const tools = browserTools ? browserTools : forms;
    return { forms, imperativeHint, browserTools, tools, hasWebmcp: forms.length > 0 || imperativeHint || (browserTools?.length || 0) > 0 };
  });
}
