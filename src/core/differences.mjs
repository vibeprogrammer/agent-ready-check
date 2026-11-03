// Where this checker deliberately differs from isitagentready.com (shown in every report).
export const DIFFERENCES = [
  { topic: 'Scope', text: '113 checks in 13 layers against isitagentready\'s 23 checks in 5 categories. Perception, structured data, security, privacy and performance are layers isitagentready does not look at.' },
  { topic: 'Level', text: 'The isitagentready-compatible level is computed from our re-implementation of the 23 published checks and level rules. Our own score is separate and never changes that level.' },
  { topic: 'Markdown', text: 'We pass Markdown negotiation like isitagentready does, but our own check warns when the negotiated response lacks Vary: Accept, because shared caches can then serve Markdown to browsers.' },
  { topic: 'AI crawlers', text: 'isitagentready passes any robots.txt with AI or wildcard rules. We also evaluate 17 documented AI tokens and warn when search or user fetchers are blocked while training crawlers are allowed.' },
  { topic: 'Maturity', text: 'Checks on drafts and vendor proposals weigh less (0.6 and 0.4) than checks on RFCs and Recommendations (1.0). isitagentready weighs them the same.' },
  { topic: 'Applicability', text: 'APIs, MCP, OAuth and commerce are scored only when the site shows that capability. A site with forms but no machine interface still loses points through api.actionable-interface.' },
  { topic: 'Soft 404s', text: 'We test whether unknown paths answer 200. A site that does makes every well-known probe ambiguous, so we flag it.' },
  { topic: 'Browser', text: 'Accessibility, WebMCP tools, CLS and rendered-vs-server parity need a real browser. Where none ran, those checks show "skipped" and do not count.' },
];
