// Checks for the perception layer (static, server-HTML part). Browser-only perception ids live in browser.mjs (H3).
// Ids and metadata: src/catalog.json. Thresholds marked "checker heuristic" are ours, not from a standard.
import { pass, warn, fail, info, neutral } from '../core/result.mjs';
import { staticName, describe, outer } from '../core/html.mjs';

/** BCP 47 language tag (RFC 5646), the practical subset: language[-script][-region][-variant...], or x-/i- private tags. */
export const BCP47 = /^(?:[a-z]{2,3}(?:-[a-z]{3}){0,3}|[a-z]{4,8})(?:-[a-z]{4})?(?:-(?:[a-z]{2}|\d{3}))?(?:-(?:[a-z\d]{5,8}|\d[a-z\d]{3}))*(?:-[a-wyz\d](?:-[a-z\d]{2,8})+)*(?:-x(?:-[a-z\d]{1,8})+)?$|^(?:x|i)(?:-[a-z\d]{1,8})+$/i;
const GENERIC_TITLES = /^(home|homepage|home page|untitled|untitled document|index|document|page|new page|welcome|react app|vite app|vite \+ react|my app|app|website|default|loading\.*)$/i;
const TITLE_MAX = 70; // checker heuristic: a common display length for result titles, not a standard

/** Is the element (or an ancestor) hidden from everyone? */
export function isHidden(el) {
  for (let n = el; n && n.tagName; n = n.parentElement) {
    if (n.hasAttribute('hidden') || n.getAttribute('aria-hidden') === 'true') return true;
    if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(n.getAttribute('style') || '')) return true;
    if (n.tagName === 'TEMPLATE') return true;
  }
  return false;
}

/** The server HTML document, or a neutral result when the page is not HTML. */
async function page(ctx) {
  if (!(await ctx.isHtml())) {
    const h = await ctx.home();
    return { skip: neutral(`The page is not HTML (${h.error || `HTTP ${h.status} ${h.contentType || ''}`.trim()}), so there is no markup to inspect.`, { evidence: [h] }) };
  }
  return { doc: await ctx.dom(), home: await ctx.home() };
}

const sample = (els, n = 5) => els.slice(0, n).map((el) => ({ element: describe(el), html: outer(el, 160) }));
const LABELLABLE = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea';
const CLICK_ATTRS = ['onclick', 'ng-click', 'v-on:click', '@click', '(click)', 'data-action', 'data-click', 'hx-get', 'hx-post', 'x-on:click', 'wire:click'];

export default {
  'perception.html-lang': {
    why: 'The lang attribute tells agents and screen readers which language the page is in, so they read, translate and quote it correctly (book chapter 3).',
    fix: { snippet: '<html lang="en">', prompt: 'Set the lang attribute on the <html> element of every page template to the page\'s BCP 47 language tag (for example "en", "nb-NO"), and lang on any inline passage in another language.' },
    async run(ctx) {
      const p = await page(ctx); if (p.skip) return p.skip;
      const lang = p.doc.documentElement?.getAttribute('lang');
      if (lang == null || !lang.trim()) return fail('<html> has no lang attribute.', { evidence: [p.home] });
      if (!BCP47.test(lang.trim())) return warn(`<html lang="${lang}"> is not a valid BCP 47 language tag.`, { evidence: [p.home], details: { lang } });
      return pass(`<html lang="${lang.trim()}"> declares the page language.`, { evidence: [p.home], details: { lang } });
    },
  },

  'perception.title': {
    why: 'The <title> is the first thing an agent reads and the label it uses when it cites or links your page. A missing or generic title makes every page look the same (book chapter 3).',
    fix: { snippet: '<title>Fjellro cabin: 2 bedrooms, sauna, sleeps 6 | Nordlys Cabins</title>', prompt: 'Give every page a unique, descriptive <title> in the server HTML: what the page is first, then the site name, under about 70 characters.' },
    async run(ctx) {
      const p = await page(ctx); if (p.skip) return p.skip;
      const t = (p.doc.querySelector('title')?.textContent || '').replace(/\s+/g, ' ').trim();
      const details = { title: t, length: t.length, maxHeuristic: TITLE_MAX };
      if (!t) return fail('The page has no <title> (or it is empty).', { evidence: [p.home], details });
      if (GENERIC_TITLES.test(t)) return warn(`The title "${t}" is generic; it does not say what this page is.`, { evidence: [p.home], details });
      if (t.length > TITLE_MAX) return warn(`The title is ${t.length} characters; past about ${TITLE_MAX} it is usually cut off (checker heuristic).`, { evidence: [p.home], details });
      return pass(`The title is descriptive: "${t}".`, { evidence: [p.home], details });
    },
  },

  'perception.landmarks': {
    why: 'Landmarks (one <main>, plus header, nav and footer) let an agent jump straight to the content and skip the chrome, the same way screen-reader users do (book chapter 3).',
    fix: { snippet: '<header>...</header>\n<nav aria-label="Main">...</nav>\n<main>...page content...</main>\n<footer>...</footer>', prompt: 'Wrap each page\'s primary content in exactly one <main> element, and use <header>, <nav> and <footer> (or the matching ARIA roles) for the site chrome in the shared layout template.' },
    async run(ctx) {
      const p = await page(ctx); if (p.skip) return p.skip;
      const d = p.doc;
      const count = (sel) => [...d.querySelectorAll(sel)].filter((el) => !isHidden(el)).length;
      const c = { main: count('main, [role="main"]'), nav: count('nav, [role="navigation"]'), header: count('header, [role="banner"]'), footer: count('footer, [role="contentinfo"]') };
      const others = ['nav', 'header', 'footer'].filter((k) => c[k] > 0);
      const details = { counts: c };
      if (!c.main) return fail(`No <main> landmark (found ${others.length ? others.join(', ') : 'no landmarks at all'}).`, { evidence: [p.home], details });
      if (c.main > 1) return warn(`${c.main} visible <main> landmarks; a page should have exactly one.`, { evidence: [p.home], details });
      if (!others.length) return warn('One <main>, but no header, nav or footer landmarks around it.', { evidence: [p.home], details });
      return pass(`One <main> plus ${others.join(', ')}.`, { evidence: [p.home], details });
    },
  },

  'perception.headings': {
    why: 'Headings are the outline an agent uses to find the part of the page it needs. One <h1> naming the page and levels without gaps make that outline reliable (book chapter 3).',
    fix: { snippet: '<h1>Fjellro cabin</h1>\n  <h2>Rooms</h2>\n  <h2>Prices</h2>\n    <h3>High season</h3>', prompt: 'Fix the heading outline in the page templates: exactly one <h1> that names the page, then <h2> for sections and <h3> inside them, without skipping levels. Style with CSS, not by picking heading levels for size.' },
    async run(ctx) {
      const p = await page(ctx); if (p.skip) return p.skip;
      const hs = [...p.doc.querySelectorAll('h1, h2, h3, h4, h5, h6')].filter((h) => !isHidden(h)).map((h) => ({ level: Number(h.tagName[1]), text: h.textContent.replace(/\s+/g, ' ').trim().slice(0, 80) }));
      const h1 = hs.filter((h) => h.level === 1).length;
      const jumps = [];
      for (let i = 1; i < hs.length; i++) if (hs[i].level > hs[i - 1].level + 1) jumps.push(`h${hs[i - 1].level} -> h${hs[i].level} ("${hs[i].text}")`);
      const details = { outline: hs.slice(0, 40), h1, jumps };
      if (!h1) return fail(`No <h1> on the page (${hs.length} other heading(s)).`, { evidence: [p.home], details });
      if (h1 > 1) return warn(`${h1} <h1> elements; one that names the page is clearer.`, { evidence: [p.home], details });
      if (jumps.length) return warn(`The outline skips levels ${jumps.length} time(s), e.g. ${jumps[0]}.`, { evidence: [p.home], details });
      return pass(`One <h1> ("${hs.find((h) => h.level === 1).text}") and ${hs.length - 1} more heading(s) with no skipped levels.`, { evidence: [p.home], details });
    },
  },

  'perception.form-labels': {
    why: 'An agent fills a form by matching field names to what it knows. A field without a label (only a placeholder, or nothing) is a guess, and the guess books the wrong date (book chapter 3).',
    fix: { snippet: '<label for="checkin">Check-in date</label>\n<input id="checkin" name="checkin" type="date" required>', prompt: 'Give every input, select and textarea an accessible name: a <label for> matching its id (preferred), a wrapping <label>, or aria-label/aria-labelledby. Do not rely on placeholder text alone.' },
    async run(ctx) {
      const p = await page(ctx); if (p.skip) return p.skip;
      const els = [...p.doc.querySelectorAll(LABELLABLE)].filter((el) => !isHidden(el));
      if (!els.length) return neutral('The page has no form fields.', { evidence: [p.home] });
      const unnamed = []; const placeholderOnly = [];
      for (const el of els) {
        const name = staticName(el, p.doc);
        const ph = (el.getAttribute('placeholder') || '').trim();
        if (!name) unnamed.push(el);
        else if (ph && name === ph && !(el.getAttribute('title') || '').trim()) placeholderOnly.push(el);
      }
      const details = { fields: els.length, unnamed: sample(unnamed), placeholderOnly: sample(placeholderOnly) };
      if (unnamed.length) return fail(`${unnamed.length} of ${els.length} form field(s) have no accessible name (first: ${describe(unnamed[0])}).`, { evidence: [p.home], details });
      if (placeholderOnly.length) return warn(`${placeholderOnly.length} of ${els.length} field(s) are named only by placeholder text (first: ${describe(placeholderOnly[0])}).`, { evidence: [p.home], details });
      return pass(`All ${els.length} form field(s) have an accessible name.`, { evidence: [p.home], details });
    },
  },

  'perception.control-names': {
    why: 'Agents act on buttons and links by name. An icon-only button with no label is invisible to them: they cannot tell "Book" from "Delete" (book chapter 3).',
    fix: { snippet: '<button type="button" aria-label="Add to favourites"><svg aria-hidden="true">...</svg></button>', prompt: 'Give every button and link visible text or, for icon-only controls, an aria-label (or an <img alt>/<svg><title>) that says what it does. Check the shared components (icon buttons, social links, close buttons) first.' },
    async run(ctx) {
      const p = await page(ctx); if (p.skip) return p.skip;
      const els = [...p.doc.querySelectorAll('button, a[href], [role="button"], [role="link"], input[type="submit"], input[type="button"], input[type="image"]')].filter((el) => !isHidden(el));
      if (!els.length) return neutral('The page has no buttons or links.', { evidence: [p.home] });
      const unnamed = els.filter((el) => !staticName(el, p.doc));
      const details = { controls: els.length, unnamed: sample(unnamed, 8) };
      if (unnamed.length) return fail(`${unnamed.length} of ${els.length} button(s)/link(s) have no accessible name (first: ${outer(unnamed[0], 100)}).`, { evidence: [p.home], details });
      return pass(`All ${els.length} buttons and links have an accessible name.`, { evidence: [p.home], details });
    },
  },

  'perception.click-divs': {
    why: 'A <div> or <span> with a click handler looks like a button to a person but not to an agent: it has no role, no keyboard access and does not show up in the accessibility tree as something to press (book chapter 3).',
    fix: { snippet: '<!-- instead of <div onclick="book()">Book</div> -->\n<button type="button" onclick="book()">Book</button>', prompt: 'Replace clickable <div>/<span> elements with real <button> or <a href> elements (or, if that is impossible, add role="button", tabindex="0" and Enter/Space key handlers). Search the templates for onclick, @click, v-on:click, (click) and ng-click on non-interactive elements.' },
    async run(ctx) {
      const p = await page(ctx); if (p.skip) return p.skip;
      let found = [];
      for (const el of p.doc.querySelectorAll('div, span, li, td, img, section, article, p, i, svg')) {
        if ([...(el.attributes || [])].some((a) => CLICK_ATTRS.includes(a.name.toLowerCase()))) found.push(el);
      }
      found = [...new Set(found)].filter((el) => /^(DIV|SPAN|LI|TD|IMG|SECTION|ARTICLE|P|I|SVG)$/.test(el.tagName.toUpperCase()) && !el.getAttribute('role') && !el.hasAttribute('tabindex') && !isHidden(el));
      const bd = await ctx.browserData();
      const fromBrowser = (bd?.ok && bd.clickables ? bd.clickables : []).filter((c) => /^(div|span|li|td|img|i|svg|p)$/i.test(c.tag) && !c.role && !c.focusable && !c.hasHref);
      const details = { static: sample(found, 8), browser: fromBrowser.slice(0, 8), browserRan: !!bd?.ok };
      if (found.length) return fail(`${found.length} <div>/<span>-style element(s) have click handlers but no role or tabindex (first: ${outer(found[0], 100)}).`, { evidence: [p.home], details });
      if (fromBrowser.length) return warn(`${fromBrowser.length} element(s) look clickable in the browser (click handler or pointer cursor) but have no role or keyboard focus (first: ${fromBrowser[0].selector}).`, { evidence: [p.home], details });
      return pass(bd?.ok ? 'No click-only <div>/<span> controls in the server HTML or the rendered page.' : 'No click-only <div>/<span> controls in the server HTML (handlers added by JavaScript are only visible to the browser run).', { evidence: [p.home], details });
    },
  },

  'perception.img-alt': {
    why: 'Alt text is how an agent knows what an image shows: the cabin photo, the floor plan, the price table saved as a picture. alt="" is right for decoration; a missing alt is a gap (book chapter 3).',
    fix: { snippet: '<img src="/img/fjellro-sauna.jpg" alt="Wood-fired sauna on the Fjellro cabin terrace">\n<img src="/img/divider.svg" alt="">', prompt: 'Add an alt attribute to every <img>: a short description of what the image shows for content images, alt="" for purely decorative ones. Fix it in the image component so new images cannot ship without alt.' },
    async run(ctx) {
      const p = await page(ctx); if (p.skip) return p.skip;
      const imgs = [...p.doc.querySelectorAll('img')].filter((el) => !isHidden(el) && !/^(presentation|none)$/.test(el.getAttribute('role') || ''));
      if (!imgs.length) return neutral('The page has no images in its server HTML.', { evidence: [p.home] });
      const missing = imgs.filter((el) => !el.hasAttribute('alt'));
      const details = { images: imgs.length, missing: missing.length, decorative: imgs.filter((el) => el.getAttribute('alt') === '').length, sample: sample(missing) };
      if (!missing.length) return pass(`All ${imgs.length} image(s) have an alt attribute.`, { evidence: [p.home], details });
      const share = missing.length / imgs.length;
      return (share > 0.5 ? fail : warn)(`${missing.length} of ${imgs.length} image(s) have no alt attribute (first: ${outer(missing[0], 100)}).`, { evidence: [p.home], details });
    },
  },

  'perception.native-forms': {
    why: 'A real <form> with an action and a submit button works for any agent, even without JavaScript, and is what WebMCP declarative tools build on. Inputs wired up only by script are invisible to most agents (book chapter 2).',
    fix: { snippet: '<form action="/search" method="get">\n  <label for="q">Search cabins</label>\n  <input id="q" name="q" type="search">\n  <button type="submit">Search</button>\n</form>', prompt: 'Make the key flows (search, booking, contact, sign-up) real <form> elements with an action and method that work without JavaScript, named inputs, and a submit button; progressively enhance with script afterwards.' },
    async run(ctx) {
      const p = await page(ctx); if (p.skip) return p.skip;
      const forms = [...p.doc.querySelectorAll('form')].filter((f) => !isHidden(f));
      const fields = [...p.doc.querySelectorAll(LABELLABLE)].filter((el) => !isHidden(el));
      const outside = fields.filter((el) => !el.closest('form') && !el.getAttribute('form'));
      if (!forms.length && !fields.length) return neutral('The page has no forms or form fields.', { evidence: [p.home] });
      const rows = forms.map((f) => {
        const submit = !!f.querySelector('button:not([type]), button[type="submit"], input[type="submit"], input[type="image"]');
        const action = f.getAttribute('action'); const method = f.getAttribute('method');
        const named = [...f.querySelectorAll('input, select, textarea')].filter((i) => i.getAttribute('name')).length;
        return { form: describe(f), action, method, submit, namedFields: named, jsOnly: !submit && !action };
      });
      const jsOnly = rows.filter((r) => r.jsOnly);
      const details = { forms: rows, fieldsOutsideForms: outside.length, sampleOutside: sample(outside, 3) };
      if (!forms.length) return fail(`${fields.length} form field(s) but no <form> element: they only work through JavaScript.`, { evidence: [p.home], details });
      if (jsOnly.length) return warn(`${jsOnly.length} of ${forms.length} form(s) have neither an action nor a submit button (JavaScript-only), e.g. ${jsOnly[0].form}.`, { evidence: [p.home], details });
      if (outside.length) return warn(`${forms.length} real form(s), but ${outside.length} field(s) sit outside any <form>.`, { evidence: [p.home], details });
      return pass(`${forms.length} real form(s), each with a submit button or action, and no stray fields.`, { evidence: [p.home], details });
    },
  },

  'perception.server-html': {
    why: 'Many agents and crawlers read the HTML your server sends and never run JavaScript. If the content only appears after scripts run, those agents see an empty shell (book chapter 3).',
    fix: { snippet: '<!-- server-render the content; hydrate afterwards -->\n<main id="app"><h1>Fjellro cabin</h1><p>Sleeps 6, sauna, from NOK 2,400 a night.</p></main>\n<script type="module" src="/app.js"></script>', prompt: 'Render the page content on the server (SSR, static generation or prerendering in the framework in use) so the initial HTML response contains the headings, text, prices and links; keep client-side JavaScript for interactivity only. Verify with curl that the main text is in the raw HTML.' },
    async run(ctx) {
      const p = await page(ctx); if (p.skip) return p.skip;
      const text = await ctx.text();
      const scripts = [...p.doc.querySelectorAll('script')];
      const external = scripts.filter((s) => s.getAttribute('src')).length;
      const inlineBytes = scripts.filter((s) => !s.getAttribute('src')).reduce((n, s) => n + (s.textContent || '').length, 0);
      const shell = !!p.doc.querySelector('#root:empty, #app:empty, #__next:empty, #___gatsby:empty, app-root:empty, #svelte:empty');
      const bd = await ctx.browserData();
      const rendered = bd?.ok && typeof bd.renderedText === 'string' ? bd.renderedText.replace(/\s+/g, ' ').trim() : null;
      const ratio = rendered && rendered.length ? Math.min(1, text.length / rendered.length) : null;
      const details = { serverTextChars: text.length, renderedTextChars: rendered ? rendered.length : null, ratio: ratio == null ? null : Math.round(ratio * 100) / 100, scripts: scripts.length, externalScripts: external, inlineScriptBytes: inlineBytes, emptyAppRoot: shell, heuristic: 'The 200-character floor and the 50% / 20% server-to-rendered ratios are checker heuristics.' };
      const jsHeavy = external > 0 || inlineBytes > 20_000;
      if (text.length < 200 && (jsHeavy || shell)) return fail(`The server HTML carries only ${text.length} characters of text and ${external} script(s)${shell ? ' with an empty app root' : ''}: agents that do not run JavaScript see an empty page.`, { evidence: [p.home], details });
      if (ratio != null && rendered.length >= 200 && ratio < 0.2) return fail(`Only ${Math.round(ratio * 100)}% of the rendered text (${rendered.length} chars) is in the server HTML (${text.length} chars).`, { evidence: [p.home], details });
      if (ratio != null && rendered.length >= 200 && ratio < 0.5) return warn(`About ${Math.round(ratio * 100)}% of the rendered text is in the server HTML; the rest appears only after JavaScript runs.`, { evidence: [p.home], details });
      if (text.length < 200) return info(`The server HTML has little text (${text.length} characters), but no large script bundle either; it may simply be a short page.`, { evidence: [p.home], details });
      return pass(`The server HTML carries the content: ${text.length} characters of visible text${ratio != null ? ` (${Math.round(ratio * 100)}% of the rendered page)` : ''}.`, { evidence: [p.home], details });
    },
  },
};
