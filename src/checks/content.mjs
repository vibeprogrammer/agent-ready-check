// Checks for the content layer: Markdown for agents, llms.txt, Link headers, feeds and caching.
// Ids and metadata: src/catalog.json. isitagentready rules from shared/ref/iia-llms-full.txt (read 3 Nov 2026);
// parts adapted from agent-ready-web-demos (MIT, Maxim Salnikov): chapters/02-your-first-agent-ready-page/agent-ready-check.mjs
// and nordlys-cabins/layers/06-agent-content.
import { pass, warn, fail, info, neutral } from '../core/result.mjs';
import { parseLlms } from '../core/parse/llms.mjs';
import { parseLinkHeader } from '../core/parse/link-header.mjs';
import { HTML_ACCEPT } from '../core/context.mjs';

/** Link relations isitagentready's linkHeaders rule counts as agent-useful (its list ends in "etc."; this is the book's re-implementation list). */
export const AGENT_LINK_RELS = ['api-catalog', 'service-desc', 'service-doc', 'service-meta', 'describedby', 'alternate', 'sitemap', 'ard'];
const FEED_TYPES = /^(application\/(rss|atom|feed)\+(xml|json)|application\/rss\+xml|application\/atom\+xml)$/i;
const MD_TYPES = /^text\/(markdown|x-markdown)$/i;
const LINK_CHECK_MAX = 15;

const md = (ctx) => ctx.memo('content.md', () => ctx.fetch(ctx.url.href, { accept: 'text/markdown', maxBytes: 1_048_576, purpose: 'Markdown negotiation' }));
const mdRoot = (ctx) => (ctx.url.pathname === '/' && !ctx.url.search ? md(ctx) : ctx.memo('content.md.root', () => ctx.fetch('/', { accept: 'text/markdown', maxBytes: 1_048_576, purpose: 'Markdown negotiation (homepage)' })));
const isMd = (ex) => ex.ok && MD_TYPES.test(ex.contentType);
const looksHtml = (t) => /^\s*<(!doctype|html|head|body)\b/i.test(t);
const varyAccept = (ex) => /(^|,)\s*(accept|\*)\s*(,|$)/i.test(ex.headers?.vary || '');
const llms = (ctx) => ctx.memo('content.llms', async () => {
  const ex = await ctx.fetch('/llms.txt', { accept: 'text/markdown, text/plain;q=0.9, */*;q=0.5', maxBytes: 1_048_576, purpose: 'llms.txt' });
  const text = ex.ok && !/html/.test(ex.contentType) && !looksHtml(ex.text);
  return { ex, ok: text, parsed: text ? parseLlms(ex.text, ex.finalUrl) : null };
});

/** The most frequent content words of a text (5+ letters), for a rough Markdown-vs-HTML comparison. */
export function keyTerms(text, n = 30) {
  const counts = new Map();
  for (const w of String(text).toLowerCase().normalize('NFKC').match(/\p{L}{5,}/gu) || []) counts.set(w, (counts.get(w) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w);
}

export default {
  'content.markdown-negotiation': {
    why: 'Markdown is the cheapest way for an agent to read a page: no navigation, scripts or markup, often 80% fewer tokens. Content negotiation serves it from the same URL, and isitagentready needs it for Level 3 (book chapter 6).',
    fix: { snippet: '// Express-style middleware\napp.get("*", (req, res, next) => {\n  res.vary("Accept");\n  if (req.accepts(["text/html", "text/markdown"]) === "text/markdown") {\n    return res.type("text/markdown; charset=utf-8").send(toMarkdown(req.path));\n  }\n  next();\n});', prompt: 'Add content negotiation for Markdown: when a request\'s Accept header prefers text/markdown, return a Markdown version of the same page with Content-Type: text/markdown; charset=utf-8 and Vary: Accept; browsers keep getting HTML. Verify with curl -H "Accept: text/markdown".' },
    async run(ctx) {
      const [ex, root] = await Promise.all([md(ctx), mdRoot(ctx)]);
      const compat = root.ok && /^text\/markdown/.test(root.contentType) ? { status: 'pass', message: 'Accept: text/markdown on / returns text/markdown' } : { status: 'fail', message: `Accept: text/markdown on / returns ${root.contentType || `HTTP ${root.status || root.error}`}` };
      const ev = ex === root ? [ex] : [ex, root];
      const details = { status: ex.status, contentType: ex.contentType, bytes: ex.bytes };
      if (isMd(ex)) return pass(`Accept: text/markdown returns ${ex.contentType} (${ex.bytes} bytes).`, { evidence: ev, details, compat });
      if (ex.ok && ex.contentType === 'text/plain' && !looksHtml(ex.text) && /^#{1,6}\s/m.test(ex.text)) return warn('Accept: text/markdown returns Markdown text but labelled text/plain; agents and isitagentready look for text/markdown.', { evidence: ev, details, compat });
      return fail(`Accept: text/markdown returns ${ex.contentType || 'nothing'}${ex.status ? ` (HTTP ${ex.status})` : ex.error ? ` (${ex.error})` : ''}, not Markdown.`, { evidence: ev, details, compat });
    },
  },

  'content.markdown-vary': {
    why: 'When one URL serves HTML and Markdown, caches must know the answer depends on Accept. Without Vary: Accept a CDN can hand Markdown to a browser or HTML to an agent (book chapter 6).',
    fix: { snippet: 'Vary: Accept', prompt: 'Add "Vary: Accept" to both the HTML and the Markdown responses of every negotiated URL (merge with any existing Vary values such as Accept-Encoding), then check both with curl -I.' },
    async run(ctx) {
      const [ex, home] = await Promise.all([md(ctx), ctx.home()]);
      if (!isMd(ex)) return neutral('The page does not negotiate Markdown, so Vary: Accept is not needed.', { evidence: [ex] });
      const both = { html: varyAccept(home), markdown: varyAccept(ex) };
      const details = { htmlVary: home.headers?.vary || null, markdownVary: ex.headers?.vary || null };
      if (both.html && both.markdown) return pass('Both the HTML and the Markdown responses send Vary with Accept.', { evidence: [home, ex], details });
      if (both.html || both.markdown) return warn(`Only the ${both.html ? 'HTML' : 'Markdown'} response sends Vary: Accept; the ${both.html ? 'Markdown' : 'HTML'} one does not, so a shared cache can mix them up.`, { evidence: [home, ex], details });
      return fail('Markdown is negotiated, but neither response sends Vary: Accept, so shared caches can serve the wrong format.', { evidence: [home, ex], details });
    },
  },

  'content.markdown-quality': {
    why: 'Negotiated "Markdown" that is really HTML, or a stub without the page content, gives agents less than the HTML did (book chapter 6).',
    fix: { snippet: '# Fjellro cabin\n\nTwo-bedroom cabin with a wood-fired sauna. Sleeps 6.\n\n## Prices\n\n- High season: NOK 2,400 per night', prompt: 'Make the Markdown representation a faithful conversion of the page\'s main content (not its navigation): start with an H1, keep headings, lists, links, prices and dates, and do not wrap HTML in it. Compare it with the HTML page in a test.' },
    async run(ctx) {
      const ex = await md(ctx);
      if (!isMd(ex) && !(ex.ok && ex.contentType === 'text/plain' && /^#{1,6}\s/m.test(ex.text))) return neutral('No negotiated Markdown to inspect.', { evidence: [ex] });
      const body = ex.text;
      const html = await ctx.text();
      const terms = keyTerms(html);
      const mdLower = body.toLowerCase().normalize('NFKC');
      const shared = terms.filter((t) => mdLower.includes(t));
      const overlap = terms.length ? Math.round((100 * shared.length) / terms.length) : null;
      const heading = /^#{1,6}\s+\S/m.test(body);
      const htmlTags = (body.match(/<(div|span|script|style|nav|header|footer)\b/gi) || []).length;
      const details = { bytes: ex.bytes, heading, htmlTags, keyTerms: terms.length, shared: shared.length, overlap, heuristic: 'Key terms are the 30 most frequent 5+ letter words of the HTML text; the 50% line is a checker heuristic.' };
      if (looksHtml(body)) return fail('The "Markdown" response is an HTML document.', { evidence: [ex], details });
      if (htmlTags > 20) return warn(`The Markdown carries ${htmlTags} raw HTML tags (div/span/script/nav...).`, { evidence: [ex], details });
      if (overlap != null && terms.length >= 10 && overlap < 50) return warn(`The Markdown shares only ${overlap}% of the page's key terms; it may be a stub or a different page.`, { evidence: [ex], details });
      if (!heading) return warn('The Markdown has no heading; start it with "# <page title>".', { evidence: [ex], details });
      return pass(`The Markdown is real Markdown with headings${overlap != null ? ` and ${overlap}% of the page's key terms` : ''} (${ex.bytes} bytes).`, { evidence: [ex], details });
    },
  },

  'content.markdown-alternate': {
    why: 'A <link rel="alternate" type="text/markdown"> (or Link header) points agents to the page\'s Markdown twin, for those that do not send Accept: text/markdown (book chapter 6).',
    fix: { snippet: '<link rel="alternate" type="text/markdown" href="/cabins/fjellro.md">\n# or as a header\nLink: </cabins/fjellro.md>; rel="alternate"; type="text/markdown"', prompt: 'Publish a Markdown twin for each page (for example <path>.md) and advertise it with <link rel="alternate" type="text/markdown" href="..."> in the head and/or a Link response header; serve it as text/markdown.' },
    async run(ctx) {
      const alt = (await ctx.links()).filter((l) => l.rel === 'alternate' && MD_TYPES.test(l.type || ''));
      if (!alt.length) {
        const neg = await md(ctx);
        return (isMd(neg) ? warn : fail)(`No rel=alternate link to a Markdown version${isMd(neg) ? ' (Markdown negotiation works, so this is only a second route)' : ''}.`, { evidence: [await ctx.home()] });
      }
      const ex = await ctx.fetch(alt[0].href, { accept: 'text/markdown, text/plain;q=0.9, */*;q=0.5', purpose: 'Markdown alternate' });
      const details = { href: alt[0].href, source: alt[0].source, status: ex.status, contentType: ex.contentType };
      if (!ex.ok) return fail(`The Markdown alternate ${alt[0].href} answers ${ex.error || `HTTP ${ex.status}`}.`, { evidence: [ex], details });
      if (looksHtml(ex.text) || /html/.test(ex.contentType)) return fail(`The Markdown alternate ${alt[0].href} serves HTML.`, { evidence: [ex], details });
      if (!/^text\/(markdown|x-markdown|plain)$/.test(ex.contentType)) return warn(`The Markdown alternate is served as ${ex.contentType || 'no content type'}; use text/markdown.`, { evidence: [ex], details });
      return pass(`The page links its Markdown twin (${alt[0].href}, ${ex.contentType}).`, { evidence: [ex], details });
    },
  },

  'content.llms-txt': {
    why: 'llms.txt is a short Markdown map of the site for language models: what it is and where the important pages are. It is a proposal, not a standard, and cheap to publish (book chapter 6).',
    fix: { snippet: '# Nordlys Cabins\n\n> Six holiday cabins in Norway you can book directly. Prices in NOK.\n\n## Cabins\n\n- [Fjellro](https://example.com/cabins/fjellro.md): Hemsedal, sleeps 6\n\n## Optional\n\n- [Sitemap](https://example.com/sitemap.xml)', prompt: 'Publish /llms.txt as text/markdown (or text/plain): one H1 with the site name, a one-line blockquote summary, then H2 sections listing the key pages as "- [name](absolute URL): one-line note". Generate it from the same data as the sitemap.' },
    async run(ctx) {
      const l = await llms(ctx);
      const ex = l.ex;
      if (l.ok) return pass(`/llms.txt is published (${ex.bytes} bytes, ${ex.contentType || 'no content type'}).`, { evidence: [ex], details: { bytes: ex.bytes, contentType: ex.contentType } });
      if (ex.ok) return fail(`/llms.txt answers 200 but with HTML (${ex.contentType || 'no type'}), usually a soft-404 page.`, { evidence: [ex] });
      return fail(`/llms.txt is not published (${ex.error || `HTTP ${ex.status}`}).`, { evidence: [ex] });
    },
  },

  'content.llms-txt-format': {
    why: 'Lighthouse\'s llms-txt audit fails a file without an H1, without a Markdown link or under 50 characters; the llms.txt proposal also expects a blockquote summary and H2 sections of links (book chapter 6).',
    fix: { snippet: '# Site name\n\n> One-sentence summary of the site.\n\n## Docs\n\n- [Getting started](https://example.com/start.md): first steps', prompt: 'Restructure /llms.txt: exactly one "# " H1 first, a "> " summary line, then "## " sections each listing links as "- [name](URL): note". Keep it over 50 characters and make every link absolute.' },
    async run(ctx) {
      const l = await llms(ctx);
      const ex = l.ex;
      if (!l.ok) {
        if (ex.status >= 400 && ex.status < 500 && ex.status !== 429) return neutral(`No /llms.txt (HTTP ${ex.status}); Lighthouse treats that as not applicable.`, { evidence: [ex] });
        if (ex.ok) return fail('/llms.txt is served as HTML, not a Markdown text file.', { evidence: [ex] });
        return fail(`/llms.txt could not be read (${ex.error || `HTTP ${ex.status}`}).`, { evidence: [ex] });
      }
      const p = l.parsed;
      const lh = [!p.h1 && 'no H1', !p.links.length && 'no Markdown link', p.chars < 50 && `only ${p.chars} characters`].filter(Boolean);
      const v2 = [p.h1Count > 1 && `${p.h1Count} H1 headings`, !p.summary && 'no "> " summary', !p.sections.length && 'no "## " sections', p.sections.length && !p.sections.some((s) => s.links.length) && 'sections have no link lists'].filter(Boolean);
      const details = { h1: p.h1, summary: p.summary, sections: p.sections.map((s) => ({ title: s.title, links: s.links.length })), links: p.links.length, chars: p.chars, lighthouse: lh.length ? 'fail' : 'pass' };
      if (lh.length) return fail(`/llms.txt fails the Lighthouse rules: ${lh.join(', ')}.`, { evidence: [ex], details });
      if (v2.length) return warn(`/llms.txt passes Lighthouse (H1 "${p.h1}", ${p.links.length} links) but misses parts of the proposal: ${v2.join(', ')}.`, { evidence: [ex], details });
      return pass(`/llms.txt is well formed: H1 "${p.h1}", a summary, ${p.sections.length} section(s), ${p.links.length} link(s).`, { evidence: [ex], details });
    },
  },

  'content.llms-txt-links': {
    why: 'llms.txt is only useful if its links work. A model that follows a dead link from it learns nothing, or learns your 404 page (book chapter 6).',
    fix: { snippet: '// in CI: fail the build when an llms.txt link breaks\nfor (const url of links) { const r = await fetch(url, { method: "HEAD" }); if (!r.ok) throw new Error(url); }', prompt: 'Generate /llms.txt from the live route list so it only links pages that exist, use absolute URLs, and add a CI step that requests every link in llms.txt and fails on any 4xx/5xx.' },
    async run(ctx) {
      const l = await llms(ctx);
      if (!l.ok) return neutral('No /llms.txt, so no links to check.', { evidence: [l.ex] });
      const urls = [...new Set(l.parsed.links.map((x) => x.url).filter((u) => /^https?:\/\//i.test(u)))];
      if (!urls.length) return neutral('/llms.txt has no absolute http(s) links to check.', { evidence: [l.ex] });
      const picked = []; const skipped = [];
      for (const u of urls) { if (picked.length >= LINK_CHECK_MAX) break; if (await ctx.mayCrawl(u)) picked.push(u); else skipped.push(u); }
      const results = await Promise.all(picked.map(async (u) => {
        let ex = await ctx.fetch(u, { method: 'HEAD', purpose: 'llms.txt link check' });
        if ([403, 405, 501].includes(ex.status) || (ex.error && ex.errorCode !== 'budget')) ex = await ctx.fetch(u, { maxBytes: 32_768, purpose: 'llms.txt link check (GET)' });
        return { url: u, status: ex.status, error: ex.error, ok: ex.status >= 200 && ex.status < 400, ex };
      }));
      const budget = results.filter((r) => r.ex.errorCode === 'budget');
      const done = results.filter((r) => r.ex.errorCode !== 'budget');
      const broken = done.filter((r) => !r.ok);
      const details = { totalLinks: urls.length, checked: done.length, skippedByRobots: skipped.length, budgetSkipped: budget.length, broken: broken.map((r) => ({ url: r.url, status: r.status, error: r.error })) };
      const ev = broken.slice(0, 5).map((r) => r.ex).concat(l.ex);
      if (!done.length) return neutral('No llms.txt links could be checked (robots.txt or the request budget).', { evidence: [l.ex], details });
      const of = `${done.length}${urls.length > done.length ? ` checked of ${urls.length}` : ''}`;
      if (broken.length * 2 > done.length) return fail(`${broken.length} of ${of} llms.txt link(s) are broken (first: ${broken[0].url} -> ${broken[0].error || broken[0].status}).`, { evidence: ev, details });
      if (broken.length) return warn(`${broken.length} of ${of} llms.txt link(s) are broken (first: ${broken[0].url} -> ${broken[0].error || broken[0].status}).`, { evidence: ev, details });
      return pass(`All ${of} llms.txt link(s) resolve.`, { evidence: [l.ex], details });
    },
  },

  'content.llms-full': {
    why: 'llms-full.txt bundles the full text of the important pages into one file, so an agent can load your docs in one request. It is an optional convention (book chapter 6).',
    fix: { snippet: '# Nordlys Cabins (full)\n\n## Fjellro cabin\n\nTwo-bedroom cabin with a wood-fired sauna...', prompt: 'Optionally publish /llms-full.txt: the Markdown of every page listed in llms.txt concatenated under its H2, served as text/markdown or text/plain; keep it under a few MB.' },
    async run(ctx) {
      const ex = await ctx.fetch('/llms-full.txt', { accept: 'text/markdown, text/plain;q=0.9, */*;q=0.5', maxBytes: 524_288, purpose: 'llms-full.txt' });
      if (ex.ok && !/html/.test(ex.contentType) && !looksHtml(ex.text)) {
        const size = ex.truncated ? `more than ${Math.round(ex.bytes / 1024)} KB` : `${Math.max(1, Math.round(ex.bytes / 1024))} KB`;
        const len = ex.headers['content-length'];
        return pass(`/llms-full.txt is published (${len ? `${Math.round(Number(len) / 1024)} KB` : size}).`, { evidence: [ex], details: { bytes: ex.bytes, contentLength: len ? Number(len) : null, truncated: ex.truncated } });
      }
      return info(`No /llms-full.txt (${ex.ok ? 'HTML soft-404' : ex.error || `HTTP ${ex.status}`}). It is optional.`, { evidence: [ex] });
    },
  },

  'content.link-headers': {
    why: 'Link response headers let an agent find your API catalog, docs, sitemap or Markdown twin from a single HEAD request, before parsing any HTML. isitagentready counts them for Level 1 (book chapter 6).',
    fix: { snippet: 'Link: </.well-known/api-catalog>; rel="api-catalog", </sitemap.xml>; rel="sitemap", </index.md>; rel="alternate"; type="text/markdown", </llms.txt>; rel="describedby"', prompt: 'Add a Link response header to the homepage (and ideally every page) pointing agents to the useful resources the site has: rel="api-catalog" for /.well-known/api-catalog, rel="service-desc" for the OpenAPI file, rel="sitemap", rel="alternate" type="text/markdown" for the Markdown twin, rel="describedby" for llms.txt.' },
    async run(ctx) {
      const [home, root] = await Promise.all([ctx.home(), ctx.root()]);
      const rootRels = parseLinkHeader(root.headers?.link, root.finalUrl).map((l) => l.rel);
      const usefulRoot = [...new Set(rootRels.filter((r) => AGENT_LINK_RELS.includes(r)))];
      const compat = usefulRoot.length ? { status: 'pass', message: `Link rels on /: ${usefulRoot.join(', ')}` } : { status: 'fail', message: 'no agent-useful Link header on /' };
      const links = await ctx.links();
      const headerRels = [...new Set(links.filter((l) => l.source === 'header').map((l) => l.rel))];
      const useful = headerRels.filter((r) => AGENT_LINK_RELS.includes(r));
      const htmlUseful = [...new Set(links.filter((l) => l.source === 'html' && AGENT_LINK_RELS.includes(l.rel)).map((l) => l.rel))];
      const ev = home === root ? [home] : [home, root];
      const details = { headerRels, useful, htmlOnly: htmlUseful.filter((r) => !useful.includes(r)) };
      if (useful.length) return pass(`The Link header points agents to: ${useful.join(', ')}.`, { evidence: ev, details, compat });
      if (htmlUseful.length) return warn(`Agent-useful links exist only as HTML <link> elements (${htmlUseful.join(', ')}), not as a Link response header.`, { evidence: ev, details, compat });
      return fail(headerRels.length ? `The Link header has only ${headerRels.join(', ')}, none of them agent-useful.` : 'No Link response header.', { evidence: ev, details, compat });
    },
  },

  'content.feeds': {
    why: 'RSS, Atom or JSON Feed tell agents what is new without crawling the whole site. Worth having when the site publishes articles or updates (book chapter 6).',
    fix: { snippet: '<link rel="alternate" type="application/atom+xml" title="Guides" href="/guide/feed.xml">', prompt: 'If the site publishes articles or updates, publish an Atom or RSS feed (or JSON Feed) of the latest items with absolute links and dates, and advertise it with <link rel="alternate" type="application/atom+xml" href="..."> in the page head.' },
    async run(ctx) {
      const feeds = (await ctx.links()).filter((l) => l.rel === 'alternate' && FEED_TYPES.test(l.type || ''));
      if (!feeds.length) return info('No feed is advertised (rel=alternate RSS/Atom/JSON Feed). Only matters if the site publishes articles or updates.', { evidence: [await ctx.home()] });
      const ex = await ctx.fetch(feeds[0].href, { accept: `${feeds[0].type}, application/xml;q=0.9, */*;q=0.5`, purpose: 'feed' });
      const t = ex.text.slice(0, 4000);
      let kind = null;
      if (/<rss[\s>]/i.test(t)) kind = 'RSS'; else if (/<feed[\s>]/i.test(t)) kind = 'Atom';
      else { try { const j = JSON.parse(ex.text); if (/jsonfeed\.org\/version/.test(j.version || '')) kind = 'JSON Feed'; } catch { /* not JSON */ } }
      const details = { feeds: feeds.map((f) => ({ href: f.href, type: f.type, title: f.title })), status: ex.status, kind };
      if (!ex.ok) return warn(`The advertised feed ${feeds[0].href} answers ${ex.error || `HTTP ${ex.status}`}.`, { evidence: [ex], details });
      if (!kind) return warn(`The advertised feed ${feeds[0].href} is not RSS, Atom or JSON Feed.`, { evidence: [ex], details });
      return pass(`${feeds.length} feed(s) advertised; ${feeds[0].href} is valid ${kind}.`, { evidence: [ex], details });
    },
  },

  'content.caching': {
    why: 'ETag or Last-Modified plus 304 answers let agents and crawlers re-check a page for the cost of a header, so they can come back often without loading your server (book chapter 6).',
    fix: { snippet: 'ETag: "v42-fjellro"\nLast-Modified: Mon, 02 Nov 2026 10:00:00 GMT\nCache-Control: public, max-age=300\n# and answer If-None-Match / If-Modified-Since with 304 Not Modified', prompt: 'Make page responses cacheable for revalidation: send a strong ETag (content hash) or Last-Modified header, honour If-None-Match / If-Modified-Since with 304 Not Modified, and set a sensible Cache-Control. Verify with curl -I -H \'If-None-Match: "<etag>"\'.' },
    async run(ctx) {
      const home = await ctx.home();
      if (!home.ok) return neutral(`The page answered ${home.error || `HTTP ${home.status}`}.`, { evidence: [home] });
      const etag = home.headers.etag; const lm = home.headers['last-modified'];
      const details = { etag: etag || null, lastModified: lm || null, cacheControl: home.headers['cache-control'] || null };
      if (!etag && !lm) return fail('The page sends neither ETag nor Last-Modified, so every revisit downloads it again.', { evidence: [home], details });
      const headers = etag ? { 'if-none-match': etag } : { 'if-modified-since': lm };
      const cond = await ctx.fetch(home.finalUrl, { accept: HTML_ACCEPT, headers, memo: false, maxBytes: 65_536, purpose: 'conditional request' });
      details.conditionalStatus = cond.status;
      if (cond.status === 304) return pass(`The page sends ${etag ? 'an ETag' : 'Last-Modified'} and answers a conditional request with 304 Not Modified.`, { evidence: [home, cond], details });
      return warn(`The page sends ${etag ? 'an ETag' : 'Last-Modified'}, but a conditional request got HTTP ${cond.status || cond.error} instead of 304.`, { evidence: [home, cond], details });
    },
  },
};
