// Markdown renderings of a report: the full report, and one prompt with every fix for coding agents.
import { mdText, mdFence, STATUS_LABEL, STATUS_ORDER, MATURITY_LABEL, hostOf } from './util.mjs';
import { chapterLink, chapterLabel, reportLinks, BOOK } from './links.mjs';

const sortChecks = (a, b) => (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) || ((b.weight || 0) - (a.weight || 0));
const todoOf = (report) => (report.checks || []).filter((c) => c.status === 'fail' || c.status === 'warn').sort(sortChecks);

/**
 * Markdown report. With { format: 'agent' } only the to-do list with fixes (compact, for agents).
 * @param {object} report
 * @param {{ baseUrl?: string, reportId?: string, format?: 'full'|'agent' }} [o]
 */
export function renderReportMarkdown(report, { baseUrl = '', reportId, format = 'full' } = {}) {
  const id = reportId || report.id;
  const host = hostOf(report.final_url || report.url);
  const L = reportLinks(baseUrl, id, host);
  const iia = report.compat?.isitagentready;
  const lh = report.compat?.lighthouse_agentic;
  const out = [];
  out.push(`# Agent-readiness report: ${mdText(report.final_url || report.url)}`, '');
  out.push(`- Agent-Ready score: **${report.score}/100**`);
  if (iia) out.push(`- isitagentready-compatible level: **${iia.level} (${mdText(iia.level_name)})**${iia.next_level ? `; next: Level ${iia.next_level.target} needs ${iia.next_level.requirements.map(mdText).join(', ')}` : ''}`);
  if (lh) out.push(`- Lighthouse Agentic view: ${lh.score === null ? 'not scored' : `${Math.round(lh.score * 100)}%`} (${lh.passed} of ${lh.scored} scored audits pass)`);
  out.push(`- Scanned ${mdText(report.scanned_at)} in ${Math.round((report.duration_ms || 0) / 100) / 10} s, ${report.requests} requests, ${report.mode?.browser ? 'with a real browser' : 'without a browser (browser-only checks skipped)'}`);
  if (L.html) out.push(`- Report: ${L.html}`);
  out.push('');
  if (format === 'agent') {
    out.push('## Fixes, most important first', '');
    for (const c of todoOf(report)) {
      out.push(`- [ ] \`${c.id}\` (${c.status}, weight ${c.weight}): ${mdText(c.message)}`);
      if (c.fix?.prompt) out.push(`  Fix: ${mdText(c.fix.prompt)}`);
      if (c.fix?.hint) out.push(`  Hint: ${mdText(c.fix.hint)}`);
    }
    if (!todoOf(report).length) out.push('Nothing to fix: no failing or warning checks.');
    out.push('');
    return out.join('\n');
  }
  out.push('## Layers', '', '| Layer | Score | Pass | Warn | Fail | Not run |', '| --- | --- | --- | --- | --- | --- |');
  for (const l of report.layers || []) out.push(`| ${mdText(l.name)} | ${l.applicable ? l.score : 'n/a'} | ${l.counts?.pass ?? 0} | ${l.counts?.warn ?? 0} | ${l.counts?.fail ?? 0} | ${(l.counts?.skipped ?? 0) + (l.counts?.error ?? 0)} |`);
  out.push('');
  if (lh) {
    out.push('## Lighthouse Agentic Browsing view', '', '| Audit | Score | Status |', '| --- | --- | --- |');
    for (const a of lh.audits) out.push(`| ${a.id} | ${a.score === null ? a.display : a.score} | ${a.status} |`);
    out.push('', mdText(lh.note), '');
  }
  if (iia?.checks) {
    out.push('## isitagentready-compatible checks', '');
    for (const [cat, checks] of Object.entries(iia.checks)) out.push(`- ${cat}: ${Object.entries(checks).map(([k, v]) => `${k} ${v.status}`).join(', ')}`);
    out.push('');
  }
  const byLayer = new Map();
  for (const c of report.checks || []) { if (!byLayer.has(c.layer)) byLayer.set(c.layer, []); byLayer.get(c.layer).push(c); }
  out.push('## Findings', '');
  for (const l of report.layers || []) {
    const cs = (byLayer.get(l.id) || []).sort(sortChecks);
    if (!cs.length) continue;
    out.push(`### ${mdText(l.name)} (${l.applicable ? `${l.score}/100` : 'not applicable'})`, '');
    for (const c of cs) {
      const std = c.standard || {};
      out.push(`- **${STATUS_LABEL[c.status] || c.status}** \`${c.id}\` ${mdText(c.title)}: ${mdText(c.message)}`);
      out.push(`  Standard: ${mdText(std.name || std.key)} (${mdText(std.status || '')}${std.date ? `, ${mdText(std.date)}` : ''}; ${MATURITY_LABEL[std.maturity]?.label || 'n/a'}). Book: [${mdText(chapterLabel(c.chapter))}](${chapterLink(c.chapter)}).${c.heuristic ? ' Threshold is this checker\'s heuristic.' : ''}`);
      if (c.compat) out.push(`  isitagentready rule: ${c.compat.status}, ${mdText(c.compat.message)}`);
      if ((c.status === 'fail' || c.status === 'warn') && c.fix?.prompt) out.push(`  Fix prompt: ${mdText(c.fix.prompt)}`);
    }
    out.push('');
  }
  if (L.badge) out.push('## Badge', '', mdFence(`[![agent-ready](${L.badge})](${L.html || L.rescan})`, 'markdown'), '');
  out.push(`---`, `Checks and fixes are based on the book *${BOOK.title}* by ${BOOK.author} and its demos (${BOOK.demos}).`, '');
  return out.join('\n');
}

/** One Markdown prompt with every fail/warn fix, ordered by status and weight, for a coding agent. */
export function renderFixPrompts(report, { baseUrl = '', reportId } = {}) {
  const todo = todoOf(report);
  const target = report.final_url || report.url;
  const L = reportLinks(baseUrl, reportId || report.id, hostOf(target));
  const out = [`# Make ${mdText(target)} more agent-ready`, '',
    `You are working on the code of the site ${mdText(target)}. An agent-readiness scan (Agent-Ready Check, score ${report.score}/100${report.compat?.isitagentready ? `, isitagentready-compatible Level ${report.compat.isitagentready.level}` : ''}) found ${todo.length} issue(s). Fix them in this order. For each one, change the code, then verify it as described. Do not invent content: where a fix needs facts about the business (prices, policies, contact details), leave a clearly marked TODO for a person.`, ''];
  if (!todo.length) out.push('No failing or warning checks. Nothing to do.', '');
  todo.forEach((c, i) => {
    out.push(`## ${i + 1}. ${mdText(c.title)} (\`${c.id}\`, ${c.status})`, '', `Finding: ${mdText(c.message)}`, '');
    if (c.why) out.push(`Why: ${mdText(c.why)}`, '');
    if (c.fix?.prompt) out.push(`Task: ${mdText(c.fix.prompt)}`, '');
    if (c.fix?.hint) out.push(`Site-specific hint: ${mdText(c.fix.hint)}`, '');
    if (c.fix?.snippet) out.push('Example:', '', mdFence(c.fix.snippet), '');
    const std = c.standard || {};
    if (std.url) out.push(`Reference: ${std.url} (${mdText(std.status || '')}) and ${chapterLink(c.chapter)}`, '');
  });
  if (L.rescan) out.push(`When done, re-scan: ${L.rescan}`, '');
  return out.join('\n');
}
