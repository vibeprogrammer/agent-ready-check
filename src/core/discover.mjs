// Capability discovery shared by several layers (memoised on the context).
// Decides which capability layers apply: commerce, api, mcp, auth.
import { typesOf } from './context.mjs';

const COMMERCE_TYPES = new Set(['Product', 'ProductGroup', 'Offer', 'AggregateOffer', 'OfferCatalog', 'IndividualProduct', 'ProductModel', 'Store', 'OnlineStore']);

/** { isCommerce, signals:[string] } */
export function commerceSignals(ctx) {
  return ctx.memo('discover:commerce', async () => {
    const signals = [];
    for (const b of await ctx.jsonld()) for (const n of b.nodes) for (const t of typesOf(n)) if (COMMERCE_TYPES.has(t)) signals.push(`JSON-LD ${t}`);
    const doc = await ctx.dom();
    const html = (await ctx.home()).text || '';
    if ([...doc.querySelectorAll('a[href]')].some((a) => /\/(cart|basket|checkout|bag)(\/|$|\?)/i.test(a.getAttribute('href')))) signals.push('cart/checkout link');
    if (/cdn\.shopify\.com|Shopify\.shop|myshopify\.com/i.test(html)) signals.push('Shopify markers');
    if (/woocommerce/i.test(html)) signals.push('WooCommerce markers');
    if (/<meta[^>]+property=["']og:type["'][^>]+content=["']product/i.test(html)) signals.push('og:type product');
    if (/"@type"\s*:\s*"(Product|Offer)"/.test(html) && !signals.length) signals.push('Product/Offer in page');
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
    const candidates = [...new Set([...serviceDescs, ctx.abs('/openapi.json'), ctx.abs('/openapi.yaml')])];
    let openapi = null;
    for (const url of candidates.slice(0, 5)) {
      const ex = await ctx.fetch(url, { accept: 'application/openapi+json, application/json, application/yaml, text/yaml;q=0.9, */*;q=0.5', maxBytes: 3_145_728, purpose: 'openapi' });
      if (!ex.ok || /html/.test(ex.contentType) || /^\s*</.test(ex.text)) continue;
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
    let card = found || null;
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

/** POST initialize; returns { ex, ok, result, sessionId, authRequired, challenge, error } */
export async function mcpInitialize(ctx, endpoint, extraHeaders = {}) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: 'agent-ready-check', version: '0.1.0' } } });
  const ex = await ctx.fetch(endpoint, { method: 'POST', body, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': MCP_PROTOCOL, ...extraHeaders }, follow: false, memo: Object.keys(extraHeaders).length === 0, purpose: 'mcp initialize' });
  const out = { ex, ok: false, result: null, sessionId: ex.headers['mcp-session-id'] || null, authRequired: false, challenge: null, error: null };
  if (ex.status === 401) { out.authRequired = true; out.challenge = ex.headers['www-authenticate'] || null; return out; }
  const msg = parseJsonRpc(ex.text, ex.contentType);
  if (ex.ok && msg?.result) { out.ok = true; out.result = msg.result; }
  else out.error = msg?.error ? `JSON-RPC error ${msg.error.code}: ${msg.error.message}` : (ex.error || `HTTP ${ex.status}`);
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
