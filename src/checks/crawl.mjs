// Checks for the crawl layer (crawler access). Ids and metadata: src/catalog.json.
// The AI crawler table and parts of the isitagentready rules are adapted from agent-ready-web-demos (MIT,
// Maxim Salnikov): nordlys-cabins/layers/04-crawler-controls/agents.js and
// chapters/02-your-first-agent-ready-page/agent-ready-check.mjs.
import { pass, warn, fail, info, neutral, error } from '../core/result.mjs';
import { BROWSER_UA, HTML_ACCEPT } from '../core/context.mjs';
import { parseSitemap, W3C_DATETIME, SITEMAP_LIMITS } from '../core/parse/sitemap.mjs';

/** AI user agents and robots.txt control tokens by purpose, as each vendor documents them (checked 2 Nov 2026). */
export const AI_AGENTS_CHECKED = '2026-11-02';
export const AI_AGENTS = [
  { token: 'GPTBot', vendor: 'OpenAI', purpose: 'training', robots: 'honours', doc: 'https://platform.openai.com/docs/bots' },
  { token: 'ClaudeBot', vendor: 'Anthropic', purpose: 'training', robots: 'honours', doc: 'https://support.claude.com/en/articles/8896518' },
  { token: 'Google-Extended', vendor: 'Google', purpose: 'training', robots: 'control token, no crawler', doc: 'https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers' },
  { token: 'Applebot-Extended', vendor: 'Apple', purpose: 'training', robots: 'control token, no crawler', doc: 'https://support.apple.com/en-us/119829' },
  { token: 'CCBot', vendor: 'Common Crawl', purpose: 'training', robots: 'honours', doc: 'https://commoncrawl.org/ccbot' },
  { token: 'MistralAI-Training', vendor: 'Mistral AI', purpose: 'training', robots: 'honours', doc: 'https://docs.mistral.ai/robots' },
  { token: 'Meta-ExternalAgent', vendor: 'Meta', purpose: 'training', robots: 'unverified', doc: 'https://developers.facebook.com/documentation/sharing/webmasters/web-crawlers', unverified: 'purpose and robots behaviour not verified' },
  { token: 'OAI-SearchBot', vendor: 'OpenAI', purpose: 'search', robots: 'honours', doc: 'https://platform.openai.com/docs/bots' },
  { token: 'Claude-SearchBot', vendor: 'Anthropic', purpose: 'search', robots: 'honours', doc: 'https://support.claude.com/en/articles/8896518' },
  { token: 'PerplexityBot', vendor: 'Perplexity', purpose: 'search', robots: 'honours', doc: 'https://docs.perplexity.ai/guides/bots' },
  { token: 'Amzn-SearchBot', vendor: 'Amazon', purpose: 'search', robots: 'honours', doc: 'https://developer.amazon.com/amazonbot' },
  { token: 'MistralAI-Index', vendor: 'Mistral AI', purpose: 'search', robots: 'honours', doc: 'https://docs.mistral.ai/robots' },
  { token: 'ChatGPT-User', vendor: 'OpenAI', purpose: 'user', robots: 'may not apply', doc: 'https://platform.openai.com/docs/bots' },
  { token: 'Claude-User', vendor: 'Anthropic', purpose: 'user', robots: 'honours', doc: 'https://support.claude.com/en/articles/8896518' },
  { token: 'Perplexity-User', vendor: 'Perplexity', purpose: 'user', robots: 'generally ignores', doc: 'https://docs.perplexity.ai/guides/bots' },
  { token: 'Amzn-User', vendor: 'Amazon', purpose: 'user', robots: 'may not follow all', doc: 'https://developer.amazon.com/amazonbot' },
  { token: 'MistralAI-User', vendor: 'Mistral AI', purpose: 'user', robots: 'governs user requests', doc: 'https://docs.mistral.ai/robots' },
];

/** The AI bot tokens isitagentready's robotsTxtAiRules rule names ("OAI-SearchBot, Claude-SearchBot, GPTBot, ClaudeBot, Google-Extended, etc."), as the book's re-implementation lists them. */
export const IIA_AI_BOTS = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-SearchBot', 'Claude-User',
  'anthropic-ai', 'Google-Extended', 'Google-Agent', 'PerplexityBot', 'Perplexity-User', 'CCBot',
  'Applebot-Extended', 'Meta-ExternalAgent', 'Amazonbot', 'Bytespider', 'MistralAI-User'];

const ALL_AI_TOKENS = [...new Set([...AI_AGENTS.map((a) => a.token), ...IIA_AI_BOTS, '__usage_ai-training'])];
const lc = (s) => String(s || '').toLowerCase();
const sameSite = (a, b) => lc(a).replace(/^www\./, '') === lc(b).replace(/^www\./, '');
const XML_ACCEPT = 'application/xml, text/xml;q=0.9, */*;q=0.5';
const CS_KEYS = ['search', 'ai-input', 'ai-train'];
const AIPREF_KEYS = ['train-ai', 'ai-use', 'search'];

/** Path of the entered page for robots matching. */
const pagePath = (ctx) => ctx.url.pathname + ctx.url.search;

/** Sitemaps: /sitemap.xml plus the first Sitemap: line of robots.txt; one child of a sitemap index is sampled. */
export function sitemaps(ctx) {
  return ctx.memo('crawl.sitemaps', async () => {
    const robots = await ctx.robots();
    const lines = robots.parsed?.sitemaps || [];
    const wellKnownUrl = ctx.abs('/sitemap.xml');
    const get = (u) => ctx.fetch(u, { accept: XML_ACCEPT, maxBytes: 3_145_728, purpose: 'sitemap' });
    let firstLine = null;
    try { if (lines[0]) firstLine = new URL(lines[0], ctx.origin).href; } catch { /* relative garbage */ }
    const [wellKnown, fromRobots] = await Promise.all([get(wellKnownUrl), firstLine && firstLine !== wellKnownUrl ? get(firstLine) : null]);
    const look = (ex) => {
      if (!ex || !ex.ok) return null;
      if (/\.gz($|\?)/i.test(ex.finalUrl) && /gzip|octet/.test(ex.contentType)) return { ex, parsed: null, gz: true };
      const parsed = parseSitemap(ex.text);
      return parsed.kind ? { ex, parsed, gz: false } : null;
    };
    const candidates = [look(fromRobots || (firstLine === wellKnownUrl ? wellKnown : null)), look(wellKnown)].filter(Boolean);
    const primary = candidates.find((c) => c.parsed) || candidates[0] || null;
    let child = null;
    if (primary?.parsed?.kind === 'sitemapindex' && primary.parsed.entries[0]) {
      const cu = primary.parsed.entries[0].loc;
      if (await ctx.mayCrawl(cu)) child = look(await get(cu));
    }
    return { lines, wellKnown, fromRobots, primary, child };
  });
}

/** Is the response a bot challenge or block page? */
export function challengeOf(ex) {
  if (!ex) return null;
  if (ex.error) return { kind: 'error', why: ex.error };
  const h = ex.headers || {};
  if (lc(h['cf-mitigated']) === 'challenge') return { kind: 'challenge', why: 'cf-mitigated: challenge header' };
  const body = ex.text.slice(0, 20_000);
  const marker = /<title>\s*(Just a moment\.\.\.|Attention Required!|Access denied|Pardon Our Interruption|Are you a robot\??|Robot or human\??|Checking your browser)/i.exec(body)
    || /(challenge-platform|cf-chl-|cf_chl_opt|_Incapsula_Resource|px-captcha|g-recaptcha|hcaptcha\.com\/1\/api|captcha-delivery\.com|datadome|perimeterx)/i.exec(body);
  if ([401, 403, 429, 503].includes(ex.status)) return { kind: 'blocked', why: `HTTP ${ex.status}${marker ? ` with "${marker[1]}"` : ''}` };
  if (marker && ex.text.length < 60_000) return { kind: 'challenge', why: `challenge page marker "${marker[1]}"` };
  return null;
}

const robotsFix = 'User-agent: *\nAllow: /\nDisallow: /account/\n\nSitemap: https://example.com/sitemap.xml';

export default {
  'crawl.robots-txt': {
    why: 'robots.txt is the first file every crawler and most agents read. Without it, nothing tells AI crawlers what they may do, and both graders start from it (book chapter 4).',
    fix: {
      snippet: robotsFix,
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

  'crawl.robots-syntax': {
    why: 'Crawlers parse robots.txt strictly (RFC 9309). A rule before any User-agent line, a typo in a field name or a file over the 500 KiB parsing limit silently changes what each bot is allowed to do (book chapter 4).',
    fix: {
      snippet: '# Every rule belongs to a group that starts with User-agent\nUser-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /',
      prompt: 'Clean up /robots.txt so it parses per RFC 9309: every Allow/Disallow line must follow a User-agent line in the same group, use only "Field: value" lines, fix misspelled field names, and keep the file under 500 KiB. Re-test with a robots.txt validator.',
    },
    async run(ctx) {
      const r = await ctx.robots();
      if (!r.ok) return neutral('No plain-text robots.txt to parse (see crawl.robots-txt).', { evidence: [r.ex] });
      const p = r.parsed;
      const bytes = r.ex.bytes;
      const problems = [];
      if (bytes > 512_000 || r.ex.truncated) problems.push(`the file is ${Math.round(bytes / 1024)} KiB; RFC 9309 parsers only have to read the first 500 KiB`);
      for (const e of p.errors.slice(0, 10)) problems.push(`line ${e.line}: ${e.message}`);
      const unknown = p.unknown.filter((u) => !/^(content-usage|content-signal)/i.test(u.text));
      const details = { bytes, groups: p.groups.length, errors: p.errors, unknown: unknown.slice(0, 20) };
      if (p.errors.length || bytes > 512_000) return fail(`robots.txt has ${problems.length} parsing problem(s): ${problems.slice(0, 3).join('; ')}.`, { evidence: [r.ex], details });
      if (unknown.length) return warn(`robots.txt parses, but ${unknown.length} line(s) use fields crawlers do not know (first: "${unknown[0].text}" on line ${unknown[0].line}).`, { evidence: [r.ex], details });
      return pass(`robots.txt parses cleanly: ${p.groups.length} group(s), no stray rules, ${Math.max(1, Math.round(bytes / 1024))} KiB.`, { evidence: [r.ex], details });
    },
  },

  'crawl.ai-bot-rules': {
    why: 'Naming AI crawlers in robots.txt is how you state a deliberate policy: search and user fetchers decide whether you show up in AI answers, training crawlers decide whether your text trains models (book chapter 4).',
    fix: {
      snippet: '# AI search and user fetchers: welcome\nUser-agent: OAI-SearchBot\nUser-agent: Claude-SearchBot\nUser-agent: PerplexityBot\nUser-agent: ChatGPT-User\nUser-agent: Claude-User\nAllow: /\n\n# Training crawlers: your choice\nUser-agent: GPTBot\nUser-agent: ClaudeBot\nUser-agent: Google-Extended\nUser-agent: CCBot\nDisallow: /',
      prompt: 'Add explicit User-agent groups to /robots.txt for the AI crawlers: search bots (OAI-SearchBot, Claude-SearchBot, PerplexityBot), user fetchers (ChatGPT-User, Claude-User, Perplexity-User) and training bots (GPTBot, ClaudeBot, Google-Extended, CCBot, Applebot-Extended). Allow or disallow each group to match the site\'s policy, then verify each token with an RFC 9309 robots tester.',
    },
    async run(ctx) {
      const r = await ctx.robots();
      if (!r.ok) return fail('No robots.txt, so there are no rules for AI crawlers.', { evidence: [r.ex], compat: { status: 'fail', message: 'no AI bot rules in robots.txt' } });
      const agents = r.parsed.groups.flatMap((g) => g.agents);
      const named = [...new Set(agents.filter((a) => ALL_AI_TOKENS.some((t) => lc(t) === lc(a))))];
      const iiaNamed = agents.filter((a) => IIA_AI_BOTS.some((t) => lc(t) === lc(a)));
      const star = agents.some((a) => a.trim() === '*');
      const compat = iiaNamed.length ? { status: 'pass', message: `robots.txt names ${iiaNamed.join(', ')}` }
        : star ? { status: 'pass', message: 'robots.txt has wildcard rules that apply to all crawlers' } : { status: 'fail', message: 'no AI bot rules in robots.txt' };
      const details = { named, wildcard: star };
      if (named.length) return pass(`robots.txt names ${named.length} AI crawler token(s): ${named.slice(0, 8).join(', ')}${named.length > 8 ? ', ...' : ''}.`, { evidence: [r.ex], details, compat });
      if (star) return warn('robots.txt has only a wildcard (User-agent: *) group; no AI crawler is named, so there is no explicit AI policy.', { evidence: [r.ex], details, compat });
      return fail('robots.txt names no AI crawler and has no wildcard group.', { evidence: [r.ex], details, compat });
    },
  },

  'crawl.ai-crawler-matrix': {
    why: 'AI bots come in three kinds: training crawlers, search indexers that put you in AI answers, and user fetchers acting for a person right now. A policy that blocks search and user fetchers while letting training through is usually the opposite of what a site wants (book chapter 4).',
    fix: {
      snippet: 'User-agent: OAI-SearchBot\nUser-agent: Claude-SearchBot\nUser-agent: PerplexityBot\nUser-agent: Amzn-SearchBot\nUser-agent: ChatGPT-User\nUser-agent: Claude-User\nUser-agent: Perplexity-User\nAllow: /\n\nUser-agent: GPTBot\nUser-agent: ClaudeBot\nUser-agent: Google-Extended\nUser-agent: Applebot-Extended\nUser-agent: CCBot\nDisallow: /',
      prompt: 'Review /robots.txt per AI crawler purpose. Make sure AI search bots (OAI-SearchBot, Claude-SearchBot, PerplexityBot, Amzn-SearchBot, MistralAI-Index) and user fetchers (ChatGPT-User, Claude-User, Perplexity-User, Amzn-User, MistralAI-User) can fetch public pages, and decide separately for training crawlers (GPTBot, ClaudeBot, Google-Extended, Applebot-Extended, CCBot, MistralAI-Training, Meta-ExternalAgent). Put each purpose in its own group.',
    },
    async run(ctx) {
      const r = await ctx.robots();
      const path = pagePath(ctx);
      const rows = AI_AGENTS.map((a) => {
        const res = r.allowed(a.token, path);
        return { token: a.token, vendor: a.vendor, purpose: a.purpose, honours_robots: a.robots, doc: a.doc, unverified: a.unverified || null, allowed: res.allowed, group: res.group, rule: res.rule };
      });
      const tally = (p) => { const rs = rows.filter((x) => x.purpose === p); return { allowed: rs.filter((x) => x.allowed).length, total: rs.length }; };
      const t = { training: tally('training'), search: tally('search'), user: tally('user') };
      const summary = `training ${t.training.allowed}/${t.training.total}, search ${t.search.allowed}/${t.search.total}, user ${t.user.allowed}/${t.user.total} allowed for ${path}`;
      const details = { checked: AI_AGENTS_CHECKED, path, tally: t, agents: rows, note: 'Meta-ExternalAgent purpose is not verified. User fetchers often do not obey robots.txt (see honours_robots).' };
      if (!r.ok) return info(`No robots.txt, so all 17 AI tokens may fetch everything (${summary}).`, { evidence: [r.ex], details });
      const ev = [r.ex];
      if (!t.search.allowed && !t.user.allowed && !t.training.allowed) return warn(`robots.txt blocks every AI crawler, including search and user fetchers, so this page cannot appear in AI answers (${summary}).`, { evidence: ev, details });
      if ((t.search.allowed < t.search.total || t.user.allowed < t.user.total) && t.training.allowed > 0) {
        const blocked = rows.filter((x) => x.purpose !== 'training' && !x.allowed).map((x) => x.token);
        return warn(`robots.txt blocks ${blocked.length} AI search/user fetcher(s) (${blocked.slice(0, 5).join(', ')}) while letting training crawlers in (${summary}).`, { evidence: ev, details });
      }
      return pass(`AI crawler policy is consistent: ${summary}.`, { evidence: ev, details });
    },
  },

  'crawl.content-signal': {
    why: 'Content Signals state in robots.txt what crawled content may be used for: search, AI input (answers) or AI training. isitagentready requires the line for Level 2; it is a vendor proposal, not a standard (book chapter 4).',
    fix: {
      snippet: 'User-agent: *\nContent-Signal: search=yes, ai-input=yes, ai-train=no\nAllow: /',
      prompt: 'Add a Content-Signal line inside the User-agent: * group of /robots.txt, for example "Content-Signal: search=yes, ai-input=yes, ai-train=no", choosing yes/no for each of search, ai-input and ai-train to match the site\'s policy.',
    },
    async run(ctx) {
      const r = await ctx.robots();
      const sigs = r.parsed?.contentSignals || [];
      const good = sigs.filter((s) => /(ai-train|search|ai-input)\s*=/i.test(s.value));
      const compat = good.length ? { status: 'pass', message: `Content-Signal: ${good[0].value}` } : { status: 'fail', message: 'no Content-Signal line in robots.txt' };
      if (good.length) return pass(`robots.txt declares Content-Signal: ${good[0].value}${good.length > 1 ? ` (+${good.length - 1} more)` : ''}.`, { evidence: [r.ex], details: { signals: sigs }, compat });
      const home = await ctx.home();
      const hdr = home.headers?.['content-signal'];
      if (hdr) return warn(`The homepage sends a Content-Signal header (${hdr}) but robots.txt has no Content-Signal line, which is where crawlers and isitagentready look.`, { evidence: [r.ex, home], compat });
      return fail(r.ok ? 'robots.txt has no Content-Signal line.' : 'No robots.txt, so no Content-Signal preferences.', { evidence: [r.ex], compat });
    },
  },

  'crawl.content-signal-valid': {
    why: 'A Content-Signal line only counts if crawlers can read it: the keys are search, ai-input and ai-train, the values yes or no, and the line sits inside a User-agent group (book chapter 4).',
    fix: {
      snippet: 'User-agent: *\nContent-Signal: search=yes, ai-input=yes, ai-train=no',
      prompt: 'Fix the Content-Signal lines in /robots.txt: place each one inside a User-agent group, use only the keys search, ai-input and ai-train, and only the values yes or no, separated by commas.',
    },
    async run(ctx) {
      const r = await ctx.robots();
      const sigs = r.parsed?.contentSignals || [];
      if (!sigs.length) return neutral('No Content-Signal lines to validate.', { evidence: [r.ex] });
      const problems = [];
      for (const s of sigs) {
        if (!s.agents.length) problems.push(`line ${s.line}: outside any User-agent group`);
        for (const [k, v] of Object.entries(s.pairs)) {
          if (!CS_KEYS.includes(k)) problems.push(`line ${s.line}: unknown key "${k}"`);
          else if (!['yes', 'no'].includes(v)) problems.push(`line ${s.line}: ${k}=${v || '(empty)'} (must be yes or no)`);
        }
        if (!Object.keys(s.pairs).some((k) => CS_KEYS.includes(k))) problems.push(`line ${s.line}: no known key`);
      }
      const details = { signals: sigs, problems };
      if (problems.length) return (problems.length >= sigs.length ? fail : warn)(`${problems.length} problem(s) in ${sigs.length} Content-Signal line(s): ${problems.slice(0, 3).join('; ')}.`, { evidence: [r.ex], details });
      return pass(`${sigs.length} Content-Signal line(s), all inside a group with valid keys and yes/no values.`, { evidence: [r.ex], details });
    },
  },

  'crawl.aipref-usage': {
    why: 'The IETF AI Preferences drafts define Content-Usage (train-ai, ai-use, search, each y or n) as a robots.txt rule and an HTTP header. They are working-group drafts still in flux, so absence is fine; a malformed line just gets ignored (book chapter 4).',
    fix: {
      snippet: 'User-agent: *\nAllow: /\nContent-Usage: train-ai=n, search=y\nContent-Usage: /blog/ train-ai=y',
      prompt: 'If the site wants to state IETF aipref preferences, add Content-Usage rules inside a robots.txt User-agent group (optionally path-scoped, "Content-Usage: /path/ train-ai=n") and/or a Content-Usage response header, using only the vocabulary keys train-ai, ai-use and search with values y or n (draft-ietf-aipref-vocab-08, draft-ietf-aipref-attach-05).',
    },
    async run(ctx) {
      const [r, home] = await Promise.all([ctx.robots(), ctx.home()]);
      const lines = (r.parsed?.contentUsage || []).map((u) => ({ source: 'robots.txt', line: u.line, value: u.value, inGroup: u.agents.length > 0 }));
      if (home.headers?.['content-usage']) lines.push({ source: 'header', value: home.headers['content-usage'], inGroup: true });
      const trainingGroup = r.parsed?.groups.some((g) => g.agents.some((a) => lc(a) === '__usage_ai-training')) || false;
      if (!lines.length) return info(`No Content-Usage (IETF aipref) preferences found${trainingGroup ? '; robots.txt has a __usage_ai-training group (draft-kelley-aipref-training-preference-signal)' : ''}. That is fine while the drafts settle.`, { evidence: [r.ex], details: { trainingGroup } });
      const problems = [];
      for (const l of lines) {
        let v = l.value.trim();
        if (l.source === 'robots.txt' && v.startsWith('/')) v = v.replace(/^\S+\s*/, '');
        if (!l.inGroup) problems.push(`line ${l.line}: outside any User-agent group`);
        const pairs = v.split(',').map((p) => p.trim()).filter(Boolean);
        if (!pairs.length) problems.push(`${l.source}${l.line ? ` line ${l.line}` : ''}: empty preference`);
        for (const p of pairs) {
          const m = /^([a-z0-9-]+)\s*=\s*([^;\s]*)/i.exec(p);
          if (!m) { problems.push(`${l.source}: "${p}" is not key=value`); continue; }
          if (!AIPREF_KEYS.includes(lc(m[1]))) problems.push(`${l.source}: unknown key "${m[1]}"${CS_KEYS.includes(lc(m[1])) ? ' (that is a Content-Signal key; aipref uses train-ai/ai-use)' : ''}`);
          else if (!['y', 'n'].includes(lc(m[2]))) problems.push(`${l.source}: ${m[1]}=${m[2]} (must be y or n)`);
        }
      }
      const details = { lines, problems, trainingGroup, vocabulary: 'draft-ietf-aipref-vocab-08 (14 Sep 2026)' };
      if (problems.length) return warn(`Content-Usage preferences found but ${problems.length} problem(s): ${problems.slice(0, 3).join('; ')}.`, { evidence: [r.ex, home], details });
      return pass(`${lines.length} valid Content-Usage preference(s) (aipref draft vocabulary): ${lines.map((l) => l.value).slice(0, 2).join(' | ')}.`, { evidence: [r.ex, home], details });
    },
  },

  'crawl.robots-meta': {
    why: 'A noindex in the X-Robots-Tag header or the robots meta tag tells every crawler, AI search included, to keep the page out. It is often left over from staging (book chapter 4).',
    fix: {
      snippet: '<!-- remove noindex from public pages -->\n<meta name="robots" content="index, follow">',
      prompt: 'Remove "noindex" and "none" from the X-Robots-Tag response header and the <meta name="robots"> tag on public pages. Keep noindex only on private or transactional pages, then re-check the headers with curl -I.',
    },
    async run(ctx) {
      const home = await ctx.home();
      if (!home.ok) return error(`The page answered ${home.error || `HTTP ${home.status}`}, so its robots directives could not be read.`, { evidence: [home] });
      const found = [];
      const hdr = home.headers['x-robots-tag'];
      if (hdr) {
        // X-Robots-Tag can be scoped: "googlebot: noindex". Unscoped values apply to everyone.
        for (const part of hdr.split(/,(?=\s*[a-z0-9_-]+\s*:)/i)) {
          const m = /^\s*([a-z0-9_-]+)\s*:\s*(.*)$/i.exec(part);
          const scoped = m && !/^(unavailable_after|max-snippet|max-image-preview|max-video-preview)$/i.test(m[1]);
          found.push({ source: 'X-Robots-Tag', agent: scoped ? m[1] : '*', value: (scoped ? m[2] : part).trim() });
        }
      }
      const doc = await ctx.dom();
      for (const m of doc.querySelectorAll('meta[name][content]')) {
        const name = lc(m.getAttribute('name'));
        if (name === 'robots' || ALL_AI_TOKENS.some((t) => lc(t) === name) || /^(googlebot|bingbot|googlebot-news)$/.test(name)) found.push({ source: 'meta', agent: name === 'robots' ? '*' : name, value: m.getAttribute('content') });
      }
      const blocks = (v) => /\b(noindex|none)\b/i.test(v);
      const everyone = found.filter((f) => f.agent === '*' && blocks(f.value));
      const someone = found.filter((f) => f.agent !== '*' && blocks(f.value));
      const nonstd = found.filter((f) => /\b(noai|noimageai)\b/i.test(f.value));
      const snippet = found.filter((f) => /\bnosnippet\b|max-snippet\s*:\s*0\b/i.test(f.value));
      const details = { directives: found, note: nonstd.length ? 'noai/noimageai are not documented as honoured by any major AI vendor (book chapter 4).' : undefined };
      if (everyone.length) return fail(`The page tells every crawler to stay out: ${everyone.map((f) => `${f.source} "${f.value}"`).join(', ')}.`, { evidence: [home], details });
      if (someone.length) return warn(`The page is noindex for ${someone.map((f) => f.agent).join(', ')} (${someone[0].source} "${someone[0].value}").`, { evidence: [home], details });
      if (snippet.length) return warn(`The page is indexable but sets ${snippet[0].value} (${snippet[0].source}); Google says nosnippet also keeps it out of AI answers as direct input.`, { evidence: [home], details });
      return pass(found.length ? `Robots directives allow indexing (${found.map((f) => f.value).join('; ').slice(0, 120)}).` : 'No noindex in the X-Robots-Tag header or the robots meta tag.', { evidence: [home], details });
    },
  },

  'crawl.bot-challenge': {
    why: 'Bot protection that challenges every non-browser client also stops the AI agents and assistants you want. Verified-bot and Web Bot Auth allow-lists let good agents through while still blocking scrapers (book chapter 15).',
    fix: {
      snippet: '# Allow verified bots / signed agents in your WAF or bot manager, e.g.\n# - allow requests with a valid Web Bot Auth Signature-Agent\n# - allow verified AI crawlers (OAI-SearchBot, Claude-SearchBot, ...) on public pages\n# - keep challenges on login, checkout and APIs that need them',
      prompt: 'Find the bot-protection rule (WAF, CDN bot management or anti-bot script) that challenges or blocks this site\'s public pages for non-browser user agents. Exempt public, read-only pages for identified agents and verified bots (Web Bot Auth signatures or the vendors\' verified-bot lists), keep challenges on sensitive paths, then verify with curl -A "AgentReadyCheck" that the homepage returns 200 HTML.',
    },
    async run(ctx) {
      const [bot, browser] = await Promise.all([
        ctx.home(),
        ctx.fetch(ctx.url.href, { accept: HTML_ACCEPT, headers: { 'user-agent': BROWSER_UA }, maxBytes: 3_145_728, memo: false, purpose: 'browser-UA comparison' }),
      ]);
      const cb = challengeOf(bot); const cr = challengeOf(browser);
      const details = { bot: { status: bot.status, challenge: cb }, browser: { status: browser.status, challenge: cr } };
      if (cb?.kind === 'error' && cr?.kind === 'error') return error(`The page could not be fetched at all (${bot.error}).`, { evidence: [bot, browser], details });
      if (!cb) return pass(`An identified agent gets the page (HTTP ${bot.status}${browser.status && browser.status !== bot.status ? `; a browser UA got ${browser.status}` : ''}).`, { evidence: [bot, browser], details });
      if (!cr) return fail(`Identified agents are blocked or challenged (${cb.why}) while a browser user agent gets HTTP ${browser.status}.`, { evidence: [bot, browser], details });
      return warn(`Both an identified agent and a browser user agent are blocked or challenged (${cb.why}); this may be a site-wide bot wall or a block on this checker's network.`, { evidence: [bot, browser], details });
    },
  },

  'crawl.sitemap': {
    why: 'A sitemap lists the pages you want found, with dates. Crawlers and agents use it to discover content without guessing links, and isitagentready counts it for Level 1 (book chapter 6).',
    fix: {
      snippet: '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>https://example.com/</loc><lastmod>2026-11-02</lastmod></url>\n</urlset>',
      prompt: 'Generate /sitemap.xml (sitemaps.org protocol) listing every public canonical URL with an honest <lastmod>, serve it as application/xml, regenerate it on publish, and add "Sitemap: https://<host>/sitemap.xml" to /robots.txt.',
    },
    async run(ctx) {
      const s = await sitemaps(ctx);
      const wkXml = s.wellKnown.ok && /<(urlset|sitemapindex)[\s>]/.test(s.wellKnown.text);
      // Cloudflare's live scanner fails a Sitemap line whose target does not answer with a sitemap (seen on
      // en.wikipedia.org, 3 Nov 2026: the robots.txt sitemap answers 403), so the compat result needs the target too.
      const compat = wkXml ? { status: 'pass', message: '/sitemap.xml is valid XML' } : s.lines.length && s.primary ? { status: 'pass', message: 'Sitemap directive in robots.txt' } : { status: 'fail', message: s.lines.length ? 'the Sitemap line in robots.txt does not lead to a sitemap' : 'no /sitemap.xml and no Sitemap line in robots.txt' };
      const ev = [s.wellKnown, s.fromRobots];
      if (s.primary?.gz) return pass(`A gzipped sitemap is published (${s.primary.ex.finalUrl}).`, { evidence: ev, compat });
      if (s.primary) return pass(`A sitemap is published at ${s.primary.ex.finalUrl} (${s.primary.parsed.kind}, ${s.primary.parsed.entries.length} entr${s.primary.parsed.entries.length === 1 ? 'y' : 'ies'}).`, { evidence: ev, compat, details: { url: s.primary.ex.finalUrl, kind: s.primary.parsed.kind, entries: s.primary.parsed.entries.length, robotsLines: s.lines } });
      if (s.lines.length) return warn(`robots.txt names a sitemap (${s.lines[0]}) but it did not return sitemap XML.`, { evidence: ev, compat });
      return fail('No /sitemap.xml and no Sitemap line in robots.txt.', { evidence: ev, compat });
    },
  },

  'crawl.sitemap-valid': {
    why: 'A sitemap that is not valid XML, lists another site or exceeds the protocol limits is ignored by crawlers (book chapter 6).',
    fix: {
      snippet: '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>https://example.com/cabins/</loc></url>\n</urlset>',
      prompt: 'Make the sitemap valid per sitemaps.org: a <urlset> (or <sitemapindex>) root with the sitemap namespace, one absolute <loc> per entry on this site\'s host, at most 50,000 URLs and 50 MB per file (split into a sitemap index if larger), XML-escaped URLs.',
    },
    async run(ctx) {
      const s = await sitemaps(ctx);
      if (!s.primary) return neutral('No sitemap to validate (see crawl.sitemap).', { evidence: [s.wellKnown] });
      if (s.primary.gz) return info('The sitemap is gzipped; this checker does not unpack it.', { evidence: [s.primary.ex] });
      const { parsed, ex } = s.primary;
      const target = parsed.kind === 'sitemapindex' && s.child?.parsed ? s.child : s.primary;
      const problems = [...parsed.errors];
      if (target !== s.primary) problems.push(...target.parsed.errors.map((e) => `child sitemap: ${e}`));
      const locs = target.parsed.entries.map((e) => e.loc);
      const bad = []; const offsite = [];
      for (const l of locs) { try { const u = new URL(l); if (!/^https?:$/.test(u.protocol)) bad.push(l); else if (!sameSite(u.hostname, ctx.host)) offsite.push(l); } catch { bad.push(l); } }
      if (bad.length) problems.push(`${bad.length} <loc> value(s) are not absolute http(s) URLs (e.g. "${bad[0].slice(0, 80)}")`);
      if (offsite.length) problems.push(`${offsite.length} URL(s) are on another host (e.g. ${offsite[0].slice(0, 80)})`);
      if (parsed.entries.length > SITEMAP_LIMITS.urls) problems.push(`${parsed.entries.length} entries, over the 50,000 limit`);
      if (ex.truncated) problems.push('the file is larger than the 3 MB this checker reads; the count may be partial');
      if (!locs.length) problems.push('no entries');
      const details = { kind: parsed.kind, entries: parsed.entries.length, sampledChild: target !== s.primary ? target.ex.finalUrl : null, sampleUrls: locs.slice(0, 5), problems };
      const ev = [ex, target.ex];
      if (!locs.length || bad.length > locs.length / 2 || offsite.length > locs.length / 2) return fail(`The sitemap is not usable: ${problems.slice(0, 2).join('; ')}.`, { evidence: ev, details });
      if (problems.length) return warn(`The sitemap parses (${locs.length} URLs) with ${problems.length} problem(s): ${problems.slice(0, 2).join('; ')}.`, { evidence: ev, details });
      return pass(`The sitemap is valid: ${parsed.kind} with ${parsed.entries.length} entr${parsed.entries.length === 1 ? 'y' : 'ies'}${target !== s.primary ? `, child sample with ${locs.length} URLs` : ''}, all on this site.`, { evidence: ev, details });
    },
  },

  'crawl.sitemap-lastmod': {
    why: 'Honest <lastmod> dates let crawlers and agents refetch only what changed. Dates that are all identical or in the future get ignored (book chapter 6).',
    fix: {
      snippet: '<url><loc>https://example.com/cabins/fjellro</loc><lastmod>2026-10-28</lastmod></url>',
      prompt: 'Emit <lastmod> for every sitemap URL from the content\'s real last-modified time (not the build time), in W3C Datetime format (YYYY-MM-DD or full timestamp with zone), and never in the future.',
    },
    async run(ctx) {
      const s = await sitemaps(ctx);
      if (!s.primary?.parsed) return neutral('No readable sitemap, so no lastmod dates to check.', { evidence: [s.wellKnown] });
      const target = s.primary.parsed.kind === 'sitemapindex' && s.child?.parsed ? s.child : s.primary;
      const entries = target.parsed.entries;
      if (!entries.length) return neutral('The sitemap has no entries.', { evidence: [target.ex] });
      const withDate = entries.filter((e) => e.lastmod);
      const valid = withDate.filter((e) => W3C_DATETIME.test(e.lastmod));
      const now = Date.now() + 86_400_000; // a day of clock skew
      const future = valid.filter((e) => Date.parse(e.lastmod) > now);
      const distinct = new Set(valid.map((e) => e.lastmod)).size;
      const share = Math.round((100 * valid.length) / entries.length);
      const details = { entries: entries.length, withLastmod: withDate.length, validFormat: valid.length, future: future.length, distinctDates: distinct, sample: withDate.slice(0, 3) };
      const ev = [target.ex];
      if (!withDate.length) return fail(`None of the ${entries.length} sitemap URLs has a <lastmod>.`, { evidence: ev, details });
      if (future.length) return warn(`${future.length} lastmod date(s) are in the future (e.g. ${future[0].lastmod}).`, { evidence: ev, details });
      if (valid.length < withDate.length) return warn(`${withDate.length - valid.length} lastmod value(s) are not W3C Datetime (e.g. "${withDate.find((e) => !W3C_DATETIME.test(e.lastmod)).lastmod}").`, { evidence: ev, details });
      if (valid.length >= 5 && distinct === 1) return warn(`All ${valid.length} lastmod dates are identical (${valid[0].lastmod}), which usually means the build time, not real edits.`, { evidence: ev, details });
      if (share < 80) return warn(`Only ${share}% of sitemap URLs carry a lastmod.`, { evidence: ev, details });
      return pass(`${share}% of sitemap URLs carry a valid lastmod, with ${distinct} distinct date(s).`, { evidence: ev, details });
    },
  },

  'crawl.sitemap-in-robots': {
    why: 'A Sitemap: line in robots.txt is how crawlers find the sitemap without guessing its path. It must be an absolute URL (book chapter 6).',
    fix: {
      snippet: 'Sitemap: https://example.com/sitemap.xml',
      prompt: 'Add an absolute "Sitemap: https://<host>/sitemap.xml" line to /robots.txt (outside or after the groups; it applies to all crawlers).',
    },
    async run(ctx) {
      const r = await ctx.robots();
      if (!r.ok) return neutral('No robots.txt (see crawl.robots-txt).', { evidence: [r.ex] });
      const lines = r.parsed.sitemaps;
      if (!lines.length) {
        const s = await sitemaps(ctx);
        return fail(`robots.txt has no Sitemap: line${s.primary ? `, although ${s.primary.ex.finalUrl} exists` : ''}.`, { evidence: [r.ex], fix: s.primary ? `Sitemap: ${s.primary.ex.finalUrl}` : undefined });
      }
      const relative = lines.filter((l) => !/^https?:\/\//i.test(l));
      if (relative.length) return warn(`robots.txt has ${lines.length} Sitemap line(s), but ${relative.length} are not absolute URLs ("${relative[0]}").`, { evidence: [r.ex], details: { lines } });
      return pass(`robots.txt names ${lines.length} sitemap(s): ${lines.slice(0, 2).join(', ')}.`, { evidence: [r.ex], details: { lines } });
    },
  },

  'crawl.tdmrep': {
    why: 'TDMRep (a W3C Community Group report) is one machine-readable way to make the EU text-and-data-mining opt-out. It is optional; if published it must be well-formed or it says nothing (book chapter 4).',
    fix: {
      snippet: '[\n  { "location": "/", "tdm-reservation": 1, "tdm-policy": "https://example.com/tdm-policy.json" }\n]',
      prompt: 'Only if the site wants a TDM reservation: publish /.well-known/tdmrep.json as application/json, an array of objects with "location" (a path pattern), "tdm-reservation" (0 or 1) and optionally "tdm-policy" (an absolute URL). Check with legal first; it covers all text and data mining, not only AI training.',
    },
    async run(ctx) {
      const [{ ex, json, error: err }, home] = await Promise.all([ctx.json('/.well-known/tdmrep.json'), ctx.home()]);
      const doc = await ctx.dom();
      const meta = doc.querySelector('meta[name="tdm-reservation"]')?.getAttribute('content') ?? null;
      const header = home.headers?.['tdm-reservation'] ?? null;
      const ev = [ex, home];
      const details = { file: json ?? null, header, meta };
      if (!json && ex.ok && err && !/html/i.test(err)) return warn(`/.well-known/tdmrep.json is published but unreadable: ${err}.`, { evidence: ev, details });
      if (!json && header == null && meta == null) return info('No TDMRep reservation (tdmrep.json, header or meta). Optional.', { evidence: ev, details });
      const problems = [];
      if (json) {
        if (!Array.isArray(json)) problems.push('tdmrep.json must be a JSON array');
        else json.forEach((r, i) => {
          if (typeof r?.location !== 'string') problems.push(`entry ${i}: missing "location"`);
          if (![0, 1].includes(r?.['tdm-reservation'])) problems.push(`entry ${i}: "tdm-reservation" must be 0 or 1`);
          if (r?.['tdm-policy'] && !/^https?:\/\//.test(r['tdm-policy'])) problems.push(`entry ${i}: "tdm-policy" should be an absolute URL`);
        });
      }
      for (const [src, v] of [['header', header], ['meta', meta]]) if (v != null && !['0', '1'].includes(String(v).trim())) problems.push(`${src} tdm-reservation="${v}" must be 0 or 1`);
      details.problems = problems;
      if (problems.length) return warn(`TDMRep is published with ${problems.length} problem(s): ${problems.slice(0, 2).join('; ')}.`, { evidence: ev, details });
      const reserved = (Array.isArray(json) && json.some((r) => r['tdm-reservation'] === 1)) || String(header).trim() === '1' || String(meta).trim() === '1';
      return pass(`TDMRep is valid (${[json && 'tdmrep.json', header != null && 'header', meta != null && 'meta'].filter(Boolean).join(', ')}); TDM rights are ${reserved ? 'reserved' : 'not reserved'}.`, { evidence: ev, details });
    },
  },

  'crawl.rsl': {
    why: 'RSL (Really Simple Licensing 1.0) lets a site point crawlers to machine-readable licence terms from robots.txt or a <link>. Optional; if used, the pointer must resolve to an RSL document (book chapter 4).',
    fix: {
      snippet: '# robots.txt\nLicense: https://example.com/license.xml\n\n<!-- or in HTML -->\n<link rel="license" type="application/rsl+xml" href="/license.xml">',
      prompt: 'Only if the site licenses content to AI systems: publish an RSL 1.0 document (root <rsl xmlns="https://rslstandard.org/rsl">) at a stable URL, served as application/rsl+xml or XML, and point to it with a "License:" line in robots.txt and/or <link rel="license" type="application/rsl+xml">.',
    },
    async run(ctx) {
      const r = await ctx.robots();
      const links = (await ctx.links()).filter((l) => l.rel === 'license' && /rsl\+xml/i.test(l.type || ''));
      const pointers = [...(r.parsed?.licenses || []).map((u) => ({ source: 'robots.txt', href: u })), ...links.map((l) => ({ source: `link (${l.source})`, href: l.href }))];
      if (!pointers.length) return info('No RSL licence pointer (robots.txt License: line or rel=license link). Optional.', { evidence: [r.ex] });
      const ex = await ctx.fetch(pointers[0].href, { accept: 'application/rsl+xml, application/xml;q=0.9, */*;q=0.5', purpose: 'RSL licence' });
      const details = { pointers, status: ex.status, contentType: ex.contentType };
      if (!ex.ok) return warn(`The RSL pointer ${pointers[0].href} answered ${ex.error || `HTTP ${ex.status}`}.`, { evidence: [r.ex, ex], details });
      const root = /<\s*rsl\b[^>]*>/i.exec(ex.text);
      if (!root) return warn(`${pointers[0].href} resolves but is not an RSL document (no <rsl> root element).`, { evidence: [r.ex, ex], details });
      const ns = /xmlns\s*=\s*["']https:\/\/rslstandard\.org\/rsl["']/.test(root[0]);
      return (ns ? pass : warn)(`RSL licence found at ${pointers[0].href}${ns ? '' : ' (root element lacks the https://rslstandard.org/rsl namespace)'}.`, { evidence: [r.ex, ex], details });
    },
  },
};
