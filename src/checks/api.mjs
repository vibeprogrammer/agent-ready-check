// Checks for the api layer (APIs). Ids and metadata: src/catalog.json. Owner: H2.
import { pass, warn, fail, info, neutral } from '../core/result.mjs';
import { apiSignals, apiBase, apiSample, mcpSignals, commerceSignals, webmcpSignals } from '../core/discover.mjs';
import { parseLinkset } from '../core/parse/linkset.mjs';
import { validateOpenApi, operations } from '../core/parse/openapi.mjs';

const LINKSET_RE = /^application\/linkset\+json/i;
const pct = (n, d) => (d ? Math.round((100 * n) / d) : 0);

/** RFC 9745: Deprecation is a structured-field Date: "@" followed by integer seconds. */
export const isSfDate = (v) => /^@-?\d{1,15}$/.test(String(v || '').trim());
/** RFC 9110 IMF-fixdate (the HTTP-date form Sunset uses, RFC 8594). */
export const isHttpDate = (v) => /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(String(v || '').trim());

/** Parse draft-ietf-httpapi-ratelimit-headers-11 fields: RateLimit-Policy needs q=, RateLimit needs r=. */
export function parseRateLimit(headers) {
  const policy = headers['ratelimit-policy'] || null; const limit = headers.ratelimit || null;
  const legacy = Object.keys(headers).filter((h) => /^x-ratelimit-|^x-rate-limit-/.test(h));
  const problems = [];
  if (policy && !/(^|;)\s*q=\d+/.test(policy)) problems.push('RateLimit-Policy has no q= (quota) parameter');
  if (limit && !/(^|;)\s*r=\d+/.test(limit)) problems.push('RateLimit has no r= (remaining) parameter');
  return { policy, limit, legacy, problems, retryAfter: headers['retry-after'] || null };
}

export default {
  'api.catalog': {
    why: 'An API catalog at /.well-known/api-catalog is the one fixed place an agent can look to find every API a site offers, with links to their descriptions. isitagentready counts it toward Level 4 (book chapter 7).',
    fix: {
      snippet: '{\n  "linkset": [\n    {\n      "anchor": "https://example.com/api/v1",\n      "service-desc": [{ "href": "https://example.com/openapi.json", "type": "application/openapi+json" }],\n      "service-doc": [{ "href": "https://example.com/docs/api", "type": "text/html" }],\n      "status": [{ "href": "https://example.com/api/v1/health", "type": "application/json" }]\n    }\n  ]\n}',
      prompt: 'Serve /.well-known/api-catalog (RFC 9727) as application/linkset+json with a "linkset" array. Add one entry per API with an "anchor" (the API base URL) and service-desc (OpenAPI URL), service-doc and status links. Verify with: curl -i https://<site>/.well-known/api-catalog',
    },
    async run(ctx) {
      const { catalog } = await apiSignals(ctx);
      const ex = catalog.ex;
      const ls = Array.isArray(catalog.json?.linkset) ? catalog.json.linkset : null;
      const compatOk = ex.ok && !!ls && ls.length > 0;
      const compat = { status: compatOk ? 'pass' : 'fail', message: compatOk ? `linkset with ${ls.length} entr${ls.length === 1 ? 'y' : 'ies'}` : (catalog.error || 'no linkset array') };
      if (!catalog.json) return fail(`No API catalog at /.well-known/api-catalog (${catalog.error}).`, { evidence: [ex], compat });
      if (!ls) return fail('/.well-known/api-catalog is JSON but has no "linkset" array.', { evidence: [ex], compat });
      if (!ls.length) return fail('/.well-known/api-catalog has an empty "linkset" array, so it lists no API.', { evidence: [ex], compat });
      const msg = `The API catalog lists ${ls.length} API entr${ls.length === 1 ? 'y' : 'ies'}`;
      if (!LINKSET_RE.test(ex.contentType)) return warn(`${msg}, but it is served as ${ex.contentType || 'no content type'} instead of application/linkset+json.`, { evidence: [ex], compat, details: { entries: ls.length, contentType: ex.contentType } });
      return pass(`${msg}.`, { evidence: [ex], compat, details: { entries: ls.length } });
    },
  },

  'api.catalog-valid': {
    why: 'A catalog only helps when every entry says which API it is (anchor) and where its description lives (service-desc or service-doc), and those links work (book chapter 7).',
    fix: {
      snippet: 'Content-Type: application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"\n\n{ "linkset": [ { "anchor": "https://example.com/api/v1", "service-desc": [{ "href": "https://example.com/openapi.json" }] } ] }',
      prompt: 'Make every entry in /.well-known/api-catalog have an "anchor" and at least one service-desc or service-doc link whose href answers HTTP 200. Serve it with Content-Type application/linkset+json and the RFC 9727 profile parameter.',
    },
    async run(ctx) {
      const { catalog, openapi } = await apiSignals(ctx);
      if (!catalog.json) return neutral('No API catalog to validate (see api.catalog).', { evidence: [catalog.ex] });
      const ls = parseLinkset(catalog.json, catalog.ex.finalUrl || ctx.abs('/.well-known/api-catalog'));
      const problems = [...ls.errors];
      const ex = catalog.ex;
      if (!LINKSET_RE.test(ex.contentType)) problems.push(`served as ${ex.contentType || 'no content type'}, not application/linkset+json`);
      const noDesc = ls.entries.filter((e) => !e.links['service-desc']?.length && !e.links['service-doc']?.length);
      if (noDesc.length) problems.push(`${noDesc.length} entr${noDesc.length === 1 ? 'y has' : 'ies have'} no service-desc or service-doc link`);
      // Check up to 4 linked descriptions (the OpenAPI document is already fetched).
      const targets = [...new Set(ls.entries.flatMap((e) => [...(e.links['service-desc'] || []), ...(e.links['service-doc'] || [])]).map((l) => l.href))];
      const evidence = [ex]; const broken = [];
      for (const href of targets.slice(0, 4)) {
        if (openapi?.url === href) { evidence.push(openapi.ex); continue; }
        // reuse a finished GET of the same URL from earlier in the scan (any Accept) to save budget
        const prior = (ctx.fetcher?.log || []).find((e) => e.method === 'GET' && e.url === href && e.status > 0);
        const r = prior || await ctx.fetch(href, { accept: '*/*', maxBytes: 65_536, purpose: 'api catalog link' });
        evidence.push(r);
        if (!r.ok) broken.push(`${href} (${r.error || `HTTP ${r.status}`})`);
      }
      if (broken.length) problems.push(`${broken.length} linked description(s) do not answer 200: ${broken.slice(0, 3).join(', ')}`);
      const details = { entries: ls.entries.length, checkedLinks: Math.min(targets.length, 4), broken, problems };
      if (ls.errors.length || noDesc.length === ls.entries.length || broken.length === Math.min(targets.length, 4) && broken.length) return fail(`The API catalog has problems: ${problems.slice(0, 3).join('; ')}.`, { evidence, details });
      if (problems.length) return warn(`The API catalog mostly works but: ${problems.slice(0, 3).join('; ')}.`, { evidence, details });
      if (!/profile=/.test(ex.contentType)) return pass(`All ${ls.entries.length} catalog entries have an anchor and a working description link (the RFC 9727 profile parameter is optional but recommended).`, { evidence, details });
      return pass(`All ${ls.entries.length} catalog entries have an anchor and a working description link.`, { evidence, details });
    },
  },

  'api.openapi': {
    why: 'An OpenAPI description tells an agent every operation, parameter and response of your API, so it can call it without guessing or scraping (book chapter 7).',
    fix: {
      snippet: 'Link: </openapi.json>; rel="service-desc"; type="application/openapi+json"',
      prompt: 'Publish the API\'s OpenAPI 3.1 document at /openapi.json, link it from /.well-known/api-catalog as service-desc, and add a Link header rel="service-desc" on the homepage.',
    },
    async run(ctx) {
      const api = await apiSignals(ctx);
      if (!api.openapi) {
        const tried = api.serviceDescs.length ? `${api.serviceDescs.length} service-desc link(s), /openapi.json, /openapi.yaml and /.well-known/openapi.json` : '/openapi.json, /openapi.yaml and /.well-known/openapi.json';
        return fail(`The site shows an API but no OpenAPI description was found (tried ${tried}).`, { evidence: [api.catalog.ex], details: { serviceDescs: api.serviceDescs } });
      }
      const o = api.openapi;
      const where = new URL(o.url).pathname;
      if (o.via !== 'service-desc') return pass(`OpenAPI description found at ${where} (${o.format}); nothing links to it, so agents have to guess the path. Link it as service-desc.`, { evidence: [o.ex], details: { url: o.url, via: o.via, format: o.format }, fix: 'Add a service-desc link to the OpenAPI URL in the API catalog or a Link header.' });
      return pass(`OpenAPI description found at ${where} (${o.format}), linked as service-desc.`, { evidence: [o.ex], details: { url: o.url, via: o.via, format: o.format } });
    },
  },

  'api.openapi-valid': {
    why: 'Agents and SDK generators stop at the first structural error. A valid OpenAPI 3.x document with resolving $refs is the difference between a callable API and a broken one (book chapter 7).',
    fix: {
      snippet: '{\n  "openapi": "3.1.1",\n  "info": { "title": "Example API", "version": "1.0.0" },\n  "servers": [{ "url": "https://example.com/api/v1" }],\n  "paths": { "/items": { "get": { "operationId": "listItems", "responses": { "200": { "description": "OK" } } } } }\n}',
      prompt: 'Fix the OpenAPI document so it declares "openapi": "3.1.x", has info.title and info.version, a paths object with operations, and every local $ref resolves. Validate it with an OpenAPI linter (for example Redocly CLI: npx @redocly/cli lint openapi.json).',
    },
    async run(ctx) {
      const { openapi } = await apiSignals(ctx);
      if (!openapi) return neutral('No OpenAPI document to validate (see api.openapi).');
      const v = validateOpenApi(openapi.doc);
      const details = { version: v.version, operations: v.operations, refs: v.refs, errors: v.errors, warnings: v.warnings };
      if (v.errors.length) return fail(`The OpenAPI document has ${v.errors.length} structural error(s): ${v.errors.slice(0, 2).join('; ')}.`, { evidence: [openapi.ex], details });
      const msg = `OpenAPI ${v.version} with ${v.operations} operation(s) and ${v.refs.total} $ref(s), all local refs resolve`;
      if (v.warnings.length) return pass(`${msg} (notes: ${v.warnings.join('; ')}).`, { evidence: [openapi.ex], details });
      return pass(`${msg}.`, { evidence: [openapi.ex], details });
    },
  },

  'api.openapi-agent-quality': {
    why: 'An agent picks an operation by its id and description and fills parameters from their descriptions. Unnamed, undescribed operations are guesswork (book chapter 10).',
    fix: {
      snippet: '"get": {\n  "operationId": "searchItems",\n  "summary": "Search items by keyword and date",\n  "parameters": [{ "name": "q", "in": "query", "description": "Free-text search, e.g. \\"sauna\\"", "schema": { "type": "string" } }],\n  "responses": { "200": { "description": "Matching items", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/ItemList" } } } } }\n}',
      prompt: 'For every operation in the OpenAPI document add a unique camelCase operationId, a one-line summary saying what it does and when to use it, a description on every parameter (with an example), and a JSON schema for each 2xx response.',
    },
    async run(ctx) {
      const { openapi } = await apiSignals(ctx);
      if (!openapi) return neutral('No OpenAPI document to assess (see api.openapi).');
      const ops = operations(openapi.doc);
      if (!ops.length) return neutral('The OpenAPI document has no operations to assess.', { evidence: [openapi.ex] });
      const withId = ops.filter((o) => typeof o.op.operationId === 'string' && o.op.operationId.trim()).length;
      const withDesc = ops.filter((o) => (o.op.summary || o.op.description || '').trim().length >= 10).length;
      const paramsOk = ops.filter((o) => o.params.every((p) => (p.description || '').trim())).length;
      const respOk = ops.filter((o) => Object.entries(o.op.responses || {}).some(([code, r]) => /^2/.test(code) && (r?.$ref || (r?.content && Object.values(r.content).some((c) => c?.schema))))).length;
      const okRespNeeded = ops.filter((o) => !Object.keys(o.op.responses || {}).some((c) => c === '204')).length || 1;
      const shares = { operationId: withId / ops.length, summary: withDesc / ops.length, parameters: paramsOk / ops.length, responseSchemas: Math.min(1, respOk / okRespNeeded) };
      const score = (shares.operationId + shares.summary + shares.parameters + shares.responseSchemas) / 4;
      const details = { operations: ops.length, withOperationId: withId, withSummary: withDesc, withDescribedParams: paramsOk, withResponseSchema: respOk, score: Math.round(score * 100), thresholds: 'checker heuristic: pass at 80%, warn at 50%' };
      const msg = `${ops.length} operation(s): ${pct(withId, ops.length)}% have an operationId, ${pct(withDesc, ops.length)}% a summary, ${pct(paramsOk, ops.length)}% fully described parameters, ${pct(respOk, ops.length)}% a response schema`;
      if (score >= 0.8) return pass(`${msg}.`, { evidence: [openapi.ex], details });
      if (score >= 0.5) return warn(`${msg}; agents will guess on the rest.`, { evidence: [openapi.ex], details });
      return fail(`${msg}; most operations are hard for an agent to choose and fill.`, { evidence: [openapi.ex], details });
    },
  },

  'api.problem-json': {
    why: 'When a call fails, an agent needs a machine-readable reason to recover. RFC 9457 problem details give it a type, title and status instead of an HTML error page (book chapter 7).',
    fix: {
      snippet: 'HTTP/1.1 404 Not Found\nContent-Type: application/problem+json\n\n{ "type": "https://example.com/problems/not-found", "title": "No item with that id", "status": 404, "detail": "Item 42 does not exist." }',
      prompt: 'Make every API error (4xx and 5xx, including unknown routes) answer with Content-Type application/problem+json and a JSON body with type, title, status and detail (RFC 9457). Verify with: curl -i https://<site>/api/does-not-exist',
    },
    async run(ctx) {
      const base = await apiBase(ctx);
      const url = new URL('agent-ready-check-unknown-route', base.url).href;
      const ex = await ctx.fetch(url, { accept: 'application/json, application/problem+json;q=0.9', purpose: 'api error probe' });
      const details = { probe: url, base: base.source, status: ex.status, contentType: ex.contentType };
      if (ex.error) return warn(`The API error probe (${url}) failed: ${ex.error}.`, { evidence: [ex], details });
      if (ex.ok) return warn(`An unknown API route (${new URL(url).pathname}) answered HTTP ${ex.status} instead of an error, so agents cannot tell a typo from a result.`, { evidence: [ex], details });
      let body = null; try { body = JSON.parse(ex.text); } catch { /* not JSON */ }
      if (/^application\/problem\+json/i.test(ex.contentType)) {
        const missing = ['title', 'status'].filter((k) => body?.[k] === undefined);
        if (!body) return warn(`Errors are labelled application/problem+json but the body is not JSON (HTTP ${ex.status}).`, { evidence: [ex], details });
        if (missing.length) return warn(`Errors use application/problem+json (HTTP ${ex.status}) but the body lacks ${missing.join(' and ')}.`, { evidence: [ex], details });
        if (body.status !== ex.status) return warn(`Problem details say status ${body.status} but the response is HTTP ${ex.status}.`, { evidence: [ex], details });
        return pass(`An unknown API route answers HTTP ${ex.status} with RFC 9457 problem details ("${String(body.title).slice(0, 60)}").`, { evidence: [ex], details });
      }
      if (body && typeof body === 'object') return warn(`API errors are JSON (HTTP ${ex.status}, ${ex.contentType || 'no content type'}) but not RFC 9457 application/problem+json.`, { evidence: [ex], details });
      return fail(`An unknown API route answers HTTP ${ex.status} with ${/html/.test(ex.contentType) ? 'an HTML page' : ex.contentType || 'an unlabelled body'}, not machine-readable problem details.`, { evidence: [ex], details });
    },
  },

  'api.ratelimit': {
    why: 'Agents run in loops. Announcing the quota in RateLimit headers lets them slow down before they hit 429 instead of being blocked (book chapter 7). The header fields are an IETF draft.',
    fix: {
      snippet: 'RateLimit-Policy: "default";q=100;w=60\nRateLimit: "default";r=99;t=60',
      prompt: 'Add the IETF RateLimit-Policy and RateLimit response headers (draft-ietf-httpapi-ratelimit-headers-11) to every API response, and answer 429 with Retry-After and an application/problem+json body when the quota is used up.',
    },
    async run(ctx) {
      const api = await apiSignals(ctx);
      const sample = await apiSample(ctx);
      const base = await apiBase(ctx);
      const probe = await ctx.fetch(new URL('agent-ready-check-unknown-route', base.url).href, { accept: 'application/json, application/problem+json;q=0.9', purpose: 'api error probe' });
      const exs = [sample?.ex, probe, api.openapi?.ex].filter((e) => e && !e.error);
      const found = exs.map((e) => ({ e, r: parseRateLimit(e.headers) }));
      const std = found.find((f) => f.r.policy || f.r.limit);
      const legacy = found.find((f) => f.r.legacy.length);
      const details = { checked: exs.map((e) => e.url), sample: sample?.op || null };
      if (std) {
        if (std.r.problems.length) return warn(`RateLimit headers are present on ${std.e.url} but malformed: ${std.r.problems.join('; ')}.`, { evidence: [std.e], details: { ...details, ...std.r } });
        return pass(`API responses announce their quota (${std.r.policy ? `RateLimit-Policy: ${std.r.policy}` : `RateLimit: ${std.r.limit}`}).`, { evidence: [std.e], details: { ...details, ...std.r } });
      }
      if (legacy) return warn(`Only legacy ${legacy.r.legacy.join(', ')} headers were seen; the IETF RateLimit/RateLimit-Policy fields are what new clients read.`, { evidence: [legacy.e], details: { ...details, legacy: legacy.r.legacy } });
      return fail(`None of the ${exs.length} API response(s) checked carry RateLimit headers, so agents cannot pace themselves.`, { evidence: exs, details });
    },
  },

  'api.deprecation': {
    why: 'APIs change. Deprecation (RFC 9745) and Sunset (RFC 8594) headers warn an agent in-band, before a call it depends on stops working (book chapter 20).',
    fix: {
      snippet: 'Deprecation: @1798761600\nSunset: Sat, 01 Jan 2028 00:00:00 GMT\nLink: <https://example.com/docs/migrate-v2>; rel="deprecation"',
      prompt: 'On deprecated API endpoints add a Deprecation header in RFC 9745 form (@ followed by Unix seconds), a Sunset header with an HTTP-date, and a Link rel="deprecation" to the migration guide. Mark the operations "deprecated": true in OpenAPI.',
    },
    async run(ctx) {
      const api = await apiSignals(ctx);
      const sample = await apiSample(ctx);
      const exs = [sample?.ex, api.openapi?.ex].filter((e) => e && !e.error);
      const deprecatedOps = api.openapi ? operations(api.openapi.doc).filter((o) => o.op.deprecated === true).map((o) => `${o.method.toUpperCase()} ${o.path}`) : [];
      const bad = []; const seen = [];
      for (const e of exs) {
        const d = e.headers.deprecation; const s = e.headers.sunset;
        if (d) { seen.push(`Deprecation: ${d}`); if (!isSfDate(d)) bad.push(`Deprecation "${d}" is not an RFC 9745 date (@<unix seconds>)${/^true$/i.test(d) ? '; "true" was the old draft form' : ''}`); }
        if (s) { seen.push(`Sunset: ${s}`); if (!isHttpDate(s)) bad.push(`Sunset "${s}" is not an HTTP-date`); }
      }
      const details = { headers: seen, deprecatedOperations: deprecatedOps.slice(0, 20) };
      if (bad.length) return warn(`Deprecation signalling is malformed: ${bad.join('; ')}.`, { evidence: exs, details });
      if (seen.length) return pass(`Deprecation signalling is well-formed (${seen.join(', ')}).`, { evidence: exs, details });
      if (deprecatedOps.length) return info(`${deprecatedOps.length} operation(s) are marked deprecated in OpenAPI, but no Deprecation/Sunset headers were seen on the responses checked.`, { evidence: exs, details });
      return info('No deprecated endpoints or Deprecation/Sunset headers were seen (informational).', { evidence: exs, details });
    },
  },

  'api.actionable-interface': {
    why: 'If people can search, book or buy on your site, agents need a way to do the same without clicking through forms: an API, an MCP server or WebMCP tools (book chapter 13).',
    fix: {
      snippet: '<form action="/search" toolname="search_items" tooldescription="Search the catalogue by keyword">\n  <input name="q" toolparamdescription="Search words">\n</form>',
      prompt: 'Give the site\'s main actions a machine interface. Cheapest: add WebMCP attributes (toolname, tooldescription) to the existing forms. Fuller: publish an OpenAPI-described API and list it in /.well-known/api-catalog, or an MCP server with a server card.',
    },
    async run(ctx) {
      const doc = await ctx.dom();
      const forms = doc.querySelectorAll('form').length;
      const commerce = await commerceSignals(ctx);
      if (!forms && !commerce.isCommerce) return neutral('The page has no forms and no commerce signals, so no machine interface is expected.');
      const [api, mcp, webmcp] = await Promise.all([apiSignals(ctx), mcpSignals(ctx), webmcpSignals(ctx)]);
      const have = [];
      if (api.catalog.json?.linkset?.length) have.push('API catalog');
      if (api.openapi) have.push('OpenAPI');
      if (mcp.hasMcp) have.push('MCP');
      if (webmcp.hasWebmcp) have.push(webmcp.browserTools?.length ? `${webmcp.browserTools.length} WebMCP tool(s)` : webmcp.forms.length ? `${webmcp.forms.length} declarative WebMCP form(s)` : 'WebMCP registerTool() in page scripts');
      const why = [forms ? `${forms} form(s)` : null, commerce.isCommerce ? 'commerce signals' : null].filter(Boolean).join(' and ');
      if (have.length) return pass(`The page has ${why}, and agents can act through: ${have.join(', ')}.`, { details: { have, forms, commerce: commerce.signals } });
      const b = await ctx.browserData();
      return fail(`The page has ${why}, but no API, MCP server or WebMCP tool was found${b ? '' : ' (WebMCP was checked statically; a browser run can find registerTool() in external scripts)'}.`, { details: { forms, commerce: commerce.signals } });
    },
  },
};
