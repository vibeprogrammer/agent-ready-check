// Stateless Streamable HTTP MCP server, hand-written JSON-RPC (no SDK) so it runs in Node and Workers.
// Protocol 2026-07-28 (server/discover, no sessions, Mcp-Method/Mcp-Name headers) and the 2025-11-25 /
// 2025-06-18 initialize handshake. JSON responses only, no SSE stream, no sessions.
// Origin validation (MCP transport spec: servers MUST validate Origin to stop DNS rebinding):
// requests without Origin (CLI and server-side clients) and same-origin requests are allowed; any other
// browser origin gets 403.
import { CHECKS, LAYERS, catalog } from '../checks/index.mjs';
import { SITE, MCP_PROTOCOLS } from '../agent-files/site.mjs';

export const PROTOCOLS = MCP_PROTOCOLS;
export const LATEST = PROTOCOLS[0];

const SERVER_INFO = { name: SITE.slug, title: SITE.name, version: SITE.version };
const INSTRUCTIONS = `${SITE.name} scans a public website for agent-readiness (${SITE.checksCount} checks in ${SITE.layersCount} layers, based on the book "${SITE.book}" by ${SITE.author}). `
  + 'Use scan_site with a URL the user asked about; a scan takes about 10 to 60 seconds and repeated scans of the same URL are served from a 10-minute cache. '
  + 'Use explain_check for any check id in a report, list_checks to browse the catalogue, and get_report to reopen a stored report by id. '
  + 'When you present results, quote the evidence and say when a standard is only a draft or a proposal.';

const LAYER_IDS = LAYERS.map((l) => l.id);
const STATUS_ENUM = ['pass', 'warn', 'fail', 'info', 'neutral', 'skipped', 'error'];

export const TOOLS = [
  {
    name: 'scan_site',
    title: 'Scan a website for agent-readiness',
    description: `Scans one public URL with ${SITE.checksCount} checks across ${SITE.layersCount} layers (perception, crawler access, structured data, Markdown and llms.txt, APIs, MCP, WebMCP, discovery, commerce, identity, security, privacy, performance). Returns the overall score (0-100), the isitagentready-compatible level (0-5), layer scores, the most important fixes and a shareable report URL; the full report is in structuredContent. Takes 10-60 seconds. Private and local addresses are refused.`,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The page to scan, for example https://example.com. https:// is added when the scheme is missing.', maxLength: 2048 },
        browser: { type: 'boolean', description: 'Also run the checks that need a real browser (accessibility tree, axe rules, WebMCP tools, CLS, consent overlays) when this deployment has one. Default false.', default: false },
      },
      required: ['url'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL that was scanned.' },
        report_url: { type: 'string', description: 'Shareable HTML report, kept 30 days.' },
        id: { type: 'string', description: 'Report id for get_report.' },
        score: { type: 'integer', description: 'Overall Agent-Ready score, 0-100.' },
        compat: { type: 'object', description: 'isitagentready-compatible level and Lighthouse Agentic view.' },
        layers: { type: 'array', description: 'Score per layer.', items: { type: 'object' } },
        checks: { type: 'array', description: 'Every check with status, message, standard and fix.', items: { type: 'object' } },
      },
      required: ['url', 'score', 'layers', 'checks'],
    },
    annotations: { title: 'Scan a website', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'list_checks',
    title: 'List the checks',
    description: 'Lists the checks in the catalogue with id, layer, title, severity, the standard behind it and its status (RFC, W3C Recommendation, draft, proposal), and the isitagentready or Lighthouse check it mirrors. Optionally for one layer.',
    inputSchema: {
      type: 'object',
      properties: { layer: { type: 'string', enum: LAYER_IDS, description: 'Only the checks of this layer.' } },
      additionalProperties: false,
    },
    annotations: { title: 'List checks', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'explain_check',
    title: 'Explain a check',
    description: 'Explains one check by id: what it tests, the standard and its status, why it matters for agents (with the book chapter), a copy-paste fix and a fix prompt for a coding agent.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Check id, for example content.markdown-negotiation.', pattern: '^[a-z0-9]+\\.[a-z0-9-]+$' } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { title: 'Explain a check', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'get_report',
    title: 'Get a stored report',
    description: 'Returns a report saved by an earlier scan (reports are kept 30 days) by its id: the summary as text and the full report as structuredContent.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Report id from scan_site (or the last part of a report URL).', pattern: '^[a-z0-9]{6,32}$' } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { title: 'Get a report', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

/** The compact text an agent reads first. */
export function summarize(report) {
  const iia = report.compat?.isitagentready;
  const lines = [
    `Agent-Ready score for ${report.final_url || report.url}: ${report.score}/100.`,
    iia ? `isitagentready-compatible level: ${iia.level} (${iia.level_name})${iia.next_level ? `; next level ${iia.next_level.target} needs ${iia.next_level.requirements.join(', ')}` : ''}.` : null,
    report.compat?.lighthouse_agentic?.score != null ? `Lighthouse Agentic Browsing view: ${Math.round(report.compat.lighthouse_agentic.score * 100)}/100.` : null,
    `Layers: ${(report.layers || []).map((l) => `${l.name} ${l.applicable ? l.score : 'n/a'}`).join(', ')}.`,
  ].filter(Boolean);
  const todo = (report.checks || []).filter((c) => c.status === 'fail' || c.status === 'warn').sort((a, b) => (b.weight || 0) - (a.weight || 0) || (a.status === 'fail' ? -1 : 1)).slice(0, 10);
  if (todo.length) {
    lines.push('', 'Top fixes:');
    for (const c of todo) lines.push(`- [${c.status}] ${c.id}: ${c.message}${c.standard?.status ? ` (${c.standard.status})` : ''}`);
  }
  if (report.mode && !report.mode.browser) lines.push('', 'Browser checks were skipped (no browser in this run).');
  if (report.report_url) lines.push('', `Full report: ${report.report_url}`);
  return lines.join('\n');
}

/** The report for structuredContent: everything except the raw HTTP exchanges (they stay at report_url). */
export function structured(report) {
  const { exchanges, ...rest } = report;
  return { ...rest, exchanges_omitted: exchanges ? Object.keys(exchanges).length : 0 };
}

export function checkInfo(id) {
  const c = CHECKS.find((x) => x.id === id);
  if (!c) return null;
  return {
    id: c.id, layer: c.layer, title: c.title, severity: c.severity,
    standard: { key: c.standard, ...(c.standardInfo || {}) }, chapter: c.chapter, test: c.test,
    iia: c.iia, lh: c.lh, roles: String(c.roles || '').split(',').filter(Boolean), requires: c.requires, applies: c.applies, heuristic: !!c.heuristic,
    why: c.impl?.why || null, fix: { snippet: c.impl?.fix?.snippet || null, prompt: c.impl?.fix?.prompt || null },
    implemented: !!c.impl,
  };
}

export function listChecks(layer) {
  return CHECKS.filter((c) => !layer || c.layer === layer).map((c) => ({ id: c.id, layer: c.layer, title: c.title, severity: c.severity, standard: c.standardInfo?.name || c.standard, status: c.standardInfo?.status || null, maturity: c.standardInfo?.maturity || null, iia: c.iia, lh: c.lh, requires: c.requires }));
}

class RpcError extends Error {
  constructor(code, message, data) { super(message); this.code = code; this.data = data; }
}

const jsonResponse = (body, status = 200, headers = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: body === null ? headers : { 'content-type': 'application/json', ...headers } });

/**
 * @param {object} o
 * @param {(url:string, opts:{browser:boolean})=>Promise<object>} o.scan  returns a stored report (with id, report_url); throws Error with .status on refusal
 * @param {(id:string)=>Promise<object|null>} o.getReport
 * @param {string[]} [o.allowedOrigins]  extra browser origins allowed besides the request's own origin
 * @returns {(request: Request) => Promise<Response>}
 */
export function createMcpHandler({ scan, getReport, allowedOrigins = [] }) {
  async function callTool(name, args = {}) {
    const text = (t, extra = {}) => ({ content: [{ type: 'text', text: t }], ...extra });
    const err = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
    if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new RpcError(-32602, 'arguments must be an object');
    switch (name) {
      case 'scan_site': {
        if (typeof args.url !== 'string' || !args.url.trim()) return err('url is required, for example "https://example.com".');
        try {
          const report = await scan(args.url, { browser: !!args.browser });
          return text(summarize(report), { structuredContent: structured(report) });
        } catch (e) {
          return err(`Scan refused or failed: ${e?.message || e}${e?.retryAfter ? ` Retry after ${e.retryAfter} seconds.` : ''}`);
        }
      }
      case 'list_checks': {
        if (args.layer !== undefined && !LAYER_IDS.includes(args.layer)) return err(`Unknown layer "${args.layer}". Layers: ${LAYER_IDS.join(', ')}.`);
        const checks = listChecks(args.layer);
        const t = [`${checks.length} checks${args.layer ? ` in layer ${args.layer}` : ''} (standards read ${catalog.checked}):`, ...checks.map((c) => `- ${c.id} [severity ${c.severity}; ${c.standard}, ${c.status}]${c.iia ? ` isitagentready ${c.iia}` : ''}${c.lh ? ` Lighthouse ${c.lh}` : ''}: ${c.title}`)].join('\n');
        return text(t, { structuredContent: { count: checks.length, layers: LAYERS, checks } });
      }
      case 'explain_check': {
        const info = checkInfo(String(args.id || ''));
        if (!info) return err(`Unknown check id "${args.id}". Use list_checks to see the ids.`);
        const t = [
          `${info.id}: ${info.title}`,
          `Layer ${info.layer}, severity ${info.severity}. Standard: ${info.standard.name || info.standard.key} (${info.standard.status || 'status unknown'}${info.standard.date ? `, ${info.standard.date}` : ''})${info.standard.url ? ` ${info.standard.url}` : ''}.`,
          `How it is tested: ${info.test}`,
          info.iia ? `Mirrors isitagentready check ${info.iia}.` : null,
          info.lh ? `Mirrors Lighthouse audit ${info.lh}.` : null,
          info.heuristic ? 'The threshold is this checker\'s heuristic, not a standard\'s rule.' : null,
          info.why ? `Why it matters: ${info.why}` : null,
          info.chapter ? `Book chapter: ${info.chapter} of "${SITE.book}".` : null,
          info.fix.snippet ? `Fix:\n${info.fix.snippet}` : null,
          info.fix.prompt ? `Fix prompt for a coding agent:\n${info.fix.prompt}` : null,
        ].filter(Boolean).join('\n');
        return text(t, { structuredContent: info });
      }
      case 'get_report': {
        const report = /^[a-z0-9]{6,32}$/.test(String(args.id || '')) ? await getReport(args.id) : null;
        if (!report) return err(`No stored report with id "${args.id}" (reports are kept 30 days).`);
        return text(summarize(report), { structuredContent: structured(report) });
      }
      default:
        throw new RpcError(-32602, `Unknown tool: ${name}`);
    }
  }

  async function dispatch(msg, era) {
    const p = msg.params || {};
    const cache = era === LATEST ? { ttlMs: 0, cacheScope: 'private' } : {};
    switch (msg.method) {
      case 'initialize': {
        const asked = p.protocolVersion;
        return { protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[1], capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS };
      }
      case 'server/discover':
        return { supportedVersions: [...PROTOCOLS], capabilities: { tools: { listChanged: false } }, instructions: INSTRUCTIONS, resultType: 'complete', ttlMs: 0, cacheScope: 'private', _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO } };
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: TOOLS, ...(era === LATEST ? { resultType: 'complete', ttlMs: 3_600_000, cacheScope: 'public' } : {}) };
      case 'tools/call': {
        if (typeof p.name !== 'string') throw new RpcError(-32602, 'params.name is required');
        const r = await callTool(p.name, p.arguments ?? {});
        return era === LATEST ? { resultType: 'complete', ...r } : r;
      }
      case 'resources/list': return { resources: [], ...cache };
      case 'prompts/list': return { prompts: [], ...cache };
      default:
        throw new RpcError(-32601, `Method not found: ${msg.method}`);
    }
  }

  return async function handle(request) {
    const url = new URL(request.url);
    const origin = request.headers.get('origin');
    if (origin !== null && origin !== url.origin && !allowedOrigins.includes(origin)) {
      return jsonResponse({ jsonrpc: '2.0', id: null, error: { code: -32000, message: `Forbidden: Origin ${origin} is not allowed to call this MCP server.` } }, 403);
    }
    if (request.method === 'GET' || request.method === 'DELETE') {
      return jsonResponse({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed: this stateless server answers POST only (no SSE stream, no sessions).' } }, 405, { allow: 'POST, OPTIONS' });
    }
    if (request.method !== 'POST') return jsonResponse({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed.' } }, 405, { allow: 'POST, OPTIONS' });

    const hdrVersion = request.headers.get('mcp-protocol-version');
    if (hdrVersion && !PROTOCOLS.includes(hdrVersion)) {
      return jsonResponse({ jsonrpc: '2.0', id: null, error: { code: -32600, message: `Unsupported MCP-Protocol-Version ${hdrVersion}. Supported: ${PROTOCOLS.join(', ')}.` } }, 400);
    }
    let msg;
    try {
      const raw = await request.text();
      if (raw.length > 65_536) return jsonResponse({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large.' } }, 413);
      msg = JSON.parse(raw);
    } catch {
      return jsonResponse({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: the body is not JSON.' } }, 400);
    }
    if (Array.isArray(msg)) return jsonResponse({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batch requests are not supported.' } }, 400);
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      // A response or an invalid object. Responses from the client need no answer.
      if (msg && msg.jsonrpc === '2.0' && ('result' in msg || 'error' in msg)) return new Response(null, { status: 202 });
      return jsonResponse({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid request.' } }, 400);
    }
    if (msg.id === undefined || msg.id === null) return new Response(null, { status: 202 }); // notification

    const metaVersion = msg.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
    const era = metaVersion === LATEST || (hdrVersion === LATEST && msg.method !== 'initialize') ? LATEST : (hdrVersion || PROTOCOLS[1]);
    // 2026-07-28 routing headers must agree with the body (a WAF may filter on them).
    const hMethod = request.headers.get('mcp-method');
    const hName = request.headers.get('mcp-name');
    if ((hMethod && hMethod !== msg.method) || (hName && msg.method === 'tools/call' && hName !== msg.params?.name)) {
      return jsonResponse({ jsonrpc: '2.0', id: msg.id, error: { code: -32020, message: 'the request headers and body disagree' } }, 400);
    }
    try {
      const result = await dispatch(msg, era);
      return jsonResponse({ jsonrpc: '2.0', id: msg.id, result });
    } catch (e) {
      const code = e instanceof RpcError ? e.code : -32603;
      return jsonResponse({ jsonrpc: '2.0', id: msg.id, error: { code, message: e instanceof RpcError ? e.message : `Internal error: ${e?.message || e}`, ...(e?.data ? { data: e.data } : {}) } });
    }
  };
}

export const STATUS_VALUES = STATUS_ENUM;
