// Browser-only checks from several layers (owner: H3): they read browserData from src/browser/collect.mjs.
// The engine marks them "skipped" when no browser ran (catalog requires: browser).
import { pass, warn, fail, error } from '../core/result.mjs';

const tokens = (s) => new Set(String(s || '').toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]{3,}/gu) || []);
const NATIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'option', 'label']);
const WIDGET_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'switch', 'option', 'treeitem', 'slider', 'spinbutton', 'combobox']);

async function bd(ctx) {
  const b = await ctx.browserData();
  return b?.ok ? b : null;
}
const noBrowser = async (ctx) => {
  const b = await ctx.browserData();
  return error(`The browser run failed: ${b?.error || 'no browser data'}.`);
};

export default {
  'perception.rendered-parity': {
    why: 'Many agents and crawlers read only the server HTML. If the rendered page says much more than the HTML the server sends, those agents miss it (book chapter 3).',
    fix: {
      snippet: '<!-- Render the content on the server; hydrate on the client -->\n<main>\n  <h1>Fjellro cabin</h1>\n  <p>Sleeps 4, sauna, from NOK 1,850 per night.</p>\n</main>',
      prompt: 'Make the server HTML of this page carry the same main content the browser shows: render headings, text, prices and links on the server (SSR or static generation) and let client JavaScript only enhance it. Verify with curl that the key sentences are in the raw HTML.',
    },
    async run(ctx) {
      const b = await bd(ctx); if (!b) return noBrowser(ctx);
      const rendered = tokens(b.renderedText);
      const server = tokens(await ctx.text());
      if (rendered.size < 30) return pass(`The rendered page has little text (${rendered.size} distinct words), so there is nothing significant missing from the server HTML.`, { details: { rendered: rendered.size, server: server.size } });
      let shared = 0; const missing = [];
      for (const t of rendered) { if (server.has(t)) shared++; else if (missing.length < 25) missing.push(t); }
      const share = shared / rendered.size;
      const pct = Math.round(share * 100);
      const details = { share: Math.round(share * 1000) / 1000, renderedWords: rendered.size, serverWords: server.size, missingSample: missing, heuristic: 'distinct-word overlap; warn < 70 %, fail < 30 %' };
      const msg = `${pct} % of the ${rendered.size} distinct words on the rendered page are already in the server HTML.`;
      if (share < 0.3) return fail(`${msg} Agents that do not run JavaScript see little of this page.`, { details });
      if (share < 0.7) return warn(`${msg} Part of the content only appears after JavaScript runs.`, { details });
      return pass(msg, { details });
    },
  },

  'perception.axe-agent-rules': {
    why: 'Agents read the page through the accessibility tree. Lighthouse\'s agent-accessibility-tree audit runs 33 axe rules (names, labels, valid ARIA) and fails on any violation (book chapter 3).',
    fix: {
      snippet: '<button aria-label="Close dialog">×</button>\n<label for="email">Email</label> <input id="email" name="email" type="email" autocomplete="email">\n<a href="/cabins/fjellro">Fjellro cabin details</a>',
      prompt: 'Fix every violation of these axe-core rules on this page: give buttons and links an accessible name (text or aria-label), label every form field, use only valid ARIA roles and attributes, and keep aria-hidden content out of the tab order. Verify with axe-core runOnly on the 33 Lighthouse agent rules, or Lighthouse Agentic Browsing agent-accessibility-tree.',
    },
    async run(ctx) {
      const b = await bd(ctx); if (!b) return noBrowser(ctx);
      const axe = b.axe || {};
      if (axe.error) return error(`axe-core could not run on this page: ${axe.error}`);
      const v = axe.violations || [];
      const details = { axe: axe.version, rules: (axe.rules || []).length, violations: v, incomplete: (axe.incomplete || []).map((i) => i.id), passed: axe.passes || [] };
      if (!v.length) return pass(`All ${(axe.rules || []).length || 33} agent-relevant axe rules pass (axe-core ${axe.version}; ${(axe.passes || []).length} applied, the rest had nothing to test).`, { details });
      const nodes = v.reduce((s, x) => s + (x.count || x.nodes?.length || 0), 0);
      return fail(`${v.length} of the 33 agent axe rules fail on ${nodes} element(s): ${v.slice(0, 5).map((x) => `${x.id} (${x.count || x.nodes.length})`).join(', ')}.`, { details });
    },
  },

  'perception.a11y-tree': {
    why: 'An agent can only act on a control it can find by role and name. An unnamed button in the accessibility tree is a button an agent has to guess about (book chapter 3).',
    fix: {
      snippet: '<button type="button" aria-label="Next photo"><svg aria-hidden="true">…</svg></button>',
      prompt: 'Give every interactive element on this page an accessible name: visible text, aria-label or aria-labelledby for icon buttons and links, and <label> for form fields. Verify in Chrome DevTools > Accessibility pane or with a Playwright ariaSnapshot that no button, link or textbox is unnamed.',
    },
    async run(ctx) {
      const b = await bd(ctx); if (!b) return noBrowser(ctx);
      const a = b.a11y || {};
      if (a.error) return error(`The accessibility tree could not be read: ${a.error}`);
      const total = a.total ?? (a.interactive || []).length;
      const unnamed = a.unnamed || [];
      const details = { interactive: total, unnamed, sample: (a.interactive || []).slice(0, 30), heuristic: 'pass when all are named, warn at 90 % or more, fail below' };
      if (!total) return pass('The accessibility tree has no interactive elements to name.', { details });
      const share = (total - unnamed.length) / total;
      const msg = `${total - unnamed.length} of ${total} interactive elements in the accessibility tree have a name.`;
      if (!unnamed.length) return pass(msg, { details });
      const list = unnamed.slice(0, 4).map((u) => `${u.role} ${u.selector}`).join(', ');
      if (share >= 0.9) return warn(`${msg} Unnamed: ${list}.`, { details });
      return fail(`${msg} Unnamed: ${list}.`, { details });
    },
  },

  'perception.focusable-controls': {
    why: 'Custom controls built from divs with click handlers cannot be reached from the keyboard, and agents that drive the page by focus and key presses cannot use them (book chapter 3).',
    fix: {
      snippet: '<!-- Before: <div class="btn" onclick="book()">Book</div> -->\n<button type="button" class="btn" onclick="book()">Book</button>',
      prompt: 'Replace click-only <div>/<span> controls on this page with native <button> or <a href> elements. Where that is impossible, add role="button", tabindex="0" and a keydown handler for Enter and Space. Verify by tabbing through the page: every control receives focus.',
    },
    async run(ctx) {
      const b = await bd(ctx); if (!b) return noBrowser(ctx);
      const cands = (b.clickables || []).filter((c) => !c.native && !NATIVE_TAGS.has(c.tag) && !c.inNative && (c.listener || WIDGET_ROLES.has(c.role)));
      const bad = cands.filter((c) => !c.focusable);
      const details = { custom: cands.length, notFocusable: bad.slice(0, 30), note: 'Elements with click listeners (recorded from addEventListener and onclick) or widget roles, outside native controls. Listeners delegated to a parent are not seen.' };
      if (!bad.length) return pass(cands.length ? `All ${cands.length} custom clickable element(s) are keyboard-focusable.` : 'No custom click-only controls found: interactive elements are native.', { details });
      return fail(`${bad.length} of ${cands.length} custom clickable element(s) cannot get keyboard focus: ${bad.slice(0, 4).map((c) => `${c.selector}${c.text ? ` ("${c.text.slice(0, 30)}")` : ''}`).join(', ')}.`, { details });
    },
  },

  'privacy.consent-overlay': {
    why: 'A consent wall that covers the page blocks agents the same way it blocks people, and agents should not click "accept" on someone\'s behalf. Keep the content readable behind a banner (book chapter 17).',
    fix: {
      snippet: '<!-- A banner that leaves the content readable -->\n<aside class="consent" aria-label="Cookie choices" style="position:fixed;bottom:0;max-height:25vh">\n  <p>We use cookies for analytics.</p><button>Accept</button> <button>Reject</button>\n</aside>',
      prompt: 'Change the cookie/consent UI on this page so it does not cover more than about a quarter of the viewport, does not lock scrolling, and leaves the main content in the DOM and readable before any choice is made. Verify with a headless browser screenshot without clicking anything.',
    },
    async run(ctx) {
      const b = await bd(ctx); if (!b) return noBrowser(ctx);
      const ov = b.consent?.overlays || [];
      const details = { overlays: ov, heuristic: 'fixed/sticky element with consent words; warn above 30 % of the viewport, fail above 60 % or with scrolling locked' };
      if (!ov.length) return pass('No fixed consent banner or wall covers the page on load.', { details });
      const big = ov.reduce((m, o) => (o.coverage > m.coverage ? o : m), ov[0]);
      const pct = Math.round(big.coverage * 100);
      if (big.coverage > 0.6 || (big.coverage > 0.3 && big.blocksScroll)) return fail(`A consent overlay (${big.selector}) covers ${pct} % of the viewport${big.blocksScroll ? ' and locks scrolling' : ''} until someone clicks.`, { details });
      if (big.coverage > 0.3) return warn(`A consent banner (${big.selector}) covers ${pct} % of the viewport on load.`, { details });
      return pass(`A consent banner is shown (${big.selector}, ${pct} % of the viewport) but leaves the content readable.`, { details });
    },
  },

  'performance.cls': {
    why: 'Agents that click by position or screenshot misfire when the layout jumps after they look. Lighthouse includes CLS in the Agentic Browsing category; web.dev rates 0.1 or less as good (book chapter 3).',
    fix: {
      snippet: '<img src="/cabin.jpg" width="1200" height="800" alt="Fjellro cabin">\n<div class="ad-slot" style="min-height:250px"></div>',
      prompt: 'Reduce Cumulative Layout Shift on this page below 0.1: give images, videos and iframes width and height (or aspect-ratio), reserve space for ads, banners and late-loading content with min-height, and avoid inserting content above existing content after load. Verify with Lighthouse or a PerformanceObserver for layout-shift.',
    },
    async run(ctx) {
      const b = await bd(ctx); if (!b) return noBrowser(ctx);
      const c = b.cls || {};
      if (typeof c.value !== 'number') return error('Layout shifts could not be measured in this browser.');
      const details = { value: c.value, shifts: (c.shifts || []).slice(0, 10), observedMs: c.observedMs, thresholds: 'good <= 0.1, poor > 0.25 (web.dev)' };
      const msg = `CLS is ${c.value.toFixed(3)} over ${Math.round((c.observedMs || 0) / 100) / 10} s after load`;
      const src = [...new Set((c.shifts || []).flatMap((s) => s.sources || []))].slice(0, 3);
      if (c.value > 0.25) return fail(`${msg} (poor, over 0.25)${src.length ? `; shifting: ${src.join(', ')}` : ''}.`, { details });
      if (c.value > 0.1) return warn(`${msg} (needs improvement, over 0.1)${src.length ? `; shifting: ${src.join(', ')}` : ''}.`, { details });
      return pass(`${msg} (good, 0.1 or less).`, { details });
    },
  },
};
