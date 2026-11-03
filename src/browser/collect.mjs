// Browser collector (Node only): open one page in headless Chromium and gather what the browser-only checks read.
// Contract: shared SPEC "browserData". playwright-core + the cached Chromium (CHROMIUM_PATH overrides), launched with
// --enable-features=WebMCPTesting so document.modelContext exists (Chromium 150+; probed on 156.0.8078.4, 3 Nov 2026).
// Axe rule list and the runAxe approach adapted from agent-ready-web-demos (MIT), chapters/03-how-agents-see-a-page.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { lookup } from 'node:dns/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isBlockedIP, isIPLiteral } from '../core/net.mjs';
import { VERSION } from '../core/fetcher.mjs';

const require = createRequire(import.meta.url);

/** The 33 axe-core rules behind Lighthouse 13.6.0 agent-accessibility-tree (TARGET_RULES). */
export const AGENT_RULES = [
  'button-name', 'input-button-name', 'input-image-alt', 'label', 'link-name', 'select-name', 'document-title',
  'aria-allowed-attr', 'aria-allowed-role', 'aria-command-name', 'aria-conditional-attr', 'aria-dialog-name',
  'aria-hidden-body', 'aria-hidden-focus', 'aria-input-field-name', 'aria-prohibited-attr', 'aria-required-attr',
  'aria-required-children', 'aria-required-parent', 'aria-roles', 'aria-text', 'aria-toggle-field-name',
  'aria-tooltip-name', 'aria-treeitem-name', 'aria-valid-attr', 'aria-valid-attr-value', 'duplicate-id-aria',
  'definition-list', 'table-duplicate-name', 'tabindex', 'autocomplete-valid', 'presentation-role-conflict', 'svg-img-alt',
];

/** ARIA roles an agent can act on (WAI-ARIA 1.2 widget roles plus link). */
export const INTERACTIVE_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'textbox', 'searchbox', 'combobox', 'listbox',
  'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'slider', 'spinbutton', 'switch', 'tab', 'treeitem', 'gridcell']);

const MAX_HTML = 3_145_728;
const MAX_TEXT = 500_000;

/** Find a Chromium: CHROMIUM_PATH, else the newest chromium-* build in the Playwright cache. */
export function findChromium() {
  if (process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, join(homedir(), '.cache', 'ms-playwright'), '/ms-playwright'].filter(Boolean);
  for (const root of roots) {
    let dirs = [];
    const shell = process.env.PLAYWRIGHT_CHROMIUM_HEADLESS_SHELL === '1';
    const re = shell ? /^chromium_headless_shell-\d+$/ : /^chromium-\d+$/;
    try { dirs = readdirSync(root).filter((d) => re.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])); } catch { continue; }
    for (const d of dirs) {
      for (const sub of ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-linux/headless_shell', 'chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe', 'chrome-win64/chrome.exe']) {
        const p = join(root, d, sub);
        if (existsSync(p)) return p;
      }
    }
  }
  return undefined; // let playwright-core use its own default
}

/** SSRF guard for every request the page makes: http(s) only, ports 80/443, public addresses only. */
export function makeGuard({ allowPrivate = false, resolve = defaultResolve } = {}) {
  const cache = new Map();
  return async function check(rawUrl) {
    let u;
    try { u = new URL(rawUrl); } catch { return 'bad URL'; }
    if (['data:', 'blob:', 'about:'].includes(u.protocol)) return null;
    if (!['http:', 'https:'].includes(u.protocol)) return `scheme ${u.protocol} not allowed`;
    if (allowPrivate) return null;
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    if (!['80', '443'].includes(port)) return `port ${port} not allowed`;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost')) return 'localhost is not public';
    if (!cache.has(host)) {
      cache.set(host, (async () => {
        if (isIPLiteral(host)) return isBlockedIP(host) ? `${host} is not a public address` : null;
        let addrs;
        try { addrs = await resolve(host); } catch (e) { return `DNS failed for ${host}: ${e.code || e.message}`; }
        if (!addrs.length) return `no address for ${host}`;
        const bad = addrs.find((a) => isBlockedIP(a));
        return bad ? `${host} resolves to ${bad}, not a public address` : null;
      })());
    }
    return cache.get(host);
  };
}
async function defaultResolve(host) { return (await lookup(host, { all: true, verbatim: true })).map((a) => a.address); }

// Runs in the page before any site script: CLS observer and a record of elements that get click listeners.
function initScript() {
  const w = window;
  w.__arc = { shifts: [], clickEls: new WeakSet() };
  const sel = (n) => {
    try {
      if (!n || n.nodeType !== 1) return '';
      if (n.id) return `${n.tagName.toLowerCase()}#${n.id}`;
      const c = (n.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
      return n.tagName.toLowerCase() + (c.length ? '.' + c.join('.') : '');
    } catch { return ''; }
  };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.hadRecentInput) continue;
        w.__arc.shifts.push({ value: e.value, time: Math.round(e.startTime), sources: (e.sources || []).map((s) => sel(s.node)).filter(Boolean).slice(0, 5) });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch { /* not supported */ }
  try {
    const orig = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, fn, opts) {
      try { if (this instanceof Element && /^(click|mousedown|mouseup|pointerdown|pointerup|touchstart|keydown)$/.test(type)) w.__arc.clickEls.add(this); } catch { /* ignore */ }
      return orig.call(this, type, fn, opts);
    };
  } catch { /* ignore */ }
}

/** A desktop Chrome user agent that also names this checker (polite: sites can tell who is visiting). */
export function browserUserAgent(version = '156.0.0.0') {
  const major = String(version).split('.')[0] || '156';
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 AgentReadyCheck/${VERSION} (+https://github.com/vibeprogrammer/agent-ready-check)`;
}

/** CLS as Lighthouse and web.dev define it: the largest session window (gap < 1 s, window <= 5 s). */
export function clsFromShifts(shifts) {
  let best = 0; let cur = 0; let start = -Infinity; let last = -Infinity;
  for (const s of [...shifts].sort((a, b) => a.time - b.time)) {
    if (s.time - last > 1000 || s.time - start > 5000) { cur = 0; start = s.time; }
    cur += s.value; last = s.time;
    if (cur > best) best = cur;
  }
  return Math.round(best * 10000) / 10000;
}

// Runs in the page after load: everything that needs computed styles.
function pageProbe({ maxItems }) {
  const sel = (n) => {
    if (!n || n.nodeType !== 1) return '';
    const parts = [];
    let el = n;
    for (let i = 0; el && el.nodeType === 1 && i < 4; i++) {
      let s = el.tagName.toLowerCase();
      if (el.id) { parts.unshift(`${s}#${CSS.escape(el.id)}`); break; }
      const c = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (c.length) s += '.' + c.map((x) => CSS.escape(x)).join('.');
      const p = el.parentElement;
      if (p) { const same = [...p.children].filter((k) => k.tagName === el.tagName); if (same.length > 1) s += `:nth-of-type(${same.indexOf(el) + 1})`; }
      parts.unshift(s);
      el = p;
    }
    return parts.join(' > ');
  };
  const vw = innerWidth; const vh = innerHeight;
  const all = [...(document.body ? document.body.querySelectorAll('*') : [])].slice(0, 8000);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'PATH', 'META', 'LINK', 'HEAD', 'TITLE', 'IFRAME', 'OBJECT']);

  // Hidden text: report the outermost hidden element that carries text.
  const hiddenText = [];
  const hiddenRoots = [];
  const within = (el) => hiddenRoots.some((r) => r.contains(el));
  for (const el of all) {
    if (hiddenText.length >= maxItems) break;
    if (SKIP.has(el.tagName) || within(el)) continue;
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (t.length < 20) continue;
    const cs = getComputedStyle(el);
    let method = null;
    if (cs.display === 'none') method = 'display-none';
    else if (cs.visibility === 'hidden' || cs.visibility === 'collapse') method = 'visibility';
    else if (el.getAttribute('aria-hidden') === 'true') method = 'aria-hidden';
    else if (Number(cs.opacity) === 0 || /rgba\(\d+, \d+, \d+, 0\)|transparent/.test(cs.color) || parseFloat(cs.fontSize) === 0) method = 'transparent';
    else if ((cs.clip && /rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)/.test(cs.clip)) || /inset\(50%\)/.test(cs.clipPath || '')) method = 'clip';
    else {
      const r = el.getBoundingClientRect();
      if ((r.right < -500 || r.bottom < -500 || r.left > document.documentElement.scrollWidth + 500) && /absolute|fixed/.test(cs.position)) method = 'offscreen';
      else if ((r.width <= 1 || r.height <= 1) && cs.overflow !== 'visible') method = 'zero-size';
    }
    if (method) { hiddenRoots.push(el); hiddenText.push({ selector: sel(el), method, text: t.slice(0, 500) }); }
  }

  // Consent overlays: fixed/sticky boxes with consent words.
  const CONSENT = /cookie|consent|gdpr|privacy|personvern|samtykke|informasjonskapsler|accept all|reject all|tracking|datenschutz/i;
  const overlays = [];
  const scrollLocked = ['hidden', 'clip'].includes(getComputedStyle(document.documentElement).overflowY) || ['hidden', 'clip'].includes(getComputedStyle(document.body || document.documentElement).overflowY);
  for (const el of all) {
    if (overlays.length >= 10) break;
    const cs = getComputedStyle(el);
    if (!/fixed|sticky/.test(cs.position) || cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)); const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const coverage = (w * h) / (vw * vh);
    if (coverage < 0.02) continue;
    const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
    if (!CONSENT.test(text) && !CONSENT.test(el.id + ' ' + el.className)) continue;
    if (overlays.some((o) => o.el.contains(el))) continue;
    overlays.push({ el, selector: sel(el), coverage: Math.round(coverage * 100) / 100, text: text.slice(0, 200), blocksScroll: scrollLocked });
  }

  // Clickables: elements with click listeners, onclick, or cursor:pointer (not inherited from a pointer parent).
  const NATIVE = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'OPTION', 'LABEL']);
  const clickables = [];
  for (const el of all) {
    if (clickables.length >= maxItems) break;
    if (SKIP.has(el.tagName)) continue;
    const listener = window.__arc?.clickEls?.has(el) || el.hasAttribute('onclick');
    let pointer = false;
    if (!listener) {
      const cs = getComputedStyle(el);
      if (cs.cursor !== 'pointer') continue;
      const pc = el.parentElement ? getComputedStyle(el.parentElement).cursor : '';
      if (pc === 'pointer') continue;
      pointer = true;
    } else pointer = getComputedStyle(el).cursor === 'pointer';
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const tag = el.tagName.toLowerCase();
    const native = NATIVE.has(el.tagName) && !(el.tagName === 'A' && !el.hasAttribute('href'));
    const inNative = !!el.parentElement?.closest('a[href],button,label,summary');
    clickables.push({ selector: sel(el), tag, role: el.getAttribute('role') || null, focusable: el.tabIndex >= 0 && !el.disabled, hasHref: el.hasAttribute('href'), native, inNative, listener: !!listener, pointer, text: (el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 80) });
  }

  // Tag interactive candidates so the accessibility tree can be mapped back to selectors.
  const declared = [...document.querySelectorAll('form[toolname]')].map((f) => f.getAttribute('toolname'));
  return {
    hiddenText, clickables,
    overlays: overlays.map(({ el, ...o }) => o), // eslint-disable-line no-unused-vars
    declared,
    title: document.title,
    renderedText: (document.body?.innerText || '').slice(0, 500_000),
    userAgent: navigator.userAgent,
  };
}

/**
 * Open `url` in headless Chromium and collect browserData (shared SPEC contract).
 * Never throws: failures come back as { ok: false, error }.
 * @param {string} url
 * @param {{ allowPrivate?: boolean, timeoutMs?: number, executablePath?: string, settleMs?: number, resolve?: Function, maxItems?: number }} [o]
 */
export async function collectBrowser(url, { allowPrivate = false, timeoutMs = 30000, executablePath, settleMs = 3000, resolve, maxItems = 200 } = {}) {
  const t0 = Date.now();
  const guard = makeGuard({ allowPrivate, resolve });
  const why = await guard(url);
  if (why) return { ok: false, error: `blocked: ${why}` };
  let chromium;
  try { ({ chromium } = await import('playwright-core')); } catch { return { ok: false, error: 'playwright-core is not installed' }; }
  let browser = null;
  let timer;
  const deadline = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`browser run exceeded ${timeoutMs} ms`)), timeoutMs); });
  const blocked = [];
  const consoleErrors = [];
  const run = async () => {
    browser = await chromium.launch({ headless: true, executablePath: executablePath || findChromium(), args: ['--enable-features=WebMCPTesting', '--no-sandbox', '--disable-dev-shm-usage', ...String(process.env.CHROMIUM_ARGS || '').split(/\s+/).filter(Boolean)] });
    const chromiumVersion = browser.version();
    const ua = browserUserAgent(chromiumVersion);
    const context = await browser.newContext({ bypassCSP: true, serviceWorkers: 'block', viewport: { width: 1280, height: 800 }, acceptDownloads: false, userAgent: ua });
    // Every request (redirect hops included) is fetched by hand so each hop passes the guard.
    await context.route('**/*', async (route) => {
      const req = route.request();
      const reason = await guard(req.url());
      if (reason) { blocked.push({ url: req.url().slice(0, 300), reason }); return route.abort('blockedbyclient').catch(() => {}); }
      if (['media', 'websocket', 'eventsource'].includes(req.resourceType())) return route.abort('blockedbyclient').catch(() => {});
      if (allowPrivate) return route.continue().catch(() => {});
      try {
        const res = await route.fetch({ maxRedirects: 0, timeout: 10000 });
        return route.fulfill({ response: res }).catch(() => {});
      } catch { return route.abort('failed').catch(() => {}); }
    });
    if (context.routeWebSocket) await context.routeWebSocket(/.*/, (ws) => ws.close()).catch(() => {});
    await context.addInitScript(initScript);
    const page = await context.newPage();
    page.on('console', (m) => { if (m.type() === 'error' && consoleErrors.length < 50) consoleErrors.push(m.text().slice(0, 300)); });
    page.on('pageerror', (e) => { if (consoleErrors.length < 50) consoleErrors.push(`Uncaught: ${String(e?.message || e).slice(0, 300)}`); });
    const navStart = Date.now();
    const remaining = () => timeoutMs - (Date.now() - t0);
    // Wait for DOMContentLoaded, then give 'load' a bounded chance: heavy sites (ads, trackers) may never settle.
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.max(1000, Math.min(20000, remaining() - 8000)) });
    await page.waitForLoadState('load', { timeout: Math.max(500, Math.min(8000, remaining() - 10000)) }).catch(() => {});
    const navigationMs = Date.now() - navStart;
    if (!resp && !/^(data|about):/.test(url)) throw new Error('navigation returned no response');

    // WebMCP: wait up to ~3 s for registrations, during the CLS settle window.
    const settle = Math.max(0, Math.min(settleMs, remaining() - 6000));
    const webmcp = await page.evaluate(async (ms) => {
      const mc = document.modelContext || navigator.modelContext;
      if (!mc || typeof mc.getTools !== 'function') {
        await new Promise((r) => setTimeout(r, ms));
        return { supported: !!mc, legacy: !document.modelContext && !!navigator.modelContext, tools: [], error: mc ? 'getTools() is not available' : null };
      }
      const end = Date.now() + ms;
      let tools = [];
      let error = null;
      while (Date.now() < end) {
        try { tools = await mc.getTools(); } catch (e) { error = String(e?.message || e); }
        await new Promise((r) => setTimeout(r, 250));
      }
      try { tools = await mc.getTools(); } catch (e) { error = String(e?.message || e); }
      const plain = (v) => { try { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); } catch { return null; } };
      return { supported: true, legacy: !document.modelContext, tools: [...tools].map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: plain(t.inputSchema), outputSchema: plain(t.outputSchema), annotations: plain(t.annotations) })), error };
    }, settle);

    const probe = await page.evaluate(pageProbe, { maxItems });
    const declared = new Set(probe.declared);
    webmcp.tools = webmcp.tools.map((t) => ({ ...t, source: declared.has(t.name) && !t.annotations ? 'declarative' : 'imperative' }));
    webmcp.declaredForms = probe.declared;

    const shifts = await page.evaluate(() => window.__arc?.shifts || []).catch(() => []);
    const cls = { value: clsFromShifts(shifts), shifts: shifts.slice(0, 20), observedMs: Date.now() - navStart };

    let renderedHtml = await page.content().catch(() => '');
    if (renderedHtml.length > MAX_HTML) renderedHtml = renderedHtml.slice(0, MAX_HTML);

    // axe-core, the 33 Lighthouse agent rules (injected after the HTML snapshot).
    let axe;
    try {
      const src = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
      await page.addScriptTag({ content: src });
      axe = await page.evaluate(async (ids) => {
        const r = await window.axe.run(document, { runOnly: { type: 'rule', values: ids }, resultTypes: ['violations', 'incomplete'] });
        const nodes = (v) => v.nodes.slice(0, 10).map((n) => n.target.join(' '));
        return {
          version: window.axe.version,
          violations: r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: nodes(v), count: v.nodes.length })),
          incomplete: r.incomplete.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: nodes(v), count: v.nodes.length })),
          passes: r.passes.map((v) => v.id),
        };
      }, AGENT_RULES);
      axe.rules = AGENT_RULES;
    } catch (e) { axe = { version: null, rules: AGENT_RULES, violations: [], incomplete: [], passes: [], error: String(e?.message || e).slice(0, 300) }; }

    const a11y = await accessibility(page, maxItems).catch((e) => ({ interactive: [], unnamed: [], error: String(e?.message || e).slice(0, 300) }));
    return {
      ok: true, error: null, finalUrl: page.url(), status: resp ? resp.status() : null, title: probe.title, userAgent: probe.userAgent, chromium: chromiumVersion,
      renderedHtml, renderedText: probe.renderedText.slice(0, MAX_TEXT),
      axe, a11y, webmcp, cls,
      consent: { overlays: probe.overlays },
      hiddenText: probe.hiddenText,
      clickables: probe.clickables,
      consoleErrors, blocked: blocked.slice(0, 50),
      timings: { navigationMs, totalMs: Date.now() - t0 },
    };
  };
  try {
    return await Promise.race([run(), deadline]);
  } catch (e) {
    return { ok: false, error: String(e?.message || e).split('\n')[0].slice(0, 300), blocked: blocked.slice(0, 20), consoleErrors };
  } finally {
    clearTimeout(timer);
    if (browser) await browser.close().catch(() => {});
  }
}

/** Interactive nodes of Chromium's accessibility tree, with names, mapped back to CSS-ish selectors. */
async function accessibility(page, maxItems) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    const hits = nodes.filter((n) => !n.ignored && INTERACTIVE_ROLES.has(n.role?.value) && n.backendDOMNodeId).slice(0, maxItems * 2);
    const interactive = []; const unnamed = [];
    for (const n of hits) {
      const name = String(n.name?.value || '').trim();
      let selector = ''; let html = '';
      if (!name || interactive.length < maxItems) {
        try {
          const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: n.backendDOMNodeId });
          const { result } = await cdp.send('Runtime.callFunctionOn', {
            objectId: object.objectId, returnByValue: true,
            functionDeclaration: 'function(){const p=[];let e=this;for(let i=0;e&&e.nodeType===1&&i<4;i++){let s=e.tagName.toLowerCase();if(e.id){p.unshift(s+"#"+e.id);break;}const c=(e.getAttribute("class")||"").trim().split(/\\s+/).filter(Boolean).slice(0,2);if(c.length)s+="."+c.join(".");p.unshift(s);e=e.parentElement;}return [p.join(" > "),(this.outerHTML||"").slice(0,200)];}',
          });
          [selector, html] = result.value || ['', ''];
        } catch { /* node gone */ }
      }
      if (interactive.length < maxItems) interactive.push({ role: n.role.value, name: name.slice(0, 120), selector });
      if (!name && unnamed.length < maxItems) unnamed.push({ role: n.role.value, selector, html });
    }
    return { interactive, unnamed, total: hits.length };
  } finally { await cdp.detach().catch(() => {}); }
}
