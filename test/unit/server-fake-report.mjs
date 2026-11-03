// A small fixed report for server/MCP/CLI unit tests (H4). Shape follows the report contract in SPEC.md.
export function fakeReport(url = 'https://example.com/', over = {}) {
  return {
    tool: { name: 'agent-ready-check', version: '0.1.0', checks: 2 },
    url, final_url: url, scanned_at: new Date().toISOString(), duration_ms: 12,
    mode: { runtime: 'test', browser: false, browser_error: null }, requests: 3, score: 42,
    layers: [{ id: 'crawl', name: 'Crawler access', summary: 'robots', chapters: '4', weight: 2, applicable: true, score: 50, counts: { pass: 1, fail: 1 }, checks: ['crawl.robots-txt', 'crawl.sitemap'] }],
    compat: { isitagentready: { level: 1, level_name: 'Basic Web Presence', next_level: { target: 2, name: 'Bot-Aware', requirements: ['robotsTxtAiRules'] }, checks: {} }, lighthouse_agentic: { audits: [], score: 0.5, passed: 1, scored: 2 } },
    commerce: { isCommerce: false, signals: [] }, roles: {}, differences: [],
    checks: [
      { id: 'crawl.robots-txt', layer: 'crawl', title: 'robots.txt', severity: 3, weight: 3, standard: { key: 'rfc9309', name: 'RFC 9309', status: 'RFC' }, roles: ['dev'], status: 'fail', message: 'No robots.txt.', details: null, evidence: [1], compat: { status: 'fail', message: 'missing' }, fix: { snippet: 'User-agent: *\nAllow: /', prompt: 'Add /robots.txt.', hint: null } },
      { id: 'crawl.sitemap', layer: 'crawl', title: 'Sitemap', severity: 2, weight: 2, standard: { key: 'sitemaps', name: 'Sitemaps', status: 'Convention' }, roles: ['dev'], status: 'pass', message: 'Sitemap found.', details: null, evidence: [2], compat: { status: 'pass', message: 'ok' }, fix: { snippet: null, prompt: null, hint: null } },
    ],
    exchanges: { 1: { id: 1, request: { method: 'GET', url: `${url}robots.txt`, headers: {} }, response: { status: 404, headers: {}, body: 'Not found' } } },
    ...over,
  };
}
