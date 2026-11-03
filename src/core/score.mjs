// Scoring: layer scores, overall score, isitagentready-compatible level, Lighthouse Agentic view, roles.
import { CREDIT } from './result.mjs';

export const MATURITY = { standard: 1, guidance: 1, draft: 0.6, proposal: 0.4, convention: 0.4 };

export function effectiveWeight(check) {
  return check.severity * (MATURITY[check.standardInfo?.maturity] ?? 1);
}

export function layerScores(layers, results) {
  return layers.map((L) => {
    const rs = results.filter((r) => r.layer === L.id);
    const counts = Object.fromEntries(['pass', 'warn', 'fail', 'info', 'neutral', 'skipped', 'error'].map((s) => [s, rs.filter((r) => r.status === s).length]));
    const scored = rs.filter((r) => r.status in CREDIT);
    const total = scored.reduce((a, r) => a + r.weight, 0);
    const got = scored.reduce((a, r) => a + r.weight * CREDIT[r.status], 0);
    return { id: L.id, name: L.name, summary: L.summary, chapters: L.chapters, weight: L.weight, applicable: total > 0, score: total > 0 ? Math.round((100 * got) / total) : null, counts, checks: rs.map((r) => r.id) };
  });
}

export function overallScore(layers) {
  const a = layers.filter((l) => l.applicable);
  const w = a.reduce((s, l) => s + l.weight, 0);
  return w ? Math.round(a.reduce((s, l) => s + l.weight * l.score, 0) / w) : 0;
}

// ---- isitagentready compatibility (rules from https://isitagentready.com/llms-full.txt, read 3 Nov 2026)
export const IIA_CATEGORIES = {
  discoverability: ['robotsTxt', 'sitemap', 'linkHeaders', 'dnsAid'],
  contentAccessibility: ['markdownNegotiation'],
  botAccessControl: ['robotsTxtAiRules', 'contentSignals', 'webBotAuth'],
  discovery: ['mcpServerCard', 'a2aAgentCard', 'agentSkills', 'webMcp', 'apiCatalog', 'oauthDiscovery', 'oauthProtectedResource', 'authMd', 'ard', 'personalAgentProtocol'],
  commerce: ['x402', 'mpp', 'ucp', 'acp', 'ap2'],
};
export const LEVEL_NAMES = ['Not Ready', 'Basic Web Presence', 'Bot-Aware', 'Agent-Readable', 'Agent-Integrated', 'Agent-Native'];

export function iiaLevel(st) {
  const p = (id) => st[id] === 'pass';
  const integ = ['mcpServerCard', 'a2aAgentCard', 'agentSkills', 'apiCatalog'];
  const l1 = ['robotsTxt', 'sitemap', 'linkHeaders'].filter(p).length >= 2;
  const l2 = l1 && p('robotsTxtAiRules') && p('contentSignals');
  const l3 = l2 && p('markdownNegotiation');
  const l4 = l3 && integ.some(p);
  const l5opts = [p('webBotAuth'), integ.every(p), p('oauthDiscovery') || p('oauthProtectedResource') || p('authMd')].filter(Boolean).length;
  const l5 = l4 && l5opts >= 2;
  const level = l5 ? 5 : l4 ? 4 : l3 ? 3 : l2 ? 2 : l1 ? 1 : 0;
  const req = [];
  if (level === 0) req.push(...['robotsTxt', 'sitemap', 'linkHeaders'].filter((x) => !p(x)).map((x) => `${x} (2 of 3: robotsTxt, sitemap, linkHeaders)`));
  if (level === 1) req.push(...['robotsTxtAiRules', 'contentSignals'].filter((x) => !p(x)));
  if (level === 2) req.push('markdownNegotiation');
  if (level === 3) req.push('one of mcpServerCard, a2aAgentCard, agentSkills, apiCatalog');
  if (level === 4) req.push('two of: webBotAuth; all four integration checks; oauthDiscovery or oauthProtectedResource or authMd');
  return { level, level_name: LEVEL_NAMES[level], next_level: level < 5 ? { target: level + 1, name: LEVEL_NAMES[level + 1], requirements: req } : null };
}

export function iiaCompat(results, isCommerce) {
  const byIia = new Map(results.filter((r) => r.iia).map((r) => [r.iia, r]));
  const st = {}; const checks = {};
  for (const [cat, ids] of Object.entries(IIA_CATEGORIES)) {
    checks[cat] = {};
    for (const id of ids) {
      const r = byIia.get(id);
      let c = r?.compat || (r ? { status: r.status === 'pass' ? 'pass' : r.status === 'neutral' ? 'neutral' : r.status === 'error' ? 'unableToCheck' : 'fail', message: r.message } : { status: 'unableToCheck', message: 'not run' });
      if (cat === 'commerce' && !isCommerce && c.status !== 'pass') c = { ...c, status: 'neutral', message: `Not a commerce site: ${c.message}` };
      if (id === 'webBotAuth' && c.status === 'fail') c = { ...c, status: 'neutral' };
      st[id] = c.status; checks[cat][id] = { status: c.status, message: c.message, check: r?.id };
    }
  }
  return { ...iiaLevel(st), checks, is_commerce: isCommerce, rules_source: 'https://isitagentready.com/llms-full.txt (read 2026-11-03)' };
}

// ---- Lighthouse Agentic Browsing view (Lighthouse 13.6.0 audit ids and scoring rules, book Table B.9)
export const LH_AUDITS = [
  { id: 'agent-accessibility-tree', group: 'Agent Accessibility', check: 'perception.axe-agent-rules', scoring: 'binary' },
  { id: 'cumulative-layout-shift', group: 'Stability', check: 'performance.cls', scoring: 'metric' },
  { id: 'webmcp-form-coverage', group: 'WebMCP', check: 'webmcp.form-coverage', scoring: 'informative' },
  { id: 'webmcp-registered-tools', group: 'WebMCP', check: 'webmcp.tools', scoring: 'informative' },
  { id: 'webmcp-schema-validity', group: 'WebMCP', check: 'webmcp.schema-validity', scoring: 'tri' },
  { id: 'llms-txt', group: 'Agent Discoverability', check: 'content.llms-txt-format', scoring: 'binary-na' },
  { id: 'ard-schema', group: 'Agent Discoverability', check: 'discovery.ard-valid', scoring: 'binary-na' },
];

export function lighthouseView(results) {
  const by = new Map(results.map((r) => [r.id, r]));
  const audits = LH_AUDITS.map((a) => {
    const r = by.get(a.check);
    let score = null; let display = 'notApplicable';
    if (!r || ['skipped', 'error'].includes(r.status)) display = 'notRun';
    else if (a.scoring === 'informative') display = 'informative';
    else if (r.status === 'neutral' || r.status === 'info') display = 'notApplicable';
    else { score = a.scoring === 'binary' || a.scoring === 'binary-na' ? (r.status === 'pass' ? 1 : 0) : r.status === 'pass' ? 1 : r.status === 'warn' ? 0.5 : 0; display = 'numeric'; }
    return { id: a.id, group: a.group, scoring: a.scoring, score, display, status: r?.status || 'notRun', message: r?.message || '', check: a.check };
  });
  const scored = audits.filter((a) => a.score !== null);
  return { audits, score: scored.length ? Math.round((100 * scored.reduce((s, a) => s + a.score, 0)) / scored.length) / 100 : null, passed: scored.filter((a) => a.score === 1).length, scored: scored.length, note: 'Our re-implementation of Lighthouse 13.6.0 Agentic Browsing audits; CLS uses web.dev thresholds rather than the Lighthouse log-normal curve.' };
}

export const ROLES = { dev: 'Developers', design: 'Designers', content: 'Content and SEO', pm: 'Product managers', arch: 'Architects', qa: 'QA', security: 'Security', analytics: 'Analytics' };

export function roleView(results) {
  return Object.fromEntries(Object.entries(ROLES).map(([k, name]) => {
    const rs = results.filter((r) => r.roles.includes(k));
    return [k, { name, todo: rs.filter((r) => r.status === 'fail' || r.status === 'warn').map((r) => r.id), done: rs.filter((r) => r.status === 'pass').map((r) => r.id) }];
  }));
}
