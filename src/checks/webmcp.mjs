// Checks for the webmcp layer (owner: H3). Ids and metadata: src/catalog.json.
// Browser data comes from src/browser/collect.mjs (document.modelContext.getTools() in Chromium with WebMCPTesting);
// without a browser, webmcp.tools and the declarative checks fall back to the server HTML and same-origin scripts.
// Lighthouse rules (13.6.0, book Table B.9 and chapter 9): form-coverage informative, registered-tools informative with a
// 40-tool warning, schema-validity 0 on errors / 0.5 on warnings only / 1 when clean.
import { pass, warn, fail, info, neutral } from '../core/result.mjs';
import { parseDocument, staticName, describe } from '../core/html.mjs';

/** MCP tool-name rule (MCP 2026-07-28 "Tool Names": SHOULD be 1-128 chars of letters, digits, _ - .). */
export const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const REGISTER = /\bmodelContext\b[\s\S]{0,300}?\b(registerTool|provideContext)\s*\(|\b(registerTool|provideContext)\s*\(\s*\{[\s\S]{0,400}?\binputSchema\b/;
const FIELD_SEL = 'input, select, textarea';
const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image']);
const VERBS = new Set(['search', 'find', 'get', 'list', 'check', 'create', 'book', 'start', 'update', 'cancel', 'delete', 'contact', 'plan', 'send',
  'look', 'return', 'fetch', 'read', 'show', 'view', 'add', 'remove', 'submit', 'subscribe', 'compare', 'calculate', 'open', 'buy', 'order', 'pay',
  'reserve', 'schedule', 'track', 'generate', 'convert', 'translate', 'scan', 'explain', 'describe', 'ask', 'answer', 'filter', 'sort', 'load',
  'save', 'upload', 'download', 'register', 'sign', 'log', 'request', 'query', 'select', 'choose', 'set', 'change', 'edit', 'write', 'post',
  'share', 'navigate', 'go', 'estimate', 'preview', 'verify', 'validate', 'run', 'call', 'join', 'leave', 'apply', 'rate', 'review', 'report',
  'retrieve', 'lookup', 'locate', 'browse', 'explore', 'summarize', 'summarise', 'play', 'stop', 'make', 'build', 'close', 'fill', 'enter']);
export const READ_NAME = /^(get|search|list|find|check|lookup|look_up|read|fetch|view|show|query|describe|explain|compare|calculate|estimate|preview|browse|retrieve|locate)([_\-.]|$|[A-Z])/i;
export const WRITE_NAME = /^(book|buy|create|delete|remove|cancel|submit|send|pay|purchase|order|update|edit|set|add|post|register|subscribe|unsubscribe|reserve|checkout|upload|transfer|contact)([_\-.]|$|[A-Z])/i;

/** The document whose forms we judge: the rendered DOM when a browser ran, else the server HTML. */
async function formsDoc(ctx) {
  return ctx.memo('webmcp:formsDoc', async () => {
    const b = await ctx.browserData();
    if (b?.ok && b.renderedHtml) return { doc: parseDocument(b.renderedHtml), source: 'rendered DOM' };
    return { doc: await ctx.dom(), source: 'server HTML' };
  });
}

/** Static WebMCP evidence: declarative forms, and registerTool/provideContext calls in inline or same-origin scripts. */
export function staticWebmcp(ctx) {
  return ctx.memo('webmcp:static', async () => {
    const doc = await ctx.dom();
    const forms = [...doc.querySelectorAll('form[toolname]')].map((f) => ({ name: f.getAttribute('toolname'), description: f.getAttribute('tooldescription') || '', selector: describe(f) }));
    const scripts = []; const exchanges = [];
    for (const s of doc.querySelectorAll('script')) {
      const src = s.getAttribute('src');
      if (!src && REGISTER.test(s.textContent || '')) scripts.push({ where: 'inline script', call: (REGISTER.exec(s.textContent) || [])[1] || (REGISTER.exec(s.textContent) || [])[2] });
    }
    const external = [...doc.querySelectorAll('script[src]')].map((s) => { try { return new URL(s.getAttribute('src'), ctx.url).href; } catch { return null; } })
      .filter((u) => u && new URL(u).origin === ctx.origin).slice(0, 6);
    const fetched = await Promise.all(external.map((u) => ctx.fetch(u, { accept: '*/*', maxBytes: 600_000, purpose: 'WebMCP static scan' })));
    fetched.forEach((ex, i) => {
      if (ex.ok && REGISTER.test(ex.text)) { const m = REGISTER.exec(ex.text); scripts.push({ where: external[i], call: m[1] || m[2] }); exchanges.push(ex); }
    });
    return { forms, scripts, exchanges, scanned: external.length };
  });
}

/** Browser tools ({ supported, tools[] }) or null when no browser ran. */
async function browserTools(ctx) {
  const b = await ctx.browserData();
  if (!b?.ok || !b.webmcp) return null;
  return b.webmcp;
}

/** Tools to judge for descriptions: browser tools, else the static declarative forms. */
async function anyTools(ctx) {
  const bt = await browserTools(ctx);
  if (bt?.tools?.length) return { tools: bt.tools, source: 'browser' };
  const st = await staticWebmcp(ctx);
  return { tools: st.forms.map((f) => ({ name: f.name, description: f.description, source: 'declarative' })), source: 'server HTML' };
}

/** Fields of a form that an agent fills. */
function fieldsOf(form) {
  return [...form.querySelectorAll(FIELD_SEL)].filter((el) => !(el.tagName.toUpperCase() === 'INPUT' && SKIP_TYPES.has((el.getAttribute('type') || 'text').toLowerCase())));
}

/** Lighthouse-style lint of declarative tools: { errors[], warnings[] }. */
export function lintDeclarative(doc) {
  const errors = []; const warnings = [];
  const forms = [...doc.querySelectorAll('form')].filter((f) => f.hasAttribute('toolname') || f.hasAttribute('tooldescription'));
  const seen = new Map();
  for (const f of forms) {
    const name = (f.getAttribute('toolname') || '').trim();
    const where = name || describe(f);
    if (!name) errors.push({ tool: where, rule: 'missing-toolname', message: 'The form has a tooldescription but no toolname.' });
    else if (!TOOL_NAME.test(name)) errors.push({ tool: where, rule: 'toolname-pattern', message: `toolname "${name}" is not 1-128 letters, digits, _ - or . (MCP tool-name rule; checker rule).` });
    if (name && seen.has(name)) errors.push({ tool: where, rule: 'duplicate-toolname', message: `Two forms declare toolname "${name}"; Chromium refuses duplicate tool names (checker rule).` });
    if (name) seen.set(name, true);
    if (name && !(f.getAttribute('tooldescription') || '').trim()) warnings.push({ tool: where, rule: 'missing-tooldescription', message: 'The form has a toolname but no tooldescription.' });
    for (const el of fieldsOf(f)) {
      const fieldName = (el.getAttribute('name') || '').trim();
      const required = el.hasAttribute('required');
      if (!fieldName) { if (required) errors.push({ tool: where, rule: 'required-field-unnamed', message: `A required ${el.tagName.toLowerCase()} has no name attribute, so it cannot be a tool parameter.` }); continue; }
      const desc = (el.getAttribute('toolparamdescription') || '').trim();
      if (!required && !desc && !staticName(el, doc)) warnings.push({ tool: where, param: fieldName, rule: 'param-undescribed', message: `Optional field "${fieldName}" has neither a toolparamdescription nor a label.` });
    }
  }
  return { forms: forms.length, errors, warnings };
}

/** JSON Schema shape checks for one imperative tool: { errors[], warnings[] } (structural, no Ajv). */
export function lintSchema(tool) {
  const errors = []; const warnings = [];
  const s = tool.inputSchema;
  if (s === undefined || s === null) warnings.push('no inputSchema: agents get no parameter list');
  else if (typeof s !== 'object' || Array.isArray(s)) errors.push('inputSchema is not an object');
  else {
    if (s.type !== undefined && s.type !== 'object') errors.push(`inputSchema type is "${s.type}", not "object"`);
    const props = s.properties ?? {};
    if (typeof props !== 'object' || Array.isArray(props)) errors.push('properties is not an object');
    else {
      for (const [k, v] of Object.entries(props)) {
        if (!v || typeof v !== 'object') { errors.push(`property "${k}" is not a schema object`); continue; }
        if (!['type', 'enum', 'const', '$ref', 'anyOf', 'oneOf', 'allOf'].some((x) => x in v)) warnings.push(`property "${k}" has no type`);
        if (!v.description && !v.title) warnings.push(`property "${k}" has no description`);
      }
    }
    if (s.required !== undefined) {
      if (!Array.isArray(s.required)) errors.push('required is not an array');
      else for (const r of s.required) if (typeof props !== 'object' || !(r in props)) errors.push(`required "${r}" is not in properties`);
    }
  }
  const o = tool.outputSchema;
  if (o !== undefined && o !== null && (typeof o !== 'object' || Array.isArray(o) || (o.type !== undefined && o.type !== 'object'))) warnings.push('outputSchema is not an object schema');
  return { errors, warnings };
}

/** Decode a Chrome origin-trial token: { feature, origin, expiry, isSubdomain, isThirdParty } or null. */
export function decodeOriginTrial(token) {
  try {
    const bin = atob(String(token).trim());
    if (bin.length < 70) return null;
    const len = (bin.charCodeAt(65) << 24) | (bin.charCodeAt(66) << 16) | (bin.charCodeAt(67) << 8) | bin.charCodeAt(68);
    const payload = JSON.parse(bin.slice(69, 69 + len));
    return { version: bin.charCodeAt(0), feature: payload.feature, origin: payload.origin, expiry: payload.expiry, isSubdomain: !!payload.isSubdomain, isThirdParty: !!payload.isThirdParty };
  } catch { return null; }
}

function originMatches(tokenOrigin, origin, isSubdomain) {
  try {
    const t = new URL(tokenOrigin); const o = new URL(origin);
    if (t.protocol !== o.protocol) return false;
    if (t.host === o.host) return true;
    return isSubdomain && o.hostname.endsWith('.' + t.hostname);
  } catch { return false; }
}

const first = (s) => String(s || '').trim().split(/[\s_\-.]+/)[0].toLowerCase();
const verbish = (w) => VERBS.has(w) || VERBS.has(w.replace(/es$/, '')) || VERBS.has(w.replace(/s$/, '')) || VERBS.has(w.replace(/ies$/, 'y'));

export default {
  'webmcp.tools': {
    why: 'WebMCP lets a site hand in-browser agents named tools with schemas instead of making them click through the page. Both isitagentready and Lighthouse look for them (book chapter 9).',
    fix: {
      snippet: '<form action="/search" toolname="search_products"\n      tooldescription="Search the catalogue by keyword. Returns matching products with prices.">\n  <label>Keyword <input name="q" toolparamdescription="Words to search for"></label>\n  <button>Search</button>\n</form>\n<script>\n  if (\'modelContext\' in document) document.modelContext.registerTool({\n    name: \'get_product\', description: \'Get one product by its id, with price and stock.\',\n    inputSchema: { type: \'object\', properties: { id: { type: \'string\', description: \'Product id from search_products\' } }, required: [\'id\'] },\n    annotations: { readOnlyHint: true },\n    async execute({ id }) { return JSON.stringify(await (await fetch(`/api/products/${id}`)).json()); },\n  });\n</script>',
      prompt: 'Expose the site\'s key actions as WebMCP tools. Add toolname, tooldescription and toolparamdescription attributes to existing forms (search, contact, booking), and register tools that no single form covers with document.modelContext.registerTool() behind a feature check (\'modelContext\' in document). Verify in Chrome with chrome://flags WebMCP testing enabled: document.modelContext.getTools() lists them.',
    },
    async run(ctx) {
      const [bt, st] = await Promise.all([browserTools(ctx), staticWebmcp(ctx)]);
      const declared = st.forms.filter((f) => f.name && f.description);
      const staticFound = declared.length > 0 || st.scripts.length > 0;
      const staticMsg = [declared.length ? `${declared.length} form(s) with toolname and tooldescription` : '', st.scripts.length ? `registerTool/provideContext calls in ${st.scripts.length} script(s)` : ''].filter(Boolean).join(' and ');
      const evidence = [await ctx.home(), ...st.exchanges];
      const compat = staticFound || bt?.tools?.length ? { status: 'pass', message: bt?.tools?.length ? `${bt.tools.length} WebMCP tool(s) registered` : `Found ${staticMsg}` } : { status: 'fail', message: 'No WebMCP tools found' };
      const details = { browser: !!bt, tools: (bt?.tools || []).map((t) => ({ name: t.name, source: t.source, description: t.description })), staticForms: st.forms, staticScripts: st.scripts };
      if (bt?.tools?.length) {
        const imp = bt.tools.filter((t) => t.source === 'imperative').length;
        return pass(`The page registers ${bt.tools.length} WebMCP tool(s) in Chromium: ${imp} imperative, ${bt.tools.length - imp} declarative (${bt.tools.slice(0, 6).map((t) => t.name).join(', ')}${bt.tools.length > 6 ? ', ...' : ''}).`, { evidence, details, compat });
      }
      if (bt && staticFound) return warn(`The page source has ${staticMsg}, but Chromium with WebMCP enabled registered no tools: check the console for registration errors.`, { evidence, details, compat });
      if (bt && !bt.supported) {
        if (staticFound) return pass(`The page source has ${staticMsg} (this browser had no document.modelContext, so registration was not observed).`, { evidence, details, compat });
        return fail('No WebMCP tools found in the page source (this browser had no document.modelContext to observe registrations).', { evidence, details, compat });
      }
      if (staticFound) return pass(`The page source has ${staticMsg} (static scan; run with a browser to see the registered tools).`, { evidence, details, compat });
      return fail(bt ? 'Chromium with WebMCP enabled found no tools on this page, and the source has no toolname forms or registerTool calls.' : `No WebMCP tools in the server HTML or ${st.scanned} same-origin script(s): no toolname forms and no registerTool calls.`, { evidence, details, compat });
    },
  },

  'webmcp.form-coverage': {
    why: 'A form that already does a job is the cheapest tool you will ever write: two attributes turn it into a WebMCP tool, with the schema built from its fields. Lighthouse lists the forms that lack them (book chapter 9).',
    fix: {
      snippet: '<form action="/contact" method="post" toolname="contact_us"\n      tooldescription="Send a message to the team. Use for questions about orders or bookings.">',
      prompt: 'For every public form except login and password forms, add toolname (snake_case verb_noun) and tooldescription (what it does, when to use it, what happens on submit) to the <form> element, and toolparamdescription to fields whose label is not self-explanatory. Re-run Lighthouse Agentic Browsing: webmcp-form-coverage should pass.',
    },
    async run(ctx) {
      const { doc, source } = await formsDoc(ctx);
      const all = [...doc.querySelectorAll('form')];
      const candidates = all.filter((f) => !f.querySelector('input[type="password" i]') && fieldsOf(f).length > 0);
      const skippedLogin = all.length - candidates.length;
      if (!candidates.length) return neutral(`No forms an agent should fill (${all.length} form(s) in the ${source}${skippedLogin ? `, ${skippedLogin} login/password or field-less` : ''}).`);
      const covered = candidates.filter((f) => f.getAttribute('toolname') && f.getAttribute('tooldescription'));
      const missing = candidates.filter((f) => !covered.includes(f)).map((f) => ({ form: describe(f), action: f.getAttribute('action') || '', toolname: f.getAttribute('toolname') || null }));
      const msg = `${covered.length} of ${candidates.length} form(s) in the ${source} declare both toolname and tooldescription${skippedLogin ? ` (${skippedLogin} login/password or field-less form(s) not counted)` : ''}.`;
      const details = { covered: covered.map((f) => f.getAttribute('toolname')), missing, source };
      if (covered.length === candidates.length) return pass(msg, { details });
      if (covered.length) return warn(msg, { details });
      const bt = await browserTools(ctx);
      if (bt?.tools?.length) return warn(`${msg} The page offers ${bt.tools.length} imperative tool(s) instead.`, { details });
      return fail(msg, { details });
    },
  },

  'webmcp.schema-validity': {
    why: 'Chrome builds a declarative tool\'s schema from the form. A missing toolname, a required field without a name or an undescribed optional field gives agents a broken or vague tool. Lighthouse scores this 0, 0.5 or 1 (book chapter 9).',
    fix: {
      snippet: '<form toolname="find_booking" tooldescription="Look up a booking by its reference and email.">\n  <label for="ref">Booking reference</label>\n  <input id="ref" name="ref" required toolparamdescription="Reference like NC-1234">\n  <input name="email" type="email" required>\n</form>',
      prompt: 'In every form that has toolname or tooldescription: make sure toolname is set (snake_case, letters, digits and underscores), every required field has a name attribute, and every optional field has a <label> or toolparamdescription. Re-run Lighthouse Agentic Browsing: webmcp-schema-validity should score 1.',
    },
    async run(ctx) {
      const { doc, source } = await formsDoc(ctx);
      const r = lintDeclarative(doc);
      if (!r.forms) return neutral(`No declarative WebMCP tools (no form has toolname or tooldescription in the ${source}).`);
      const details = { forms: r.forms, errors: r.errors, warnings: r.warnings, lighthouseScore: r.errors.length ? 0 : r.warnings.length ? 0.5 : 1, source };
      const list = (a) => a.slice(0, 3).map((x) => `${x.tool}${x.param ? '.' + x.param : ''}: ${x.message}`).join(' ');
      if (r.errors.length) return fail(`${r.errors.length} error(s) and ${r.warnings.length} warning(s) in ${r.forms} declarative tool(s). ${list(r.errors)}`, { details });
      if (r.warnings.length) return warn(`${r.warnings.length} warning(s) in ${r.forms} declarative tool(s), no errors. ${list(r.warnings)}`, { details });
      return pass(`${r.forms} declarative tool(s) are valid: named, with named required fields and described optional fields.`, { details });
    },
  },

  'webmcp.tool-schemas': {
    why: 'An imperative tool\'s inputSchema is the only parameter documentation an agent gets. It must be an object schema whose required names exist in properties (book chapter 9).',
    fix: {
      snippet: "inputSchema: {\n  type: 'object',\n  properties: {\n    checkIn: { type: 'string', format: 'date', description: 'Arrival date, YYYY-MM-DD' },\n    guests: { type: 'integer', minimum: 1, description: 'Number of guests' },\n  },\n  required: ['checkIn', 'guests'],\n}",
      prompt: 'For every tool passed to document.modelContext.registerTool(): give it an inputSchema with type "object", a properties map where each property has a type and a description, and a required array that only names properties that exist. If outputSchema is set, make it an object schema too. Verify with document.modelContext.getTools() in Chrome with WebMCP testing enabled.',
    },
    async run(ctx) {
      const bt = await browserTools(ctx);
      const tools = (bt?.tools || []).filter((t) => t.source === 'imperative');
      if (!tools.length) return neutral(bt?.tools?.length ? 'Only declarative tools, whose schemas Chrome builds from the form.' : 'No imperative WebMCP tools registered.');
      const per = tools.map((t) => ({ name: t.name, ...lintSchema(t) }));
      const errs = per.filter((p) => p.errors.length); const warns = per.filter((p) => p.warnings.length);
      const details = { tools: per };
      if (errs.length) return fail(`${errs.length} of ${tools.length} imperative tool(s) have schema errors: ${errs.slice(0, 3).map((p) => `${p.name} (${p.errors[0]})`).join('; ')}.`, { details });
      if (warns.length) return warn(`${tools.length} imperative tool(s) have valid object schemas; ${warns.length} have gaps: ${warns.slice(0, 3).map((p) => `${p.name} (${p.warnings[0]})`).join('; ')}.`, { details });
      return pass(`All ${tools.length} imperative tool(s) have object input schemas with typed, described properties.`, { details });
    },
  },

  'webmcp.tool-count': {
    why: 'Agents choose worse from long tool lists, and every tool costs context. Lighthouse warns above 40 tools on one page (book chapter 10).',
    fix: {
      snippet: "// Register only the tools that fit this page; unregister on navigation\nconst controller = new AbortController();\ndocument.modelContext.registerTool(tool, { signal: controller.signal });",
      prompt: 'Reduce the number of WebMCP tools registered on this page to the actions that make sense here (40 at most, ideally under 20): merge near-duplicates, register page-specific tools only on their pages, and unregister with an AbortController when they stop applying.',
    },
    async run(ctx) {
      const bt = await browserTools(ctx);
      const n = bt?.tools?.length || 0;
      if (!n) return neutral('No WebMCP tools registered, so there is nothing to count.');
      const details = { count: n, names: bt.tools.map((t) => t.name) };
      if (n > 40) return warn(`${n} WebMCP tools are registered on this page, above Lighthouse's 40-tool warning.`, { details });
      return pass(`${n} WebMCP tool(s) registered, within Lighthouse's 40-tool limit.`, { details });
    },
  },

  'webmcp.descriptions': {
    why: 'The description is how an agent decides whether to call a tool: it should say what the tool does, when to use it and what comes back. Vague or duplicate descriptions make agents pick the wrong tool (book chapter 10).',
    fix: {
      snippet: "description: 'Check if one cabin is free for a stay and get the exact total price. Call this before create_booking. available=false means the dates are taken.'",
      prompt: 'Rewrite each WebMCP tool description (tooldescription attribute or registerTool description) to start with a verb, say what the tool does, when to use it and what it returns, in 20 to 500 characters, and make every description distinct.',
    },
    async run(ctx) {
      const { tools, source } = await anyTools(ctx);
      if (!tools.length) return neutral('No WebMCP tools to judge.');
      const counts = new Map();
      for (const t of tools) { const d = String(t.description || '').trim().toLowerCase(); if (d) counts.set(d, (counts.get(d) || 0) + 1); }
      const issues = [];
      let bad = 0;
      for (const t of tools) {
        const d = String(t.description || '').trim();
        const mine = [];
        if (!d) mine.push('no description');
        else {
          if (d.length < 20) mine.push(`only ${d.length} characters`);
          if (d.length > 500) mine.push(`${d.length} characters (over 500)`);
          if (!verbish(first(d))) mine.push(`starts with "${first(d)}", not a verb`);
          if (counts.get(d.toLowerCase()) > 1) mine.push('same description as another tool');
        }
        if (!d || d.length < 20) bad++;
        if (mine.length) issues.push({ tool: t.name, issues: mine });
      }
      const details = { tools: tools.length, issues, source, heuristic: 'length 20-500, verb first, no duplicates' };
      const sample = issues.slice(0, 3).map((i) => `${i.tool}: ${i.issues.join(', ')}`).join('; ');
      if (bad > tools.length / 2) return fail(`${bad} of ${tools.length} tool(s) have a missing or very short description. ${sample}.`, { details });
      if (issues.length) return warn(`${issues.length} of ${tools.length} tool description(s) could guide agents better: ${sample}.`, { details });
      return pass(`All ${tools.length} tool description(s) start with a verb, are 20-500 characters and are distinct.`, { details });
    },
  },

  'webmcp.annotations': {
    why: 'readOnlyHint tells the browser and the agent whether a call changes anything, so hosts can skip or require a confirmation. A write tool marked read-only removes that safety net (book chapter 10).',
    fix: {
      snippet: "annotations: { readOnlyHint: true, untrustedContentHint: true } // for get_/search_ tools that return user content\nannotations: { readOnlyHint: false }                            // for book_/create_/cancel_ tools",
      prompt: 'For every registerTool() call, set annotations.readOnlyHint: true on tools that only read (get, search, list, check), leave it false on tools that change state (book, create, cancel, send), and set untrustedContentHint: true on tools that return third-party or user-written content.',
    },
    async run(ctx) {
      const bt = await browserTools(ctx);
      const tools = (bt?.tools || []).filter((t) => t.source === 'imperative');
      if (!tools.length) return neutral('No imperative WebMCP tools (declarative form tools carry no annotations).');
      const lies = []; const missing = []; const ok = [];
      for (const t of tools) {
        const ro = t.annotations?.readOnlyHint === true;
        if (WRITE_NAME.test(t.name) && ro) lies.push(t.name);
        else if (READ_NAME.test(t.name) && !ro) missing.push(t.name);
        else ok.push(t.name);
      }
      const details = { tools: tools.map((t) => ({ name: t.name, annotations: t.annotations || null })), writeMarkedReadOnly: lies, readWithoutReadOnly: missing, note: 'Chromium reports default annotations (readOnlyHint false) when a tool sets none, so a missing hint and an explicit false look the same.' };
      if (lies.length) return fail(`${lies.length} tool(s) that look like they change state are marked readOnlyHint: ${lies.slice(0, 4).join(', ')}.`, { details });
      if (missing.length) return warn(`${missing.length} of ${tools.length} read-only-looking tool(s) are not marked readOnlyHint: ${missing.slice(0, 4).join(', ')}.`, { details });
      return pass(`Annotations of all ${tools.length} imperative tool(s) match their names (read tools readOnlyHint, write tools not).`, { details });
    },
  },

  'webmcp.origin-trial': {
    why: 'Until WebMCP ships by default, ordinary Chrome users only get a site\'s tools when the site carries a valid WebMCP origin-trial token for its own origin (book chapter 9).',
    fix: {
      snippet: '<meta http-equiv="origin-trial" content="YOUR_WEBMCP_TOKEN">\n<!-- or the HTTP header -->\nOrigin-Trial: YOUR_WEBMCP_TOKEN',
      prompt: 'Register the site origin for the WebMCP origin trial in the Chrome Origin Trials console, then serve the token on every page that registers tools, as an Origin-Trial response header or a <meta http-equiv="origin-trial"> tag in <head>. Renew it before it expires.',
    },
    async run(ctx) {
      const [bt, st, home, doc] = await Promise.all([browserTools(ctx), staticWebmcp(ctx), ctx.home(), ctx.dom()]);
      const uses = (bt?.tools?.length || 0) > 0 || st.forms.length > 0 || st.scripts.length > 0;
      const raw = [...String(home.headers?.['origin-trial'] || '').split(',').map((s) => s.trim()).filter(Boolean),
        ...[...doc.querySelectorAll('meta')].filter((m) => (m.getAttribute('http-equiv') || '').toLowerCase() === 'origin-trial').map((m) => m.getAttribute('content') || '')].filter(Boolean);
      const tokens = raw.map((t) => ({ ...(decodeOriginTrial(t) || { feature: null }), length: t.length }));
      const wm = tokens.filter((t) => /webmcp|modelcontext/i.test(t.feature || ''));
      const details = { usesWebmcp: uses, tokens: tokens.map(({ feature, origin, expiry, isSubdomain }) => ({ feature, origin, expiry: expiry ? new Date(expiry * 1000).toISOString() : null, isSubdomain })) };
      if (!uses && !wm.length) return neutral('The page does not use WebMCP, so no origin-trial token is needed.', { details });
      if (!wm.length) return info(`The page uses WebMCP but serves no WebMCP origin-trial token${tokens.length ? ` (${tokens.length} token(s) for other features)` : ''}, so only browsers with the WebMCP flag see its tools.`, { evidence: [home], details });
      const now = Date.now() / 1000;
      const good = wm.find((t) => t.expiry > now && originMatches(t.origin, ctx.origin, t.isSubdomain));
      if (good) return pass(`A WebMCP origin-trial token for ${good.origin} is served, valid until ${new Date(good.expiry * 1000).toISOString().slice(0, 10)}.`, { evidence: [home], details });
      const t = wm[0];
      return warn(t.expiry <= now ? `The WebMCP origin-trial token expired on ${new Date(t.expiry * 1000).toISOString().slice(0, 10)}.` : `The WebMCP origin-trial token is for ${t.origin}, not ${ctx.origin}.`, { evidence: [home], details });
    },
  },
};
