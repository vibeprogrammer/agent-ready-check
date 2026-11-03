// Checks for the performance layer (HTTP part). performance.cls is browser-only and lives in browser.mjs (H3).
// Ids and metadata: src/catalog.json.
import { pass, warn, fail, info, neutral, error } from '../core/result.mjs';

// web.dev "Time to First Byte (TTFB)" (https://web.dev/articles/ttfb, read 3 Nov 2026):
// "Good TTFB values are 0.8 seconds or less, and poor values are greater than 1.8 seconds."
export const TTFB_GOOD_MS = 800;
export const TTFB_POOR_MS = 1800;
// Google Search Central, "Googlebot" (https://developers.google.com/search/docs/crawling-indexing/googlebot, read 3 Nov 2026):
// "When crawling for Google Search, Googlebot crawls the first 2MB of a supported file type"; Google's crawlers in general
// fetch "up to 15MB of HTML or text-based files".
export const GOOGLEBOT_SEARCH_BYTES = 2 * 1024 * 1024;
export const GOOGLE_CRAWLER_BYTES = 15 * 1024 * 1024;
const CODINGS = /\b(gzip|br|zstd|deflate|x-gzip)\b/i;

export default {
  'performance.ttfb': {
    why: 'Agents run on timeouts and budgets. A slow first byte makes every page, Markdown twin and well-known file slower to fetch, and some agents give up (book chapter 19).',
    fix: { snippet: 'Cache-Control: public, max-age=60, stale-while-revalidate=600\n# cache rendered HTML at the edge/CDN; avoid blocking work before the first byte', prompt: 'Reduce time to first byte on the homepage: cache the rendered HTML (CDN or server cache with stale-while-revalidate), move slow data fetching out of the critical path, and check the server region; target 0.8 s or less (web.dev), measured with curl -w "%{time_starttransfer}".' },
    async run(ctx) {
      const h = await ctx.home();
      if (h.error || !h.status) return error(`The page could not be fetched (${h.error || 'no response'}).`, { evidence: [h] });
      const t = h.ttfb;
      const details = { ttfbMs: t, totalMs: h.ms, goodMs: TTFB_GOOD_MS, poorMs: TTFB_POOR_MS, source: 'https://web.dev/articles/ttfb', note: 'One sample from the checker\'s network location (includes DNS, TCP and TLS setup for the first hop); real users and agents elsewhere will see different numbers.' };
      if (t <= TTFB_GOOD_MS) return pass(`Time to first byte was ${t} ms (good is 800 ms or less).`, { evidence: [h], details });
      if (t <= TTFB_POOR_MS) return warn(`Time to first byte was ${t} ms (needs improvement: 800-1,800 ms).`, { evidence: [h], details });
      return fail(`Time to first byte was ${t} ms (poor: over 1,800 ms).`, { evidence: [h], details });
    },
  },

  'performance.compression': {
    why: 'Compressed HTML and text are several times smaller, so agents fetch more pages within their time and token budgets (book chapter 19).',
    fix: { snippet: '# nginx\ngzip on;\ngzip_types text/html text/markdown text/plain application/json application/xml;\n# or brotli on; brotli_types ...;', prompt: 'Enable gzip or Brotli (or zstd) compression for text responses (HTML, Markdown, JSON, XML, plain text) at the web server or CDN, and verify with curl -sI -H "Accept-Encoding: gzip, br" that Content-Encoding is set.' },
    async run(ctx) {
      const h = await ctx.home();
      if (!h.ok) return neutral(`The page answered ${h.error || `HTTP ${h.status}`}, so compression could not be judged.`, { evidence: [h] });
      const enc = h.headers['content-encoding'] || '';
      const details = { contentEncoding: enc || null, bytes: h.bytes, requested: h.requestHeaders?.['accept-encoding'] || null };
      if (CODINGS.test(enc)) return pass(`The page is served compressed (Content-Encoding: ${enc}).`, { evidence: [h], details });
      if (h.bytes < 1024) return info(`The page is not compressed, but it is only ${h.bytes} bytes.`, { evidence: [h], details });
      return fail(`The page (${Math.round(h.bytes / 1024)} KB) is sent uncompressed although the request accepted gzip and br.`, { evidence: [h], details });
    },
  },

  'performance.redirects': {
    why: 'Every redirect is another round trip before an agent gets content, and long chains hit agents\' redirect limits (book chapter 19).',
    fix: { snippet: '# link straight to the final URL, and redirect old URLs in one hop\nreturn 301 https://www.example.com$request_uri;', prompt: 'Collapse redirect chains to at most one hop: redirect http->https and apex->www (or the reverse) in a single 301 to the final URL, and update internal links and sitemaps to use final URLs.' },
    async run(ctx) {
      const h = await ctx.home();
      const hops = h.redirects || [];
      const chain = [ctx.url.href, ...hops.map((r) => r.location)];
      const details = { hops: hops.length, chain: hops.map((r) => ({ status: r.status, from: r.url, to: r.location })) };
      if (h.errorCode === 'redirects') return fail(`The redirect chain is longer than the checker allows (${h.error}).`, { evidence: [h], details });
      if (h.error && !hops.length) return error(`The page could not be fetched (${h.error}).`, { evidence: [h] });
      if (hops.length > 2) return warn(`${hops.length} redirects before the page: ${chain.join(' -> ')}.`, { evidence: [h], details });
      return pass(hops.length ? `${hops.length} redirect(s) to the page (${chain.join(' -> ')}).` : 'No redirects: the URL answers directly.', { evidence: [h], details });
    },
  },

  'performance.page-weight': {
    why: 'Big HTML costs agents tokens and time, and crawlers cut it off: Googlebot reads only the first 2 MB of an HTML file for Google Search (book chapter 3).',
    fix: { snippet: '<!-- move inline data blobs and SVG sprites out of the HTML -->\n<script type="module" src="/app.js"></script>\n<link rel="stylesheet" href="/site.css">', prompt: 'Reduce the HTML size of the page: move large inline scripts, JSON state blobs, inline SVG sprites and base64 images into separate cached files, paginate long lists, and keep the main content near the top of the document.' },
    async run(ctx) {
      const h = await ctx.home();
      if (!(await ctx.isHtml())) return neutral(`The page is not HTML (${h.error || `HTTP ${h.status}`}).`, { evidence: [h] });
      const doc = await ctx.dom();
      const nodes = doc.querySelectorAll('*').length;
      const kb = Math.round(h.bytes / 1024);
      const details = { bytes: h.bytes, truncated: h.truncated, domElements: nodes, googlebotSearchLimitBytes: GOOGLEBOT_SEARCH_BYTES, googleCrawlerLimitBytes: GOOGLE_CRAWLER_BYTES, source: 'https://developers.google.com/search/docs/crawling-indexing/googlebot' };
      if (h.truncated) return warn(`The HTML is larger than the ${kb} KB this checker reads, past Googlebot's 2 MB cutoff for Google Search.`, { evidence: [h], details });
      if (h.bytes > GOOGLEBOT_SEARCH_BYTES) return warn(`The HTML is ${kb} KB uncompressed, past the 2 MB Googlebot reads for Google Search; content after that point is not indexed.`, { evidence: [h], details });
      return info(`The HTML is ${kb} KB uncompressed with ${nodes} elements.`, { evidence: [h], details });
    },
  },
};
