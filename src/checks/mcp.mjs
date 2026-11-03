// Checks for the mcp layer (MCP servers). Ids and metadata: src/catalog.json. Owner: H2.
// We only ever send initialize, notifications/initialized and tools/list; we never call a tool.
import { pass, warn, fail, info, neutral, skipped } from '../core/result.mjs';
import { mcpSignals, mcpTools, mcpInitialize, MCP_CARD_PATHS } from '../core/discover.mjs';
import { lintSchema } from '../core/parse/jsonschema.mjs';

// MCP tool name rule (specification 2025-11-25, "Tool names"): 1-128 characters of A-Z a-z 0-9 _ - .
export const TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;
// Oldest protocol version we do not warn about: 2025-06-18 (the catalog's rule for mcp.protocol-version).
export const OLDEST_CURRENT = '2025-06-18';

/** Cloudflare's published mcpServerCard rule: serverInfo.name or a flat name (or an array whose first card has one). */
export function iiaCardOk(j) {
  return !!(j && (j.serverInfo?.name || j.name || (Array.isArray(j) && (j[0]?.serverInfo?.name || j[0]?.name))));
}

const authNote = 'the endpoint requires authorization, so this was not checked (we never send credentials)';

export default {
  'mcp.server-card': {
    why: 'A server card describes an MCP server (name, endpoint, what it offers) before an agent connects, so clients and registries can find it. isitagentready counts it toward Level 4 (book chapter 11).',
    fix: {
      snippet: '{\n  "$schema": "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",\n  "name": "com.example/shop",\n  "version": "1.0.0",\n  "description": "Search the catalogue and place orders.",\n  "remotes": [{ "type": "streamable-http", "url": "https://example.com/mcp" }]\n}',
      prompt: 'Serve an MCP server card as JSON at /.well-known/mcp/server-card.json (the path scanners read today) and at <mcp-endpoint>/server-card (the SEP-2127 location), with name, version, description and a remotes entry pointing at the MCP endpoint.',
    },
    async run(ctx) {
      const mcp = await mcpSignals(ctx);
      const valid = mcp.cards.find((c) => iiaCardOk(c.json));
      const evidence = mcp.cards.map((c) => c.ex);
      const compat = valid ? { status: 'pass', message: `MCP Server Card at ${valid.path}` } : { status: 'fail', message: 'no valid MCP Server Card' };
      if (valid) {
        const j = Array.isArray(valid.json) ? valid.json[0] : valid.json;
        const name = j.serverInfo?.name || j.name;
        return pass(`An MCP server card for "${name}" is published at ${valid.path}.`, { evidence: [valid.ex], compat, details: { path: valid.path, name } });
      }
      const jsonNoName = mcp.cards.find((c) => c.json);
      if (jsonNoName) return fail(`${jsonNoName.path} is JSON but has no server name (serverInfo.name or name).`, { evidence, compat });
      if (mcp.init?.ok || mcp.init?.authRequired) return fail(`An MCP endpoint answers at ${new URL(mcp.endpoint).pathname}, but no server card was found at ${MCP_CARD_PATHS.join(', ')}.`, { evidence: [...evidence, mcp.init.ex], compat });
      return fail(`No MCP server card at ${MCP_CARD_PATHS.join(', ')}.`, { evidence, compat });
    },
  },

  'mcp.server-card-valid': {
    why: 'A card is only useful when it names the server and version and points at an endpoint that actually answers (book chapter 11).',
    fix: {
      snippet: '"remotes": [{ "type": "streamable-http", "url": "https://example.com/mcp", "supportedProtocolVersions": ["2025-11-25", "2026-07-28"] }]',
      prompt: 'Complete the MCP server card: add name, version, description and remotes[0].url pointing at the live MCP endpoint, and also serve the card at <endpoint>/server-card (SEP-2127). Verify the endpoint answers an initialize POST.',
    },
    async run(ctx) {
      const mcp = await mcpSignals(ctx);
      if (!mcp.card || !mcp.cardData) return neutral('No server card to validate (see mcp.server-card).');
      const c = mcp.cardData;
      const problems = []; const notes = [];
      const name = c.serverInfo?.name || c.name; const version = c.serverInfo?.version || c.version;
      const declared = c.transport?.url || c.transport?.endpoint || c.url || c.endpoint || c.remotes?.[0]?.url || c.remotes?.[0]?.href;
      if (!name) problems.push('no name');
      if (!version) problems.push('no version');
      if (!c.description && !c.serverInfo?.description) notes.push('no description');
      if (!declared) problems.push('no endpoint (remotes[].url or transport.url)');
      const live = mcp.init?.ok || mcp.init?.authRequired;
      if (declared && !live) problems.push(`the endpoint ${mcp.endpoint} did not answer initialize (${mcp.init?.error || 'no answer'})`);
      const evidence = [mcp.card.ex, mcp.init?.ex];
      let sep = null;
      if (declared) {
        const sepUrl = mcp.endpoint.replace(/\/$/, '') + '/server-card';
        const s = await ctx.json(sepUrl, { purpose: 'mcp server card (SEP-2127 location)' });
        evidence.push(s.ex);
        sep = { url: sepUrl, found: !!s.json, contentType: s.ex.contentType };
        if (!s.json) notes.push(`not served at the SEP-2127 location ${new URL(sepUrl).pathname}`);
      }
      const details = { path: mcp.card.path, name, version, endpoint: mcp.endpoint, live, sep2127: sep, problems, notes };
      if (!name || !declared) return fail(`The server card at ${mcp.card.path} is incomplete: ${problems.join('; ')}.`, { evidence, details });
      if (problems.length) return warn(`The server card has problems: ${[...problems, ...notes].join('; ')}.`, { evidence, details });
      if (notes.length) return warn(`The server card for "${name}" ${version} points at a live endpoint, but: ${notes.join('; ')}.`, { evidence, details });
      return pass(`The server card for "${name}" ${version} points at a live endpoint and is also at the SEP-2127 location.`, { evidence, details });
    },
  },

  'mcp.endpoint': {
    why: 'The MCP endpoint is where agents actually connect. It must answer server/discover (MCP 2026-07-28) or the 2025-era initialize handshake with a JSON-RPC result, or a proper 401 challenge when it needs OAuth (book chapter 8).',
    fix: {
      snippet: 'POST /mcp\nContent-Type: application/json\nAccept: application/json, text/event-stream\nMCP-Protocol-Version: 2026-07-28\nMcp-Method: server/discover\n\n{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"test","version":"1"}}}}',
      prompt: 'Make the MCP endpoint answer a Streamable HTTP server/discover POST (MCP 2026-07-28; keep serving the 2025 initialize handshake for older clients) with a JSON-RPC result (or, when it needs OAuth, HTTP 401 with WWW-Authenticate: Bearer resource_metadata="<PRM URL>"). Test with the MCP Inspector: npx @modelcontextprotocol/inspector.',
    },
    async run(ctx) {
      const mcp = await mcpSignals(ctx);
      const init = mcp.init; const where = `${mcp.endpoint} (${mcp.endpointSource})`;
      const details = { endpoint: mcp.endpoint, source: mcp.endpointSource, status: init.ex.status };
      if (init.ok) {
        const si = init.result.serverInfo || {};
        return pass(`The MCP endpoint ${where} answered ${init.era === 'modern' ? 'server/discover (stateless MCP 2026-07-28)' : 'the 2025-era initialize handshake'}${si.name ? ` as "${si.name}"${si.version ? ` ${si.version}` : ''}` : ''}.`, { evidence: [init.ex], details: { ...details, era: init.era, serverInfo: si, protocolVersion: init.result.protocolVersion, supportedVersions: init.result.supportedVersions } });
      }
      if (init.authRequired) {
        if (/bearer/i.test(init.challenge || '') && /resource_metadata\s*=/.test(init.challenge || '')) return pass(`The MCP endpoint ${where} requires OAuth and answers 401 with a resource_metadata challenge, as the MCP authorization spec asks.`, { evidence: [init.ex], details: { ...details, challenge: init.challenge } });
        return warn(`The MCP endpoint ${where} answers 401 but ${init.challenge ? `its WWW-Authenticate (${init.challenge.slice(0, 80)}) has no resource_metadata` : 'without a WWW-Authenticate header'}, so clients cannot find how to authorize.`, { evidence: [init.ex], details: { ...details, challenge: init.challenge } });
      }
      return fail(`The MCP endpoint ${where} answered neither server/discover nor initialize: ${init.error}.`, { evidence: [init.ex], details });
    },
  },

  'mcp.protocol-version': {
    why: 'Older MCP protocol versions lack structured output, elicitation and the current authorization rules; clients negotiate down and lose features (book chapter 8).',
    fix: {
      snippet: '"protocolVersion": "2026-07-28"',
      prompt: 'Upgrade the MCP server SDK so the server supports the stateless 2026-07-28 revision (server/discover) and still serves 2025-11-25 clients, then re-test with the MCP Inspector.',
    },
    async run(ctx) {
      const mcp = await mcpSignals(ctx);
      if (mcp.init.authRequired) return skipped(`Protocol version unknown: ${authNote}.`, { evidence: [mcp.init.ex] });
      if (!mcp.init.ok) return neutral('No server/discover or initialize result to read a protocol version from (see mcp.endpoint).', { evidence: [mcp.init.ex] });
      const v = mcp.init.result.protocolVersion;
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return warn(`The server reported no usable protocol version (${JSON.stringify(v)}).`, { evidence: [mcp.init.ex] });
      if (v < OLDEST_CURRENT) return warn(`The server negotiated MCP ${v}, older than ${OLDEST_CURRENT}; current clients ask for 2026-07-28.`, { evidence: [mcp.init.ex], details: { protocolVersion: v } });
      return pass(`The server speaks MCP ${v}${mcp.init.result.supportedVersions?.length > 1 ? ` (supports ${mcp.init.result.supportedVersions.join(', ')})` : ''}.`, { evidence: [mcp.init.ex], details: { protocolVersion: v, supportedVersions: mcp.init.result.supportedVersions } });
    },
  },

  'mcp.tools-list': {
    why: 'tools/list is what an agent sees of your server: if it is empty or broken, nothing is callable (book chapter 8).',
    fix: {
      snippet: '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"search_items","description":"Search the catalogue","inputSchema":{"type":"object","properties":{"q":{"type":"string","description":"Search words"}}}}]}}',
      prompt: 'Register the site\'s main actions as MCP tools so tools/list returns them, each with a name, description and an inputSchema of type object.',
    },
    async run(ctx) {
      const mcp = await mcpSignals(ctx);
      if (mcp.init.authRequired) return skipped(`tools/list not run: ${authNote}.`, { evidence: [mcp.init.ex] });
      if (!mcp.init.ok) return neutral('No working MCP session to list tools from (see mcp.endpoint).', { evidence: [mcp.init.ex] });
      const t = await mcpTools(ctx);
      if (t.noToolsCapability) return info('The server does not declare the tools capability (it may offer only resources or prompts).', { evidence: [mcp.init.ex] });
      if (!t.tools) return fail(`tools/list failed: ${t.error}.`, { evidence: [t.ex] });
      if (!t.tools.length) return warn('tools/list returned an empty list.', { evidence: [t.ex] });
      const names = t.tools.map((x) => x?.name).filter(Boolean);
      return pass(`tools/list returned ${t.tools.length} tool(s)${t.nextCursor ? ' (first page)' : ''}: ${names.slice(0, 8).join(', ')}${names.length > 8 ? ', ...' : ''}.`, { evidence: [t.ex], details: { count: t.tools.length, names } });
    },
  },

  'mcp.tool-schemas': {
    why: 'Agents fill tool arguments from the inputSchema and choose tools by description. A missing or malformed schema means wrong calls (book chapter 10).',
    fix: {
      snippet: '"inputSchema": {\n  "type": "object",\n  "properties": { "check_in": { "type": "string", "format": "date", "description": "Arrival date, YYYY-MM-DD" } },\n  "required": ["check_in"]\n}',
      prompt: 'For every MCP tool: use a name of letters, digits, _ - . only; write a description of at least one sentence saying when to use it; give an inputSchema with "type": "object", a description on every property, and a required list that only names existing properties.',
    },
    async run(ctx) {
      const mcp = await mcpSignals(ctx);
      if (mcp.init.authRequired) return skipped(`Tool schemas not read: ${authNote}.`, { evidence: [mcp.init.ex] });
      const t = await mcpTools(ctx);
      if (!t.tools?.length) return neutral('No MCP tools to check (see mcp.tools-list).');
      const errors = []; const warnings = [];
      for (const tool of t.tools.slice(0, 100)) {
        const n = tool?.name || '(unnamed)';
        if (!TOOL_NAME_RE.test(tool?.name || '')) errors.push(`${n}: name breaks the MCP naming rule`);
        // checker heuristic: under 20 characters is rarely enough to choose a tool by
        if ((tool?.description || '').trim().length < 20) warnings.push(`${n}: description is missing or under 20 characters`);
        const l = lintSchema(tool?.inputSchema, { requireObject: true, path: `${n}.inputSchema` });
        errors.push(...l.errors); warnings.push(...l.warnings.map((x) => `${n}: ${x}`));
        if (tool?.outputSchema !== undefined) { const o = lintSchema(tool.outputSchema, { requireObject: true, path: `${n}.outputSchema` }); errors.push(...o.errors); }
      }
      const details = { tools: t.tools.length, errors: errors.slice(0, 30), warnings: warnings.slice(0, 30), heuristic: 'description length threshold (20 characters) is a checker heuristic' };
      if (errors.length) return fail(`${errors.length} schema/name error(s) across ${t.tools.length} tool(s), e.g. ${errors[0]}.`, { evidence: [t.ex], details });
      if (warnings.length) return warn(`All ${t.tools.length} tool schemas are well-formed, with ${warnings.length} description gap(s), e.g. ${warnings[0]}.`, { evidence: [t.ex], details });
      return pass(`All ${t.tools.length} tools have valid names, descriptions and object inputSchemas with described properties.`, { evidence: [t.ex], details });
    },
  },

  'mcp.origin-validation': {
    why: 'The MCP Streamable HTTP transport says servers MUST validate the Origin header, so a web page cannot use the visitor\'s browser to talk to the server (DNS rebinding). Public servers often accept any origin on purpose (book chapter 16).',
    fix: {
      snippet: 'if (req.headers.origin && !ALLOWED_ORIGINS.has(req.headers.origin)) return new Response(null, { status: 403 });',
      prompt: 'In the MCP endpoint handler, reject requests whose Origin header is present and not on an allowlist with HTTP 403, and never answer Access-Control-Allow-Origin with a reflected origin together with Access-Control-Allow-Credentials: true.',
    },
    async run(ctx) {
      const mcp = await mcpSignals(ctx);
      if (!mcp.init.ok && !mcp.init.authRequired) return neutral('No live MCP endpoint to test (see mcp.endpoint).');
      const evil = await mcpInitialize(ctx, mcp.endpoint, { origin: 'https://evil.example' });
      const ex = evil.ex; const details = { endpoint: mcp.endpoint, status: ex.status, acao: ex.headers['access-control-allow-origin'] || null };
      if (ex.status === 403 || ex.status === 400) return pass(`The MCP endpoint rejects a foreign Origin (https://evil.example) with HTTP ${ex.status}.`, { evidence: [ex], details });
      if (evil.authRequired) return info('The endpoint answered 401 to a foreign Origin before any origin check could show; we cannot tell whether it validates Origin.', { evidence: [ex], details });
      const reflects = ex.headers['access-control-allow-origin'] === 'https://evil.example' && /true/i.test(ex.headers['access-control-allow-credentials'] || '');
      if (reflects) return fail('The MCP endpoint reflects a foreign Origin in Access-Control-Allow-Origin with credentials allowed, so any web page can drive it with the visitor\'s cookies.', { evidence: [ex], details });
      if (evil.ok) return warn('The MCP endpoint answers a foreign Origin (https://evil.example). The transport spec says servers MUST validate Origin; for a public, unauthenticated server this may be deliberate.', { evidence: [ex], details });
      return info(`A foreign-Origin initialize got HTTP ${ex.status} (${evil.error}); no clear origin policy seen.`, { evidence: [ex], details });
    },
  },
};
