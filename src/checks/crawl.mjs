// Checks for the crawl layer (crawler access). Ids and metadata: src/catalog.json.
import { pass, warn, fail, info, neutral } from '../core/result.mjs';

export default {
  'crawl.robots-txt': {
    why: 'robots.txt is the first file every crawler and most agents read. Without it, nothing tells AI crawlers what they may do, and both graders start from it (book chapter 4).',
    fix: {
      snippet: 'User-agent: *\nAllow: /\nDisallow: /account/\n\nSitemap: https://example.com/sitemap.xml',
      prompt: 'Create /robots.txt at the site root, served as text/plain with HTTP 200. Start with a User-agent: * group, allow public pages, disallow private paths such as /account/, and add an absolute Sitemap: line.',
    },
    async run(ctx) {
      const r = await ctx.robots();
      const ex = r.ex;
      if (ex.error) return fail(`robots.txt could not be fetched: ${ex.error}.`, { evidence: [ex], compat: { status: 'fail', message: 'robots.txt not reachable' } });
      if (!ex.ok) return fail(`robots.txt answered HTTP ${ex.status}.`, { evidence: [ex], compat: { status: 'fail', message: `HTTP ${ex.status}` } });
      if (!r.ok) return fail(`robots.txt is served as ${ex.contentType || 'HTML'}, not plain text (often a soft-404 page).`, { evidence: [ex], compat: { status: 'fail', message: 'not text/plain' } });
      const agents = r.parsed.groups.flatMap((g) => g.agents);
      if (!agents.length) return fail('robots.txt has no User-agent line, so no rule applies to anyone.', { evidence: [ex], compat: { status: 'fail', message: 'no User-agent directive' } });
      const plain = /^text\/plain$/.test(ex.contentType);
      const msg = `robots.txt is published with ${r.parsed.groups.length} group(s) for ${agents.length} user-agent token(s).`;
      if (!plain) return warn(`${msg} It is served as ${ex.contentType || 'no content type'} rather than text/plain.`, { evidence: [ex], compat: { status: 'fail', message: 'not text/plain' } });
      return pass(msg, { evidence: [ex], details: { groups: r.parsed.groups.length, agents }, compat: { status: 'pass', message: msg } });
    },
  },
};
void info; void neutral;
