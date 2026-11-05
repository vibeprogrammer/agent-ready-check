// Generators for the service's own agent-facing files. Pure functions of (base URL, catalog), runtime-neutral.
// The service must pass its own checks and isitagentready Level 4 with these (Level 5 needs Web Bot Auth or
// OAuth metadata, which a public, anonymous scanner has no use for).
import catalog from '../catalog.json' with { type: 'json' };
import { SITE, MCP_PROTOCOLS, MCP_CARD_TYPE, SKILL_NAME, trimBase, hostOfBase } from './site.mjs';
import { AI_CRAWLERS } from './crawlers.mjs';
import { skillMd } from './skill.mjs';
import { openapi } from './openapi.mjs';

export { SITE, MCP_PROTOCOLS, MCP_CARD_TYPE, LINKSET_TYPE, SKILL_NAME } from './site.mjs';
export { skillMd, openapi };

/** Public pages, for the sitemap and llms.txt. */
export const PAGES = [
  { path: '/', title: SITE.name, md: '/index.md', updated: 'home', summary: 'Scan a site and read the report.' },
  { path: '/docs', title: 'API, MCP, WebMCP and CLI', md: '/docs.md', updated: 'docs', summary: 'How agents and people use the service: HTTP API, MCP tools, WebMCP tool, CLI, badges.' },
  { path: '/checks', title: 'The checks', md: '/checks.md', updated: 'checks', summary: `All ${SITE.checksCount} checks by layer, with their standard and its status.` },
  { path: '/privacy', title: 'Privacy', md: '/privacy.md', updated: 'privacy', summary: 'What the service stores and for how long.' },
  { path: '/terms', title: 'Terms of use', md: '/terms.md', updated: 'privacy', summary: 'Fair use of the free scanner and its API.' },
];

const SIGNAL = 'Content-Signal: search=yes, ai-input=yes, ai-train=yes';
// Paths that start scans or serve per-scan data: crawlers should not trigger scans by following links.
const SCAN_PATHS = ['/scan', '/api/scan', '/r/', '/badge'];

export function robotsTxt(base) {
  const b = trimBase(base);
  const group = (comment, agents, rules) => [`# ${comment}`, ...agents.map((a) => `User-agent: ${a}`), SIGNAL, ...rules].join('\n');
  const crawlRules = ['Allow: /', ...SCAN_PATHS.map((p) => `Disallow: ${p}`)];
  return [
    `# robots.txt for ${SITE.name} (${SITE.repo})`,
    '# Content signals: https://contentsignals.org/ . Every group repeats them, because a crawler',
    '# reads only the group that matches it best (RFC 9309, section 2.2.1).',
    '',
    group('Everyone: read every page, but do not start scans by following links', ['*'], crawlRules),
    '',
    group('AI search and training crawlers: welcome, same rules', [...AI_CRAWLERS.search, ...AI_CRAWLERS.training], crawlRules),
    '',
    group('Assistants fetching for a person right now: they may also open scan results', AI_CRAWLERS.user, ['Allow: /']),
    '',
    `Sitemap: ${b}/sitemap.xml`,
    `Agentmap: ${b}/.well-known/ard.json`,
    '',
  ].join('\n');
}

export function sitemapXml(base) {
  const b = trimBase(base);
  const urls = PAGES.map((p) => `  <url>\n    <loc>${b}${p.path}</loc>\n    <lastmod>${SITE.updated[p.updated]}</lastmod>\n  </url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

export function llmsTxt(base) {
  const b = trimBase(base);
  return [
    `# ${SITE.name}`,
    '',
    `> ${SITE.description} It mirrors all ${SITE.iiaChecks} isitagentready checks (so it shows a comparable Level 0 to 5) and the 7 Lighthouse Agentic Browsing audits. Built on the book "${SITE.book}" by ${SITE.author}.`,
    '',
    'Every page is also available as Markdown: send `Accept: text/markdown`, or add `.md` to the path. Agents should use the MCP server or the JSON API rather than the HTML pages.',
    '',
    '## Use it',
    '',
    `- [MCP server card](${b}/mcp/server-card): the MCP endpoint is ${b}/mcp (stateless Streamable HTTP, POST only), tools scan_site, list_checks, explain_check, get_report.`,
    `- [HTTP API (OpenAPI 3.1)](${b}/openapi.json): POST /api/scan with {"url": "..."}; format "agent" returns only the fixes as Markdown prompts.`,
    `- [Agent Skill](${b}/.well-known/agent-skills/${SKILL_NAME}/SKILL.md): step-by-step instructions for agents.`,
    `- [API, MCP, WebMCP and CLI docs](${b}/docs.md): every surface with examples.`,
    '',
    '## Reference',
    '',
    `- [The checks](${b}/checks.md): all ${SITE.checksCount} checks by layer, with the standard behind each and its status.`,
    `- [Check catalogue as JSON](${b}/api/checks): ids, severities, standards, book chapters, isitagentready and Lighthouse mappings.`,
    `- [Full text for models](${b}/llms-full.txt): this file plus the docs and the whole catalogue in one document.`,
    '',
    '## Optional',
    '',
    `- [Privacy](${b}/privacy.md): what is stored (reports for 30 days) and what is not.`,
    `- [Terms of use](${b}/terms.md): fair use of the free scanner and its API.`,
    `- [Source code](${SITE.repo}): MIT licensed; self-host on Node, Docker, Azure Static Web Apps with Azure Functions, or a Cloudflare Worker.`,
    `- [Book demos](${SITE.demos}): the Nordlys Cabins demo site, agent-ready layer by layer, by ${SITE.author}.`,
    '',
  ].join('\n');
}

export function checksMd(base) {
  const b = trimBase(base);
  const out = [`# The checks`, '', `${SITE.name} runs ${SITE.checksCount} checks in ${SITE.layersCount} layers. Standards and their status were read on ${catalog.checked}. Severity: 3 essential, 2 important, 1 nice to have. JSON: ${b}/api/checks`, ''];
  for (const L of catalog.layers) {
    const cs = catalog.checks.filter((c) => c.layer === L.id);
    out.push(`## ${L.name} (${cs.length} checks)`, '', `${L.summary}. Layer weight ${L.weight}; book chapters ${L.chapters}.`, '');
    for (const c of cs) {
      const s = catalog.standards[c.standard] || {};
      const extra = [c.iia ? `isitagentready \`${c.iia}\`` : null, c.lh ? `Lighthouse \`${c.lh}\`` : null, c.requires === 'browser' ? 'needs a browser' : null, c.heuristic ? 'heuristic' : null].filter(Boolean).join(', ');
      out.push(`- \`${c.id}\`: ${c.title}. Severity ${c.severity}; ${s.name || c.standard}, ${s.status || 'status unknown'}${extra ? `; ${extra}` : ''}.`);
    }
    out.push('');
  }
  return out.join('\n');
}

export function docsMd(base) {
  const b = trimBase(base);
  return `# API, MCP, WebMCP and CLI

${SITE.name} is agent-ready itself: everything the web page does, an agent can do through a documented interface.

## HTTP API

The OpenAPI 3.1 description is at ${b}/openapi.json, listed in the API catalog at ${b}/.well-known/api-catalog (RFC 9727).

\`\`\`bash
curl -s -X POST ${b}/api/scan -H 'content-type: application/json' -d '{"url":"https://example.com"}'
curl -s "${b}/api/scan?url=example.com&format=markdown"
curl -s -X POST ${b}/api/scan -H 'content-type: application/json' -d '{"url":"https://example.com","format":"agent"}'
curl -s ${b}/api/checks
curl -s ${b}/api/checks/crawl.content-signal
curl -s ${b}/api/reports/REPORT_ID
\`\`\`

- Formats: \`json\` (the full report), \`markdown\` (the report as Markdown) and \`agent\` (only the failing and warning checks, as fix prompts for a coding agent).
- Errors are \`application/problem+json\` (RFC 9457).
- Rate limit: scans per client per window, announced with \`RateLimit-Policy\` and \`RateLimit\` (draft-ietf-httpapi-ratelimit-headers-11). Over the limit you get 429 with \`Retry-After\`.
- The same URL is answered from a 10-minute cache. Reports are stored for 30 days at \`/r/REPORT_ID\` (HTML, or Markdown with \`Accept: text/markdown\`).

## MCP server

Stateless Streamable HTTP at ${b}/mcp. Protocol 2026-07-28 (with \`server/discover\`), and the 2025-11-25 and 2025-06-18 handshakes. No sessions; JSON responses. Server card: ${b}/mcp/server-card (also at /.well-known/mcp/server-card.json).

| Tool | Input | What it does |
| --- | --- | --- |
| \`scan_site\` | \`url\`, optional \`browser\` | Scans a site; returns a summary, the report URL and the full report as structured content |
| \`list_checks\` | optional \`layer\` | Lists the checks |
| \`explain_check\` | \`id\` | Explains one check: standard, status, why, fix |
| \`get_report\` | \`id\` | Returns a stored report |

\`\`\`bash
curl -s ${b}/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \\
  -H 'mcp-protocol-version: 2026-07-28' -H 'mcp-method: tools/call' -H 'mcp-name: scan_site' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"scan_site","arguments":{"url":"https://example.com"}}}'
\`\`\`

## WebMCP

The home page registers a \`scan_site\` tool with \`document.modelContext.registerTool()\` and declares the scan form as a tool (\`toolname\`), so an agent in the browser can run a scan without clicking.

## CLI

\`\`\`bash
npx agent-ready-check https://example.com
npx agent-ready-check https://example.com --json > report.json
npx agent-ready-check https://example.com --md
npx agent-ready-check https://example.com --prompts
npx agent-ready-check https://example.com --browser
npx agent-ready-check http://localhost:3000 --allow-private --fail-under 80 --level-at-least 3
npx agent-ready-check https://example.com --only crawl.robots-txt,content.llms-txt
\`\`\`

The exit code is 1 when \`--fail-under\` or \`--level-at-least\` is not met, so the CLI works as a CI gate.

## Badges

\`\`\`markdown
![Agent-Ready Check](${b}/badge/example.com.svg)
\`\`\`

A badge shows the latest stored report for the host. It never starts a scan.

## Agent discovery files

- robots.txt with named AI crawler groups, Content-Signal and Agentmap: ${b}/robots.txt
- llms.txt and llms-full.txt: ${b}/llms.txt
- Sitemap: ${b}/sitemap.xml
- API catalog: ${b}/.well-known/api-catalog
- MCP server card: ${b}/.well-known/mcp/server-card.json
- Agent Skills index: ${b}/.well-known/agent-skills/index.json
- ARD manifest: ${b}/.well-known/ard.json
- security.txt: ${b}/.well-known/security.txt
`;
}

export function privacyMd(base) {
  const b = trimBase(base);
  return `# Privacy

${SITE.name} is a scanner. This page says what it keeps.

## What is stored

- **Reports.** Every scan result is stored for 30 days so its link (${b}/r/REPORT_ID) can be shared, then deleted. A report contains what the scanned site served publicly: the URLs, the response headers and short excerpts of the bodies.
- **Rate-limit counters.** To stop abuse, the service counts scans per client address for a short window (10 minutes by default). The counter holds the address and a number, and is overwritten when the window ends.

## What is not stored

- No accounts, no cookies, no analytics scripts and no tracking.
- No request logs beyond what the hosting platform keeps for operations.

## Scanning

- The scanner identifies itself with the user agent \`AgentReadyCheck\` and a link to its source code.
- It refuses private, loopback and link-local addresses, follows at most 5 redirects, caps every response and stops after 120 requests per scan.
- For crawl-type reads (sitemap samples, llms.txt link checks) it obeys robots.txt for the token \`AgentReadyCheck\`.

Questions: ${SITE.issues}
`;
}

export function termsMd(base) {
  const b = trimBase(base);
  return `# Terms of use

${SITE.name} is free to use, for people and for agents, on these terms.

## Fair use

- Scan sites you own or are allowed to test, or public sites you are curious about. A scan reads public pages and well-known files the way a browser or a polite crawler would; it never submits forms or calls write operations.
- Scans are rate limited per client (see the \`RateLimit-Policy\` header). Results are cached for 10 minutes, so there is no need to rescan in a loop.
- Do not use the service to probe private networks: private, loopback and link-local addresses are refused.

## No warranty

The checks reflect the standards and the book's guidance as read on ${catalog.checked}. Standards move; some are drafts or vendor proposals and the report says so. The service and its source code (${SITE.repo}) are provided under the MIT licence, "as is", without warranty of any kind.

## Contact

Questions and bug reports: ${SITE.issues}. Privacy: ${b}/privacy
`;
}

export function homeMd(base) {
  const b = trimBase(base);
  return `# ${SITE.name}

${SITE.description}

It mirrors all ${SITE.iiaChecks} isitagentready checks, so every report shows a comparable Level 0 to 5, and the 7 Lighthouse Agentic Browsing audits. Built on the book "${SITE.book}" by ${SITE.author}.

## Scan a site

- In a browser: ${b}/scan?url=example.com
- As JSON: \`curl -s -X POST ${b}/api/scan -H 'content-type: application/json' -d '{"url":"https://example.com"}'\`
- As fix prompts for a coding agent: add \`"format":"agent"\` to the body.
- From an agent: the MCP server at ${b}/mcp (tool \`scan_site\`), or the WebMCP tool \`scan_site\` on this page.

## What it checks

${catalog.layers.map((L) => `- **${L.name}** (${catalog.checks.filter((c) => c.layer === L.id).length}): ${L.summary}.`).join('\n')}

## More

- [API, MCP, WebMCP and CLI](${b}/docs.md)
- [All checks](${b}/checks.md)
- [Privacy](${b}/privacy.md)
- [Terms of use](${b}/terms.md)
- [Source code (MIT)](${SITE.repo})
`;
}

export function llmsFullTxt(base) {
  return [llmsTxt(base), '---', '', docsMd(base), '---', '', checksMd(base), '---', '', privacyMd(base)].join('\n');
}

export function apiCatalog(base) {
  const b = trimBase(base);
  return {
    linkset: [
      {
        anchor: `${b}/api`,
        'service-desc': [{ href: `${b}/openapi.json`, type: 'application/openapi+json' }],
        'service-doc': [{ href: `${b}/docs`, type: 'text/html' }, { href: `${b}/docs.md`, type: 'text/markdown' }],
        status: [{ href: `${b}/api/health`, type: 'application/json' }],
      },
      {
        anchor: `${b}/mcp`,
        'service-desc': [{ href: `${b}/mcp/server-card`, type: MCP_CARD_TYPE }],
        'service-doc': [{ href: `${b}/docs.md`, type: 'text/markdown' }],
      },
    ],
  };
}

export function serverCard(base) {
  const b = trimBase(base);
  return {
    $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
    name: `${hostOfBase(b).replace(/:\d+$/, '').split('.').reverse().join('.')}/${SITE.slug}`,
    version: SITE.version,
    title: SITE.name,
    description: `Scan a website for agent-readiness: ${SITE.checksCount} checks in ${SITE.layersCount} layers, an isitagentready-compatible level and fixes with prompts.`,
    websiteUrl: b,
    repository: { url: SITE.repo, source: 'github' },
    remotes: [{ type: 'streamable-http', url: `${b}/mcp`, supportedProtocolVersions: [...MCP_PROTOCOLS] }],
    capabilities: { tools: { listChanged: false } },
  };
}

async function sha256Hex(text) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export async function agentSkillsIndex(base) {
  return {
    $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
    skills: [
      {
        name: SKILL_NAME,
        type: 'skill-md',
        description: 'Scan a website for agent-readiness and turn the findings into fixes, through the MCP server, the HTTP API or the CLI.',
        url: `/.well-known/agent-skills/${SKILL_NAME}/SKILL.md`,
        digest: `sha256:${await sha256Hex(skillMd(trimBase(base)))}`,
      },
    ],
  };
}

export function ardManifest(base) {
  const b = trimBase(base);
  const host = hostOfBase(b);
  return {
    specVersion: '1.0',
    host: { displayName: SITE.name, identifier: host, url: b },
    entries: [
      {
        identifier: `urn:air:${host}:mcp:${SITE.slug}`,
        displayName: `${SITE.name} MCP server`,
        type: MCP_CARD_TYPE,
        url: `${b}/mcp/server-card`,
        description: 'MCP server that scans a website for agent-readiness and explains each check and its fix.',
        tags: ['agent-readiness', 'seo', 'accessibility', 'mcp', 'webmcp', 'llms.txt', 'robots.txt'],
        representativeQueries: ['is example.com agent-ready', 'why does my site fail the isitagentready markdown check', 'list the fixes to make my website work for AI agents'],
      },
      {
        identifier: `urn:air:${host}:api:${SITE.slug}`,
        displayName: `${SITE.name} HTTP API`,
        type: 'application/openapi+json',
        url: `${b}/openapi.json`,
        description: 'JSON API to scan a URL, list and explain checks and read stored reports.',
        representativeQueries: ['scan a website for AI agent readiness with an API', 'get agent-readiness fix prompts as markdown'],
      },
      {
        identifier: `urn:air:${host}:skill:${SKILL_NAME}`,
        displayName: 'Check a site for agent-readiness',
        type: 'application/agent-skills+md',
        url: `${b}/.well-known/agent-skills/${SKILL_NAME}/SKILL.md`,
        description: 'Instructions for an agent that scans a site and turns the findings into fixes.',
        representativeQueries: ['how do I check if a website is ready for AI agents'],
      },
    ],
  };
}

export function securityTxt(base, now = Date.now()) {
  const b = trimBase(base);
  // RFC 9116: Expires is required and should be less than a year away; computed per request so it never lapses.
  const expires = new Date(now + 360 * 24 * 3600 * 1000);
  expires.setUTCHours(0, 0, 0, 0);
  return [
    `Contact: ${SITE.issues}`,
    `Expires: ${expires.toISOString()}`,
    'Preferred-Languages: en',
    `Canonical: ${b}/.well-known/security.txt`,
    `Policy: ${SITE.repo}/security/policy`,
    '',
  ].join('\n');
}

export function gpcJson() {
  // Global Privacy Control well-known resource. The service sells or shares no personal data.
  return { gpc: true, lastUpdate: SITE.updated.privacy };
}
