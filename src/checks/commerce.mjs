// Checks for the commerce layer. Ids and metadata: src/catalog.json. Owner: H2.
// We never pay and never start a checkout: x402 is read from a plain GET's 402 answer only.
import { pass, warn, fail, info, neutral } from '../core/result.mjs';
import { typesOf } from '../core/context.mjs';
import { commerceSignals, apiSignals, apiBase } from '../core/discover.mjs';
import { operations } from '../core/parse/openapi.mjs';
import { wk } from './discovery.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const AVAIL = /^(https?:\/\/schema\.org\/)?(InStock|OutOfStock|PreOrder|BackOrder|Discontinued|InStoreOnly|LimitedAvailability|OnlineOnly|PreSale|SoldOut|Reserved|MadeToOrder)$/;

/** Decode an x402 payment requirement from a 402 answer: V2 PAYMENT-REQUIRED header (base64 JSON) or a V1 JSON body. */
export function readX402(ex) {
  if (ex.status !== 402) return null;
  const h = ex.headers['payment-required'];
  if (h) {
    try {
      const j = JSON.parse(atob(h.trim()));
      if (isObj(j) && (Array.isArray(j.accepts) || j.x402Version)) return { version: j.x402Version || 2, via: 'PAYMENT-REQUIRED header', accepts: j.accepts?.length || 0 };
    } catch { /* not base64 JSON */ }
  }
  try {
    const j = JSON.parse(ex.text);
    if (isObj(j) && j.x402Version && Array.isArray(j.accepts)) return { version: j.x402Version, via: 'JSON body', accepts: j.accepts.length };
  } catch { /* not JSON */ }
  return null;
}

/** Numbers a price could be written as on the page (1290, 1 290, 1,290, 1.290, 1290.00, 1290,00). */
function priceForms(p) {
  const n = Number(String(p).replace(',', '.'));
  if (!Number.isFinite(n)) return [String(p)];
  const int = Math.trunc(n); const dec = (n % 1).toFixed(2).slice(2);
  const group = (sep) => String(int).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  const ints = [String(int), group(','), group('.'), group(' '), group('\u00a0'), group('\u202f')];
  return n % 1 ? ints.flatMap((i) => [`${i}.${dec}`, `${i},${dec}`]) : [...ints, ...ints.map((i) => `${i}.00`), ...ints.map((i) => `${i},00`), ...ints.map((i) => `${i},-`)];
}

export default {
  'commerce.detected': {
    why: 'Commerce protocols (UCP, ACP, x402, MPP, AP2) and product data only matter for sites that sell or book. This check decides whether the commerce checks are scored (book chapter 12).',
    fix: { snippet: '{ "@context": "https://schema.org", "@type": "Product", "name": "...", "offers": { "@type": "Offer", "price": "49.00", "priceCurrency": "EUR", "availability": "https://schema.org/InStock" } }', prompt: 'If the site sells or books anything, mark products and offers up with schema.org Product/Offer JSON-LD so agents (and this checker) recognise it as a shop.' },
    async run(ctx) {
      const c = await commerceSignals(ctx);
      if (c.isCommerce) return info(`Commerce signals found (${c.signals.join(', ')}), so commerce checks are scored.`, { details: c });
      return info('No commerce signals found (no Product/Offer data, cart links or shop platform markers), so commerce checks are not scored.', { details: c });
    },
  },

  'commerce.product-data': {
    why: 'Shopping agents compare offers from structured data. Without price, currency and availability in Product/Offer JSON-LD, or with a price that differs from the page, they skip you or quote the wrong price (book chapter 12).',
    fix: {
      snippet: '<script type="application/ld+json">\n{ "@context": "https://schema.org", "@type": "Product", "name": "Fjellro cabin",\n  "offers": { "@type": "Offer", "price": "1290", "priceCurrency": "NOK", "availability": "https://schema.org/InStock" } }\n</script>',
      prompt: 'Add schema.org Product (or the right subtype) JSON-LD to product pages with offers.price (a number as a string, no currency sign), offers.priceCurrency (ISO 4217), and offers.availability (a schema.org ItemAvailability URL); render it from the same data as the visible price so they never differ.',
    },
    async run(ctx) {
      const offers = []; const products = [];
      for (const b of await ctx.jsonld()) for (const n of b.nodes) {
        const t = typesOf(n);
        if (t.some((x) => ['Product', 'ProductGroup', 'IndividualProduct', 'ProductModel', 'Vehicle', 'Book', 'SoftwareApplication', 'Accommodation', 'Room', 'House', 'Apartment', 'VacationRental', 'LodgingBusiness', 'Hotel', 'Event', 'Trip'].includes(x)) && n.offers) products.push(n);
        if (t.includes('Offer')) offers.push(n);
        if (t.includes('AggregateOffer')) offers.push({ ...n, price: n.lowPrice ?? n.price });
      }
      for (const p of products) for (const o of [].concat(p.offers)) if (isObj(o) && !offers.includes(o)) offers.push(typesOf(o).includes('AggregateOffer') ? { ...o, price: o.lowPrice ?? o.price } : o);
      if (!offers.length) return fail('No schema.org Offer with a price was found in the page\'s JSON-LD, so agents cannot read what anything costs.', { details: { products: products.length } });
      const text = await ctx.text();
      const rows = offers.slice(0, 50).map((o) => {
        const price = o.price ?? o.priceSpecification?.price;
        const currency = o.priceCurrency ?? o.priceSpecification?.priceCurrency;
        const missing = [['price', price], ['priceCurrency', currency], ['availability', o.availability]].filter(([, v]) => v === undefined || v === '').map(([k]) => k);
        const availOk = o.availability === undefined || AVAIL.test(String(o.availability));
        const visible = price === undefined ? null : priceForms(price).some((f) => text.includes(f));
        return { price, currency, availability: o.availability, missing, availOk, visible };
      });
      const incomplete = rows.filter((r) => r.missing.length);
      const badAvail = rows.filter((r) => !r.availOk);
      const hidden = rows.filter((r) => r.visible === false);
      const details = { offers: rows.length, rows: rows.slice(0, 10), heuristic: 'visible-price match compares number formats in the server HTML text' };
      if (incomplete.length === rows.length) return fail(`${rows.length} offer(s) found but none has price, priceCurrency and availability (missing: ${[...new Set(incomplete.flatMap((r) => r.missing))].join(', ')}).`, { details });
      const problems = [];
      if (incomplete.length) problems.push(`${incomplete.length} offer(s) lack ${[...new Set(incomplete.flatMap((r) => r.missing))].join('/')}`);
      if (badAvail.length) problems.push(`${badAvail.length} availability value(s) are not schema.org ItemAvailability`);
      if (hidden.length) problems.push(`${hidden.length} JSON-LD price(s) (${hidden.slice(0, 3).map((r) => r.price).join(', ')}) do not appear in the visible text`);
      if (problems.length) return warn(`Offer data is partly usable: ${problems.join('; ')}.`, { details });
      return pass(`${rows.length} offer(s) carry price, currency and availability, and the prices match the visible page.`, { details });
    },
  },

  'commerce.ucp': {
    why: 'A UCP business profile tells shopping agents which commerce services and capabilities (checkout, booking, orders) your site supports (book chapter 12). UCP is a dated spec; some capabilities are drafts.',
    fix: {
      snippet: '{ "ucp": { "version": "2026-08-25", "services": { "dev.ucp.shopping": [{ "version": "2026-08-25", "transport": "rest", "endpoint": "https://example.com/ucp/v1" }] }, "capabilities": { "dev.ucp.shopping.checkout": [{ "version": "2026-08-25" }] } } }',
      prompt: 'Serve /.well-known/ucp as JSON with the UCP protocol version, the services you implement (each with transport and an https endpoint) and the capabilities you support, following ucp.dev.',
    },
    async run(ctx) {
      const r = await wk(ctx, '/.well-known/ucp', 'ucp profile');
      const j = r.json;
      const version = j?.protocol_version || j?.ucp?.version || j?.version;
      const services = j?.services || j?.ucp?.services;
      const ok = !!(version && services);
      const compat = { status: ok ? 'pass' : 'fail', message: ok ? 'UCP profile' : 'no /.well-known/ucp with protocol_version and services' };
      if (ok) return pass(`A UCP profile (version ${version}) lists ${Array.isArray(services) ? services.length : Object.keys(services).length} service(s).`, { evidence: [r.ex], compat, details: { version, services: Array.isArray(services) ? services.length : Object.keys(services) } });
      if (j) return fail(`/.well-known/ucp is JSON but lacks ${version ? 'services' : 'a protocol version'}.`, { evidence: [r.ex], compat });
      return fail(`No UCP profile at /.well-known/ucp (${r.error}).`, { evidence: [r.ex], compat });
    },
  },

  'commerce.ucp-valid': {
    why: 'Agents act on the endpoints and capabilities a UCP profile names; a profile without capabilities or with non-https endpoints cannot be used (book chapter 12).',
    fix: {
      snippet: '"services": { "dev.ucp.shopping": [{ "version": "2026-08-25", "transport": "rest", "endpoint": "https://example.com/ucp/v1", "schema": "https://ucp.dev/services/shopping/rest.openapi.json" }] }',
      prompt: 'In /.well-known/ucp give every service binding a transport and an https endpoint, and list the capabilities you implement with their versions.',
    },
    async run(ctx) {
      const r = await wk(ctx, '/.well-known/ucp', 'ucp profile');
      const root = r.json?.ucp || r.json;
      if (!root || !(root.services)) return neutral('No UCP profile to validate (see commerce.ucp).', { evidence: [r.ex] });
      const problems = [];
      const caps = root.capabilities;
      if (!caps || (Array.isArray(caps) ? !caps.length : !Object.keys(caps).length)) problems.push('no capabilities');
      const bindings = Array.isArray(root.services) ? root.services : Object.entries(root.services).flatMap(([name, v]) => [].concat(v).map((b) => ({ name, ...b })));
      if (!bindings.length) problems.push('no service bindings');
      for (const b of bindings) {
        const ep = b.endpoint || b.url || b.rest?.endpoint;
        if (!b.transport && !b.rest && !b.mcp && !b.a2a) problems.push(`${b.name || 'a service'} has no transport`);
        if (ep && !/^https:\/\//.test(ep)) problems.push(`${b.name || 'a service'} endpoint ${ep} is not https`);
        if (!ep && !b.mcp && !b.a2a) problems.push(`${b.name || 'a service'} has no endpoint`);
      }
      const details = { bindings: bindings.length, capabilities: caps ? (Array.isArray(caps) ? caps.length : Object.keys(caps)) : 0, problems };
      if (problems.length) return warn(`The UCP profile has gaps: ${problems.slice(0, 3).join('; ')}.`, { evidence: [r.ex], details });
      return pass(`The UCP profile names ${bindings.length} service binding(s) with https endpoints and ${Array.isArray(caps) ? caps.length : Object.keys(caps).length} capability(ies).`, { evidence: [r.ex], details });
    },
  },

  'commerce.acp': {
    why: 'The ACP discovery document tells agents where your Agentic Commerce Protocol checkout lives. The ACP repository says merchant discovery is not yet defined, so this path is the scanner\'s convention (book chapter 12).',
    fix: {
      snippet: '{ "protocol": { "name": "acp", "version": "2026-09-30" }, "api_base_url": "https://example.com/acp", "transports": ["rest"], "capabilities": { "services": ["checkout"] } }',
      prompt: 'If you implement the Agentic Commerce Protocol, serve /.well-known/acp.json with protocol.name, protocol.version, api_base_url, transports and capabilities.services.',
    },
    async run(ctx) {
      const r = await wk(ctx, '/.well-known/acp.json', 'acp discovery');
      const j = r.json;
      const need = { 'protocol.name': j?.protocol?.name, 'protocol.version': j?.protocol?.version, api_base_url: j?.api_base_url, transports: j?.transports, 'capabilities.services': j?.capabilities?.services };
      const missing = Object.entries(need).filter(([, v]) => !v).map(([k]) => k);
      const ok = !!j && !missing.length;
      const compat = { status: ok ? 'pass' : 'fail', message: ok ? 'ACP discovery document' : 'no complete /.well-known/acp.json' };
      if (ok) return pass(`An ACP discovery document (version ${j.protocol.version}) points at ${j.api_base_url}.`, { evidence: [r.ex], compat });
      if (j) return fail(`/.well-known/acp.json lacks ${missing.join(', ')}.`, { evidence: [r.ex], compat, details: { missing } });
      return fail('No ACP discovery document at /.well-known/acp.json.', { evidence: [r.ex], compat });
    },
  },

  'commerce.x402': {
    why: 'x402 lets an agent pay for an API call in-band: the route answers 402 with machine-readable payment requirements. Only relevant for paid APIs (book chapter 12).',
    fix: {
      snippet: 'HTTP/1.1 402 Payment Required\nPAYMENT-REQUIRED: <base64 of {"x402Version":2,"accepts":[{"scheme":"exact","network":"...","amount":"10000","payTo":"..."}]}>',
      prompt: 'For paid API routes, add x402 middleware so an unpaid request answers HTTP 402 with a PAYMENT-REQUIRED header (base64 JSON with x402Version and accepts) as the x402 V2 spec describes.',
    },
    async run(ctx) {
      const home = await ctx.home();
      const cands = [home];
      const api = await apiSignals(ctx);
      if (api.openapi) {
        const base = (await apiBase(ctx)).url;
        const paid = operations(api.openapi.doc).filter((o) => o.method === 'get' && !o.path.includes('{') && (o.op.responses?.['402'] || o.op['x-payment-info'] || o.op['x-x402'])).slice(0, 2);
        for (const o of paid) { try { cands.push(await ctx.fetch(new URL(o.path.replace(/^\//, ''), base).href, { accept: 'application/json', purpose: 'x402 candidate route (GET, never paid)' })); } catch { /* bad URL */ } }
      }
      const hit = cands.map((ex) => ({ ex, x: readX402(ex) })).find((c) => c.x);
      if (hit) return pass(`${new URL(hit.ex.url).pathname} answers 402 with x402 v${hit.x.version} payment requirements (${hit.x.via}, ${hit.x.accepts} option(s)).`, { evidence: [hit.ex], compat: { status: 'pass', message: 'HTTP 402 with x402 payment requirements' }, details: hit.x });
      const bare = cands.find((ex) => ex.status === 402);
      if (bare) return fail(`${new URL(bare.url).pathname} answers 402 but without readable x402 requirements.`, { evidence: [bare], compat: { status: 'fail', message: '402 without x402 headers' } });
      return fail(`No route answered 402 with x402 payment requirements (checked ${cands.length}).`, { evidence: cands, compat: { status: 'fail', message: 'no x402 response' } });
    },
  },

  'commerce.mpp': {
    why: 'MPP (Machine Payment Protocol) puts price and payment details on each payable OpenAPI operation (x-payment-info) so an agent knows the cost before calling (book chapter 12).',
    fix: {
      snippet: '"post": { "operationId": "createReport", "x-payment-info": { "price": "0.05", "currency": "USD", "protocols": ["x402"] } }',
      prompt: 'Add an x-payment-info extension to every payable operation in /openapi.json, describing price, currency and the accepted payment protocols per the MPP payment discovery draft.',
    },
    async run(ctx) {
      const api = await apiSignals(ctx);
      const atRoot = api.openapi && new URL(api.openapi.url).pathname === '/openapi.json' ? api.openapi.ex : await ctx.fetch('/openapi.json', { accept: 'application/openapi+json, application/json, application/yaml, text/yaml;q=0.9, */*;q=0.5', maxBytes: 3_145_728, purpose: 'openapi' });
      const compatOk = atRoot.ok && atRoot.text.includes('x-payment-info');
      const compat = { status: compatOk ? 'pass' : 'fail', message: compatOk ? 'OpenAPI with x-payment-info' : 'no x-payment-info in /openapi.json' };
      const doc = api.openapi?.doc;
      const payable = doc ? operations(doc).filter((o) => o.op['x-payment-info']).map((o) => `${o.method.toUpperCase()} ${o.path}`) : [];
      if (payable.length) return pass(`${payable.length} OpenAPI operation(s) declare x-payment-info (${payable.slice(0, 3).join(', ')}).`, { evidence: [api.openapi.ex], compat, details: { payable } });
      if (compatOk) return pass('/openapi.json mentions x-payment-info.', { evidence: [atRoot], compat });
      return fail(api.openapi ? 'The OpenAPI document has no x-payment-info on any operation.' : 'No /openapi.json, so no MPP payment info.', { evidence: [atRoot], compat });
    },
  },

  'commerce.ap2': {
    why: 'AP2 (Agent Payments Protocol) is declared as an extension in an A2A Agent Card with your role (merchant, shopper...), so payment agents know how to transact with yours (book chapter 12).',
    fix: {
      snippet: '"capabilities": { "extensions": [{ "uri": "https://github.com/google-agentic-commerce/ap2/tree/v0.1", "params": { "roles": ["merchant"] } }] }',
      prompt: 'If your A2A agent takes payments, add the AP2 extension to /.well-known/agent-card.json under capabilities.extensions with params.roles naming your role.',
    },
    async run(ctx) {
      const r = await wk(ctx, '/.well-known/agent-card.json', 'a2a agent card');
      if (!r.json) return fail('No A2A Agent Card, so no AP2 extension (AP2 lives in the A2A card).', { evidence: [r.ex], compat: { status: 'fail', message: 'no A2A Agent Card' } });
      const exts = [...(r.json.capabilities?.extensions || []), ...(r.json.extensions || [])].filter(isObj);
      const ap2 = exts.find((e) => /ap2/i.test(e.uri || e.url || e.name || ''));
      const roles = ap2 ? [].concat(ap2.params?.roles || ap2.params?.role || ap2.roles || ap2.role || []) : [];
      if (ap2 && roles.length) return pass(`The A2A card declares AP2 with role(s) ${roles.join(', ')}.`, { evidence: [r.ex], compat: { status: 'pass', message: 'AP2 extension with role' }, details: { uri: ap2.uri, roles } });
      if (ap2) return fail('The A2A card declares AP2 but names no role.', { evidence: [r.ex], compat: { status: 'fail', message: 'AP2 extension without role' } });
      return fail('The A2A card has no AP2 extension.', { evidence: [r.ex], compat: { status: 'fail', message: 'no AP2 extension' } });
    },
  },

  'commerce.vrp': {
    why: 'The Vacation Rental Protocol (v0.1, a single-maintainer draft) lets a lodging host publish signed offers for agents. Informational, and only for rentals (book chapter 12).',
    fix: { snippet: '/.well-known/vacation-rental.json  (see the VRP v0.1 draft for the signed offer format)', prompt: 'Only for vacation-rental hosts that want to try the draft: publish /.well-known/vacation-rental.json following the VRP v0.1 draft.' },
    async run(ctx) {
      const r = await wk(ctx, '/.well-known/vacation-rental.json', 'vacation rental protocol');
      if (r.json) return pass('A Vacation Rental Protocol document is published at /.well-known/vacation-rental.json (informational; content not validated against the v0.1 draft).', { evidence: [r.ex] });
      return info('No /.well-known/vacation-rental.json (informational; only relevant for vacation-rental hosts).', { evidence: [r.ex] });
    },
  },
};
