// Facts about this service used by every generated file. One place to change names and links.
import catalog from '../catalog.json' with { type: 'json' };
import { VERSION } from '../core/fetcher.mjs';

export const SITE = {
  name: 'Agent-Ready Check',
  slug: 'agent-ready-check',
  version: VERSION,
  description: 'Checks how ready a website is for AI agents: 113 checks across 13 layers, from the accessibility tree and robots.txt to MCP, WebMCP, agent discovery and commerce, with evidence, a fix and a fix prompt for every finding.',
  repo: 'https://github.com/vibeprogrammer/agent-ready-check',
  issues: 'https://github.com/vibeprogrammer/agent-ready-check/issues',
  demos: 'https://github.com/webmaxru/agent-ready-web-demos',
  book: 'The Agent-Ready Web',
  author: 'Maxim Salnikov',
  license: 'MIT',
  // Content dates for sitemap lastmod (W3C datetime). Update when the page content changes.
  updated: { home: '2026-11-03', docs: '2026-11-03', checks: catalog.checked, privacy: '2026-11-03' },
  checksCount: catalog.checks.length,
  layersCount: catalog.layers.length,
  iiaChecks: 23,
};

export const MCP_PROTOCOLS = ['2026-07-28', '2025-11-25', '2025-06-18'];
export const MCP_CARD_TYPE = 'application/mcp-server-card+json';
export const LINKSET_TYPE = 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"';
export const SKILL_NAME = 'agent-ready-check';

/** Strip a trailing slash: 'https://x.example/' -> 'https://x.example'. */
export const trimBase = (b) => String(b).replace(/\/+$/, '');
export const hostOfBase = (b) => new URL(b).host;
