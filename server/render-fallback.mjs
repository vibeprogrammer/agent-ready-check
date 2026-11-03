// Minimal report renderers used until (or unless) src/report/ (H3) provides the full ones.
// Same signatures as src/report: renderReportHtml, renderReportMarkdown, renderFixPrompts, renderBadge, renderHomeHtml.
import { esc } from './markdown.mjs';
import { page } from './layout.mjs';
import { SITE } from '../src/agent-files/site.mjs';

const ORDER = { fail: 0, warn: 1, error: 2, pass: 3, info: 4, skipped: 5, neutral: 6 };

export function renderReportMarkdown(report, { reportId } = {}) {
  const iia = report.compat?.isitagentready;
  const out = [`# Agent-Ready report: ${report.final_url || report.url}`, '',
    `- Score: **${report.score}/100**`,
    iia ? `- isitagentready-compatible level: **${iia.level} (${iia.level_name})**` : null,
    `- Scanned: ${report.scanned_at}, ${report.requests} requests, ${report.duration_ms} ms${report.mode?.browser ? ', with a browser' : ', without a browser'}`,
    reportId || report.id ? `- Report id: ${reportId || report.id}` : null, ''].filter((x) => x !== null);
  out.push('## Layers', '', '| Layer | Score |', '| --- | --- |', ...(report.layers || []).map((l) => `| ${l.name} | ${l.applicable ? l.score : 'n/a'} |`), '');
  out.push('## Checks', '');
  for (const c of [...(report.checks || [])].sort((a, b) => ORDER[a.status] - ORDER[b.status])) out.push(`- **${c.status}** \`${c.id}\`: ${c.message}`);
  out.push('');
  return out.join('\n');
}

export function renderFixPrompts(report) {
  const todo = (report.checks || []).filter((c) => c.status === 'fail' || c.status === 'warn').sort((a, b) => (b.weight || 0) - (a.weight || 0));
  const out = [`# Fixes for ${report.final_url || report.url}`, '', `Agent-Ready score ${report.score}/100. Work through these in order; verify each with the check id named.`, ''];
  for (const c of todo) {
    out.push(`## ${c.id} (${c.status}): ${c.title}`, '', c.message, '');
    if (c.fix?.prompt) out.push(c.fix.prompt, '');
    if (c.fix?.hint) out.push(`Site-specific hint: ${c.fix.hint}`, '');
    if (c.fix?.snippet) out.push('```', c.fix.snippet, '```', '');
  }
  if (!todo.length) out.push('Nothing failing or warning. Well done.', '');
  return out.join('\n');
}

export function renderReportHtml(report, { baseUrl = '', reportId } = {}) {
  const id = reportId || report.id;
  const iia = report.compat?.isitagentready;
  const rows = [...(report.checks || [])].sort((a, b) => ORDER[a.status] - ORDER[b.status]).map((c) => `<tr><td><span class="status ${esc(c.status)}">${esc(c.status)}</span></td><td><code>${esc(c.id)}</code><br>${esc(c.title)}</td><td>${esc(c.message)}</td></tr>`).join('');
  const body = `<p>Score <strong>${esc(report.score)}/100</strong>${iia ? `, isitagentready-compatible level <strong>${esc(iia.level)} (${esc(iia.level_name)})</strong>` : ''}. Scanned ${esc(report.scanned_at)}.</p>
<h2>Layers</h2>
<table><thead><tr><th scope="col">Layer</th><th scope="col">Score</th></tr></thead><tbody>${(report.layers || []).map((l) => `<tr><td>${esc(l.name)}</td><td>${l.applicable ? esc(l.score) : 'n/a'}</td></tr>`).join('')}</tbody></table>
<h2>Checks</h2>
<table><thead><tr><th scope="col">Status</th><th scope="col">Check</th><th scope="col">Finding</th></tr></thead><tbody>${rows}</tbody></table>
${id ? `<p><a href="/api/reports/${esc(id)}">JSON</a></p>` : ''}`;
  return page({ base: baseUrl, path: id ? `/r/${id}` : '/scan', title: `Report for ${new URL(report.final_url || report.url).host}`, description: `Agent-readiness report for ${report.final_url || report.url}: ${report.score}/100.`, body, mdPath: id ? `/r/${id}` : null, noindex: true });
}

export function renderBadge({ score, level, label = 'agent-ready' } = {}) {
  const value = score == null ? 'not scanned' : `${score}/100${level != null ? ` · L${level}` : ''}`;
  const color = score == null ? '#9f9f9f' : score >= 80 ? '#2e7d32' : score >= 50 ? '#b26a00' : '#c62828';
  const w1 = 6 * label.length + 12; const w2 = 6.5 * value.length + 12; const w = Math.round(w1 + w2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}"><title>${esc(label)}: ${esc(value)}</title><rect width="${Math.round(w1)}" height="20" fill="#555"/><rect x="${Math.round(w1)}" width="${Math.round(w2)}" height="20" fill="${color}"/><g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11"><text x="6" y="14">${esc(label)}</text><text x="${Math.round(w1) + 6}" y="14">${esc(value)}</text></g></svg>`;
}

export function renderHomeHtml({ baseUrl = '' } = {}) {
  const body = `<form class="scan" action="/scan" method="get" toolname="scan_site" tooldescription="Scan a website for agent-readiness and show the report.">
<label for="url">Website URL</label>
<input id="url" name="url" type="text" inputmode="url" required placeholder="https://example.com" toolparamdescription="The page to scan, for example https://example.com">
<button type="submit">Scan</button>
</form>
<p>${SITE.checksCount} checks in ${SITE.layersCount} layers. Agents: use the <a href="/docs">API, MCP server or CLI</a>.</p>`;
  return page({ base: baseUrl, path: '/', title: SITE.name, description: SITE.description, body, mdPath: '/index.md' });
}
