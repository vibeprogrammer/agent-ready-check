// Checks for the security layer. Ids and metadata: src/catalog.json. Owner: H2.
// Hidden-text and injection logic adapted from agent-ready-web-demos (MIT, Maxim Salnikov),
// chapters/16-security-for-agent-facing-sites/scan-page.mjs and nordlys-cabins/layers/16-security/untrusted.js.
import { pass, warn, fail, neutral } from '../core/result.mjs';
import { findInjections } from '../core/patterns.mjs';
import { describe } from '../core/html.mjs';
import { mcpTools, webmcpSignals } from '../core/discover.mjs';

const HIDE_CLASSES = new Set(['sr-only', 'visually-hidden', 'visuallyhidden', 'screen-reader-text', 'screen-reader-only', 'd-none', 'hidden', 'invisible', 'offscreen', 'off-screen', 'hide', 'is-hidden', 'u-hidden', 'a11y-hidden', 'element-invisible']);
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'SVG', 'HEAD']);

/** Why an inline style hides an element, or null. */
export function hiddenByStyle(style) {
  const s = String(style || '').toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  if (/display:none/.test(s)) return 'display-none';
  if (/visibility:(hidden|collapse)/.test(s)) return 'visibility';
  if (/(^|;)opacity:0(\.0+)?(;|$|!)/.test(s)) return 'transparent';
  if (/font-size:0(px|em|rem|%)?(;|$|!)/.test(s)) return 'zero-size';
  if (/(left|top|right|bottom|text-indent|margin-left|margin-top):-\d{3,}(px|em|rem)/.test(s)) return 'offscreen';
  if (/clip:rect\(0(px)?,?0(px)?,?0(px)?,?0(px)?\)|clip-path:inset\(50%\)/.test(s)) return 'clip';
  if (/(^|;)(width|height):0(px)?(;|$)/.test(s) && /overflow:hidden/.test(s)) return 'zero-size';
  const color = /(^|;)color:([^;!]+)/.exec(s)?.[2]; const bg = /background(-color)?:([^;!]+)/.exec(s)?.[2];
  if (color && bg && color === bg) return 'same-colour';
  if (color === 'transparent') return 'transparent';
  return null;
}

/** Class names that <style> blocks hide (display:none etc.), plus the common utility names. */
function hidingClasses(doc) {
  const out = new Set(HIDE_CLASSES);
  for (const st of doc.querySelectorAll('style')) {
    const css = st.textContent || '';
    for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (!hiddenByStyle(m[2])) continue;
      for (const sel of m[1].split(',')) { const c = /^\s*\.([\w-]+)\s*$/.exec(sel); if (c) out.add(c[1]); }
    }
  }
  return out;
}

/** Static hidden-text inventory of a document: [{ selector, method, text }] (outermost hidden element only). */
export function staticHiddenText(doc) {
  const items = [];
  if (!doc?.documentElement) return items;
  const classes = hidingClasses(doc);
  const walk = (el) => {
    for (const n of el.childNodes || []) {
      if (n.nodeType === 8) { const t = (n.textContent || '').trim(); if (t) items.push({ selector: 'HTML comment', method: 'comment', text: t.slice(0, 500) }); continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName?.toUpperCase();
      if (SKIP_TAGS.has(tag)) continue;
      let method = null;
      if (n.hasAttribute('hidden')) method = 'hidden-attribute';
      else if (n.getAttribute('aria-hidden') === 'true') method = 'aria-hidden';
      else method = hiddenByStyle(n.getAttribute('style'));
      if (!method) { const cls = (n.getAttribute('class') || '').split(/\s+/).find((c) => classes.has(c)); if (cls) method = `class .${cls}`; }
      if (method) { const t = (n.textContent || '').replace(/\s+/g, ' ').trim(); if (t) items.push({ selector: describe(n), method, text: t.slice(0, 500) }); continue; }
      if (tag === 'IMG' && n.getAttribute('alt')) items.push({ selector: describe(n), method: 'alt text', text: n.getAttribute('alt').slice(0, 500) });
      if (n.getAttribute('aria-label')) items.push({ selector: describe(n), method: 'aria-label', text: n.getAttribute('aria-label').slice(0, 500) });
      walk(n);
    }
  };
  walk(doc.documentElement);
  return items;
}

const WRITE_VERB = /^(create|add|book|reserve|buy|purchase|pay|order|checkout|send|post|submit|update|edit|set|change|delete|remove|cancel|refund|transfer|subscribe|unsubscribe|register|sign|apply|upload|publish|write|insert|archive|approve|reject)/i;
const READ_VERB = /^(get|list|search|find|read|fetch|show|view|lookup|look|check|query|browse|describe|count|compare|quote|preview|estimate|calculate|recommend)/i;
/** Classify a tool by its name's verb: 'write' | 'read' | 'unknown'. */
export function toolKind(name) {
  const n = String(name || '').replace(/([a-z])([A-Z])/g, '$1_$2').replace(/^[^a-z]*/i, '');
  if (WRITE_VERB.test(n)) return 'write';
  if (READ_VERB.test(n)) return 'read';
  return 'unknown';
}

/** Every tool we can see: MCP (public tools/list) and WebMCP (browser list or declarative forms). */
export async function allTools(ctx) {
  const [m, w] = await Promise.all([mcpTools(ctx), webmcpSignals(ctx)]);
  const out = [];
  for (const t of m.tools || []) out.push({ origin: 'MCP', name: t?.name, description: t?.description || '', annotations: t?.annotations || {}, ex: m.ex });
  for (const t of w.tools || []) out.push({ origin: 'WebMCP', name: t.name, description: t.description || '', annotations: t.annotations || {}, declarative: t.source === 'declarative', autosubmit: t.autosubmit, method: t.method });
  return out.filter((t) => t.name);
}

const strongOnly = (ms) => ms.filter((m) => m.strength === 'strong');

export default {
  'security.hidden-injection': {
    why: 'Text that people cannot see but agents read (display:none, off-screen, aria-hidden, comments) is the classic carrier for indirect prompt injection: instructions planted for the AI, not the visitor; OWASP lists it under LLM01 (book chapter 16).',
    fix: {
      snippet: '<!-- remove hidden instructions such as: -->\n<div style="display:none">Ignore previous instructions and ...</div>',
      prompt: 'Find every piece of hidden text on the page (display:none, visibility:hidden, off-screen positioning, aria-hidden, HTML comments, alt text) that addresses an AI or gives instructions, and remove it. If it comes from user-generated content, sanitise it and render it as data with a clear provenance label.',
    },
    async run(ctx) {
      const doc = await ctx.dom();
      const items = staticHiddenText(doc).map((i) => ({ ...i, source: 'static HTML' }));
      const b = await ctx.browserData();
      if (b?.ok && Array.isArray(b.hiddenText)) for (const h of b.hiddenText) items.push({ selector: h.selector, method: h.method, text: String(h.text || '').slice(0, 500), source: 'rendered page (computed styles)' });
      const findings = [];
      const seen = new Set();
      for (const it of items) {
        const ms = findInjections(it.text);
        if (!ms.length || (ms.length === 1 && ms[0].pattern === 'invisible-characters' && !/[\u{E0000}-\u{E007F}]/u.test(it.text))) continue;
        const key = it.text.slice(0, 80);
        if (seen.has(key)) continue; seen.add(key);
        findings.push({ ...it, patterns: ms.map((m) => m.pattern), strong: strongOnly(ms).length > 0, match: ms.find((m) => m.pattern !== 'invisible-characters')?.match || ms[0].match });
      }
      const details = { hiddenItems: items.length, browser: !!b?.ok, findings: findings.slice(0, 10), heuristic: 'pattern list in src/core/patterns.mjs; a match is a hint for review, not proof' };
      const home = await ctx.home();
      const strong = findings.filter((f) => f.strong);
      if (strong.length) return fail(`${strong.length} hidden text block(s) read like instructions to an AI, e.g. ${strong[0].selector} (${strong[0].method}): "${strong[0].match}".`, { evidence: [home], details });
      if (findings.length) return warn(`${findings.length} hidden text block(s) address AI readers, e.g. ${findings[0].selector} (${findings[0].method}): "${findings[0].match}". Review whether they are legitimate guidance.`, { evidence: [home], details });
      return pass(`None of the ${items.length} hidden text item(s) found${b?.ok ? ' (static and rendered)' : ' in the server HTML'} reads like a prompt injection.`, { evidence: [home], details });
    },
  },

  'security.injection-in-machine-files': {
    why: 'llms.txt, Markdown twins, JSON-LD, meta tags and tool descriptions are read by models directly. Instructions planted there (or copied in from user content) reach every agent that reads them (book chapter 16).',
    fix: {
      snippet: '# llms.txt: describe, do not command\n> Example Shop sells outdoor gear. The product API is at /api/v1 (OpenAPI: /openapi.json).',
      prompt: 'Remove any text in llms.txt, the Markdown version of pages, JSON-LD, meta tags and MCP/WebMCP tool descriptions that tries to instruct the model (override instructions, role markers, requests for secrets). Keep these files descriptive, and keep user-generated text out of them or clearly labelled as untrusted.',
    },
    async run(ctx) {
      const [llms, md] = await Promise.all([
        ctx.fetch('/llms.txt', { accept: 'text/markdown, text/plain;q=0.9, */*;q=0.5', maxBytes: 1_048_576, purpose: 'llms.txt' }),
        ctx.fetch(ctx.url.href, { accept: 'text/markdown', maxBytes: 1_048_576, purpose: 'Markdown negotiation' }),
      ]);
      const sources = [];
      const isText = (ex) => ex.ok && !/html/.test(ex.contentType) && !/^\s*<(!doctype|html)/i.test(ex.text);
      if (isText(llms)) sources.push({ where: 'llms.txt', text: llms.text, ex: llms });
      if (isText(md) && /markdown|text\/plain/.test(md.contentType)) sources.push({ where: 'Markdown version of the page', text: md.text, ex: md });
      const strings = (v, out = [], d = 0) => { if (d > 8 || out.length > 500) return out; if (typeof v === 'string') out.push(v); else if (Array.isArray(v)) v.forEach((x) => strings(x, out, d + 1)); else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out, d + 1)); return out; };
      for (const b of await ctx.jsonld()) if (b.data) sources.push({ where: `JSON-LD block ${b.index + 1}`, text: strings(b.data).join('\n') });
      const doc = await ctx.dom();
      const metas = [...doc.querySelectorAll('meta[content]')].filter((m) => /description|keywords|^og:|^twitter:|robots|ai|llm/i.test(m.getAttribute('name') || m.getAttribute('property') || '')).map((m) => m.getAttribute('content'));
      if (metas.length) sources.push({ where: 'meta tags', text: metas.join('\n') });
      for (const t of await allTools(ctx)) sources.push({ where: `${t.origin} tool ${t.name} description`, text: t.description, ex: t.ex });
      const findings = []; const weak = [];
      for (const s of sources) {
        const ms = findInjections(s.text);
        const st = strongOnly(ms);
        if (st.length) findings.push({ where: s.where, patterns: st.map((m) => m.pattern), match: st[0].match });
        else if (ms.some((m) => m.strength === 'weak')) weak.push({ where: s.where, match: ms.find((m) => m.strength === 'weak').match });
      }
      const evidence = sources.map((s) => s.ex).filter(Boolean);
      const details = { scanned: sources.map((s) => s.where), findings, weakMatches: weak.slice(0, 10), heuristic: 'pattern list in src/core/patterns.mjs; weak patterns (e.g. "agents should use the API") are often legitimate guidance and do not count' };
      if (!sources.length) return neutral('No machine-readable files (llms.txt, Markdown, JSON-LD, meta, tool descriptions) were found to scan.', { evidence: [llms, md], details });
      if (findings.length) return fail(`${findings.length} machine-readable source(s) contain instruction-like text, e.g. ${findings[0].where}: "${findings[0].match}".`, { evidence, details });
      return pass(`Scanned ${sources.length} machine-readable source(s) (${sources.slice(0, 4).map((s) => s.where).join(', ')}${sources.length > 4 ? ', ...' : ''}); none carries instructions aimed at models${weak.length ? ` (${weak.length} benign mention(s) of agents noted)` : ''}.`, { evidence, details });
    },
  },

  'security.tool-annotations': {
    why: 'Agents decide whether to ask the person before calling a tool from its annotations. A booking or delete tool that claims to be read-only, or a read tool that is not marked, leads to unsafe or needlessly nagging agents (book chapters 9 and 16).',
    fix: {
      snippet: '// MCP\n{ name: "cancel_booking", annotations: { readOnlyHint: false, destructiveHint: true } }\n// WebMCP\nnavigator.modelContext.registerTool({ name: "book_cabin", annotations: { consequentialHint: true }, ... })\nnavigator.modelContext.registerTool({ name: "search_cabins", annotations: { readOnlyHint: true }, ... })',
      prompt: 'Review every MCP and WebMCP tool: set readOnlyHint: true on tools that only read; never set it on tools that create, change, pay or delete; mark irreversible MCP tools destructiveHint: true and significant WebMCP actions consequentialHint: true. Enforce the same rules on the server; annotations are hints.',
    },
    async run(ctx) {
      const tools = await allTools(ctx);
      if (!tools.length) return neutral('No MCP or WebMCP tools were found to check.');
      const bad = []; const gaps = [];
      for (const t of tools) {
        const a = t.annotations || {}; const kind = toolKind(t.name);
        if (kind === 'write' && a.readOnlyHint === true) bad.push(`${t.origin} ${t.name} changes things but is marked readOnlyHint`);
        if (t.declarative) { if (kind === 'write' && t.method === 'get') gaps.push(`declarative ${t.name} looks like a write action but submits with GET`); continue; }
        if (kind === 'read' && a.readOnlyHint !== true) gaps.push(`${t.origin} ${t.name} looks read-only but has no readOnlyHint`);
        if (kind === 'write' && t.origin === 'MCP' && a.destructiveHint === false && /^(delete|remove|cancel|refund|archive)/i.test(t.name)) gaps.push(`MCP ${t.name} is marked destructiveHint: false`);
        if (kind === 'write' && t.origin === 'WebMCP' && a.consequentialHint !== true && /^(book|reserve|buy|purchase|pay|order|checkout|delete|cancel|transfer|send)/i.test(t.name)) gaps.push(`WebMCP ${t.name} has no consequentialHint`);
      }
      const details = { tools: tools.map((t) => ({ origin: t.origin, name: t.name, kind: toolKind(t.name), annotations: t.annotations })), problems: bad, gaps, heuristic: 'read/write is inferred from the tool name\'s verb' };
      const ev = tools.map((t) => t.ex).filter(Boolean).slice(0, 1);
      if (bad.length) return fail(`${bad.length} tool(s) are mislabelled as read-only: ${bad.slice(0, 2).join('; ')}.`, { evidence: ev, details });
      if (gaps.length) return warn(`${gaps.length} annotation gap(s) across ${tools.length} tool(s): ${gaps.slice(0, 2).join('; ')}.`, { evidence: ev, details });
      return pass(`All ${tools.length} tool(s) carry annotations consistent with what they do.`, { evidence: ev, details });
    },
  },

  'security.https': {
    why: 'Agents carry people\'s tokens and data. Plain HTTP lets anyone on the path read or rewrite pages and tool answers; HSTS stops the downgrade (book chapter 16).',
    fix: { snippet: 'Strict-Transport-Security: max-age=31536000; includeSubDomains', prompt: 'Redirect every http:// request to https:// with a 301 or 308, and send Strict-Transport-Security: max-age=31536000 (one year) or longer on HTTPS responses.' },
    async run(ctx) {
      const home = await ctx.home();
      const httpUrl = `http://${ctx.url.host}/`;
      const plain = await ctx.fetch(httpUrl, { accept: 'text/html', follow: false, maxBytes: 16_384, purpose: 'http to https redirect' });
      const finalHttps = /^https:/.test(home.finalUrl || ctx.url.href);
      const loc = plain.headers.location || '';
      const redirects = [301, 302, 303, 307, 308].includes(plain.status) && /^https:\/\//i.test(new URL(loc || '/', httpUrl).href);
      const hsts = home.headers['strict-transport-security'] || '';
      const maxAge = Number(/max-age\s*=\s*"?(\d+)/i.exec(hsts)?.[1] || 0);
      const details = { httpStatus: plain.status || null, httpError: plain.error, location: loc || null, hsts: hsts || null, maxAge, finalHttps };
      const evidence = [plain, home];
      if (!finalHttps) return fail('The page is served over plain HTTP.', { evidence, details });
      const problems = [];
      if (!plain.error && !redirects) problems.push(plain.ok ? 'http:// serves the page instead of redirecting to https://' : `http:// answers ${plain.status} without redirecting to https://`);
      if (!hsts) problems.push('no Strict-Transport-Security header');
      else if (maxAge < 31_536_000) problems.push(`HSTS max-age is ${maxAge} s, under one year (31536000 s)`);
      if (problems.length) return (plain.ok && !redirects ? fail : warn)(`HTTPS works, but ${problems.join('; ')}.`, { evidence, details });
      return pass(`http:// redirects to https:// (${plain.status || 'port 80 closed'}) and HSTS max-age is ${Math.round(maxAge / 86400)} days.`, { evidence, details });
    },
  },

  'security.headers': {
    why: 'A Content-Security-Policy limits what injected scripts can do, nosniff stops content-type confusion, and frame-ancestors stops clickjacking of the pages agents and people act on (book chapter 16).',
    fix: { snippet: "Content-Security-Policy: default-src 'self'; frame-ancestors 'self'\nX-Content-Type-Options: nosniff", prompt: "Send Content-Security-Policy (at least default-src 'self' and frame-ancestors 'self', tightened for your scripts), X-Content-Type-Options: nosniff, and frame-ancestors (or X-Frame-Options: SAMEORIGIN) on HTML responses." },
    async run(ctx) {
      const home = await ctx.home();
      if (home.error) return neutral(`The page could not be fetched: ${home.error}.`, { evidence: [home] });
      const h = home.headers;
      const csp = h['content-security-policy'] || ''; const cspRo = h['content-security-policy-report-only'] || '';
      const have = { csp: !!csp, nosniff: /nosniff/i.test(h['x-content-type-options'] || ''), framing: /frame-ancestors/i.test(csp) || /^(deny|sameorigin)$/i.test((h['x-frame-options'] || '').trim()) };
      const missing = [!have.csp && (cspRo ? 'Content-Security-Policy (only Report-Only is set)' : 'Content-Security-Policy'), !have.nosniff && 'X-Content-Type-Options: nosniff', !have.framing && 'frame-ancestors / X-Frame-Options'].filter(Boolean);
      const details = { ...have, cspReportOnly: !!cspRo, missing };
      if (!missing.length) return pass('The page sends a Content-Security-Policy, nosniff and a framing policy.', { evidence: [home], details });
      if (missing.length === 3) return fail('The page sends none of the baseline security headers (CSP, nosniff, framing policy).', { evidence: [home], details });
      return warn(`The page is missing ${missing.join(' and ')}.`, { evidence: [home], details });
    },
  },

  'security.security-txt': {
    why: 'security.txt (RFC 9116) tells researchers, and the agents that report problems for them, how to reach you about a vulnerability, for example a prompt-injection hole in your tools (book chapter 16).',
    fix: { snippet: 'Contact: mailto:security@example.com\nExpires: 2027-11-01T00:00:00.000Z\nPreferred-Languages: en\nCanonical: https://example.com/.well-known/security.txt', prompt: 'Serve /.well-known/security.txt as text/plain with a Contact line (mailto: or https:) and an Expires date less than a year ahead, per RFC 9116; set a reminder to renew Expires.' },
    async run(ctx) {
      let ex = await ctx.fetch('/.well-known/security.txt', { accept: 'text/plain', maxBytes: 65_536, purpose: 'security.txt' });
      let legacy = false;
      const ok = (e) => e.ok && !/html/.test(e.contentType) && !/^\s*<(!doctype|html)/i.test(e.text);
      if (!ok(ex)) { const l = await ctx.fetch('/security.txt', { accept: 'text/plain', maxBytes: 65_536, purpose: 'security.txt (legacy location)' }); if (ok(l)) { ex = l; legacy = true; } }
      if (!ok(ex)) return fail('No security.txt at /.well-known/security.txt.', { evidence: [ex] });
      const body = ex.text.replace(/^-----BEGIN PGP SIGNED MESSAGE-----[\s\S]*?\n\n/, '');
      const contacts = [...body.matchAll(/^\s*Contact\s*:\s*(\S+)/gim)].map((m) => m[1]);
      const expires = /^\s*Expires\s*:\s*(.+)$/im.exec(body)?.[1]?.trim();
      const expDate = expires ? new Date(expires) : null;
      const problems = [];
      if (!contacts.length) problems.push('no Contact line');
      if (!expires) problems.push('no Expires line');
      else if (Number.isNaN(expDate.getTime())) problems.push(`Expires "${expires}" is not a date`);
      else if (expDate.getTime() < Date.now()) problems.push(`it expired on ${expires}`);
      if (legacy) problems.push('it is at the legacy /security.txt location, not /.well-known/');
      const details = { contacts, expires: expires || null, legacy };
      if (!contacts.length) return fail(`security.txt exists but ${problems.join('; ')}.`, { evidence: [ex], details });
      if (problems.length) return warn(`security.txt names ${contacts.length} contact(s), but ${problems.join('; ')}.`, { evidence: [ex], details });
      return pass(`security.txt names ${contacts[0]}${contacts.length > 1 ? ` and ${contacts.length - 1} more` : ''} and is valid until ${expires}.`, { evidence: [ex], details });
    },
  },
};
