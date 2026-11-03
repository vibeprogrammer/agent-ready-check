// Links from reports to the book and its demos. One place to change the URL pattern.
// Until the book's public site (planned at agent-ready-web.salnikov.no) is live, chapters link to the public demos repo
// (MIT, by Maxim Salnikov): the chapter's folder under chapters/ where one exists, else its Nordlys Cabins layer.

export const BOOK = {
  title: 'The Agent-Ready Web',
  author: 'Maxim Salnikov',
  demos: 'https://github.com/webmaxru/agent-ready-web-demos',
  site: null, // set to 'https://agent-ready-web.salnikov.no' once the web edition is live
};

export const CHAPTER_TITLES = {
  1: 'The agent-ready web',
  2: 'Your first agent-ready page',
  3: 'How agents see a page',
  4: 'Who gets in: robots.txt, AI crawlers and content signals',
  5: 'Describing your content with structured data',
  6: 'Content agents can read',
  7: 'APIs agents can use',
  8: 'Server-side tools with the Model Context Protocol',
  9: 'In-page tools with WebMCP',
  10: 'Designing tools agents can actually use',
  11: 'Making capabilities discoverable',
  12: 'Agents that buy: commerce and payments',
  13: 'Choosing the right agent interface',
  14: 'Agents acting for users: OAuth and delegated access',
  15: 'Telling good agents from bad bots',
  16: 'Security for agent-facing sites',
  17: 'Privacy, consent and the human in the loop',
  18: 'Testing agent-readiness',
  19: 'Measuring agent traffic and outcomes',
  20: 'Evolving with the standards',
};

const TREE = `${BOOK.demos}/tree/main`;
const CHAPTER_DIRS = {
  2: 'chapters/02-your-first-agent-ready-page', 3: 'chapters/03-how-agents-see-a-page', 4: 'nordlys-cabins/layers/04-crawler-controls',
  5: 'nordlys-cabins/layers/05-structured-data', 6: 'nordlys-cabins/layers/06-agent-content', 7: 'nordlys-cabins/layers/07-public-api',
  8: 'nordlys-cabins/layers/08-mcp-server', 9: 'nordlys-cabins/layers/09-webmcp', 10: 'chapters/10-designing-tools-agents-can-use',
  11: 'nordlys-cabins/layers/11-discovery', 12: 'nordlys-cabins/layers/12-commerce', 13: 'chapters/13-choosing-the-right-agent-interface',
  14: 'chapters/14-connect-an-agent', 15: 'chapters/15-signing-agent', 16: 'chapters/16-security-for-agent-facing-sites',
  17: 'nordlys-cabins/layers/17-consent', 18: 'chapters/18-testing-agent-readiness', 19: 'chapters/19-measuring-agent-traffic',
  20: 'chapters/20-evolving-with-the-standards',
};

/** URL for book chapter n (the web edition when BOOK.site is set, else the demos folder for that chapter). */
export function chapterLink(n) {
  const k = Number(n);
  if (BOOK.site && k >= 1 && k <= 20) return `${BOOK.site}/chapters/${String(k).padStart(2, '0')}/`;
  return CHAPTER_DIRS[k] ? `${TREE}/${CHAPTER_DIRS[k]}` : BOOK.demos;
}

/** "Chapter 9: In-page tools with WebMCP" */
export function chapterLabel(n) {
  const t = CHAPTER_TITLES[Number(n)];
  return t ? `Chapter ${Number(n)}: ${t}` : `Chapter ${n}`;
}

/**
 * Service URLs for one report. H4's server answers these paths.
 * @param {string} [baseUrl]  origin of the service, no trailing slash ('' for relative links)
 * @param {string} [reportId]
 * @param {string} [host]     scanned host, for the badge
 */
export function reportLinks(baseUrl = '', reportId, host) {
  const b = String(baseUrl || '').replace(/\/+$/, '');
  const id = reportId ? encodeURIComponent(reportId) : null;
  return {
    html: id ? `${b}/r/${id}` : null,
    json: id ? `${b}/api/reports/${id}` : null,
    markdown: id ? `${b}/r/${id}.md` : null,
    prompts: id ? `${b}/r/${id}/fix-prompts.md` : null,
    badge: host ? `${b}/badge/${encodeURIComponent(host)}.svg` : null,
    rescan: host ? `${b}/scan?url=${encodeURIComponent(host)}` : null,
  };
}
