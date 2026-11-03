// HTML renderers: the report page and the landing page. Runtime-neutral (Node and Workers), no inline scripts or styles
// (the server's CSP allows only 'self').
//
// DECISION (H3): the landing page is rendered by renderHomeHtml({ baseUrl }) rather than a static public/index.html,
// so the server can fill in the base URL, canonical link and the browser-checks option. The stylesheet and the
// client script are JavaScript strings in src/report/assets.mjs (ASSETS), served by the server at /assets/app.css and
// /assets/app.js; that works the same in Node and in the Worker without a static-assets binding. public/ is not used.
//
// Every string that comes from a scanned site (messages, evidence, headers, bodies, details) is escaped with esc();
// only http(s) URLs become links (safeHref).
import { esc, safeHref, STATUS_LABEL, STATUS_ORDER, STATUS_ICON, MATURITY_LABEL, ROLE_NAMES, grade, hostOf, fmtMs } from './util.mjs';
import { chapterLink, chapterLabel, reportLinks, BOOK } from './links.mjs';
import { renderFixPrompts } from './markdown.mjs';
import { badgeWidth } from './badge.mjs';
import { SITE } from '../agent-files/site.mjs';

export const ASSET_VERSION = '1';
const LEVEL_NAMES = ['Not Ready', 'Basic Web Presence', 'Bot-Aware', 'Agent-Readable', 'Agent-Integrated', 'Agent-Native'];
const STATUSES = ['fail', 'warn', 'pass', 'info', 'error', 'skipped', 'neutral'];

/** Page shell shared by the landing page and reports: landmarks, skip link, nav, footer. */
export function shell({ base = '', path = '/', title, description, body, head = '', noindex = false, mdPath = null, jsonld = null }) {
  const b = String(base || '').replace(/\/+$/, '');
  const full = title === SITE.name ? title : `${title} | ${SITE.name}`;
  const canonical = b ? `${b}${path}` : null;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(full)}</title>
<meta name="description" content="${esc(description)}">
<meta name="color-scheme" content="light dark">
${noindex ? '<meta name="robots" content="noindex">\n' : ''}${canonical ? `<link rel="canonical" href="${esc(canonical)}">\n` : ''}${mdPath ? `<link rel="alternate" type="text/markdown" href="${esc(mdPath)}">\n` : ''}<link rel="stylesheet" href="/assets/app.css?v=${ASSET_VERSION}">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<meta property="og:title" content="${esc(full)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
${canonical ? `<meta property="og:url" content="${esc(canonical)}">\n` : ''}${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, '\\u003c')}</script>\n` : ''}${head}<script type="module" src="/assets/app.js?v=${ASSET_VERSION}"></script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site">
<a class="brand" href="/"><svg class="logo" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>${esc(SITE.name)}</a>
<nav aria-label="Main">
<a href="/">Scan</a>
<a href="/docs">API and MCP</a>
<a href="/checks">Checks</a>
<a href="${esc(SITE.repo)}">Source</a>
</nav>
</header>
<main id="main">
${body}
</main>
<footer class="site">
<p>${esc(SITE.name)} ${esc(SITE.version)}, MIT licensed. Checks and fixes come from the book <cite>${esc(BOOK.title)}</cite> by ${esc(BOOK.author)} and its <a href="${esc(BOOK.demos)}">demos</a>. Not affiliated with Cloudflare or Google. <a href="/privacy">Privacy</a>. <a href="/llms.txt">llms.txt</a>.</p>
</footer>
</body>
</html>
`;
}

/** The scan form: a real GET form to /scan, and a declarative WebMCP tool (scan_site). */
export function scanForm({ value = '', browserAvailable = false, id = 'scan', compact = false, tool = true } = {}) {
  const t = tool ? ' toolname="scan_site" tooldescription="Scan a website for agent-readiness: 113 checks in 13 layers (robots.txt and AI crawlers, structured data, Markdown and llms.txt, APIs, MCP, WebMCP, discovery, commerce, identity, security, privacy, performance). Returns the score, the isitagentready-compatible level and the findings with fixes." toolautosubmit' : '';
  return `<form class="scan${compact ? ' compact' : ''}" id="${esc(id)}" action="/scan" method="get" role="search"${t}>
<label for="${esc(id)}-url">Website address</label>
<div class="row">
<input id="${esc(id)}-url" name="url" type="text" inputmode="url" autocomplete="url" spellcheck="false" required placeholder="example.com" value="${esc(value)}"${tool ? ' toolparamdescription="The site or page to scan: a domain like example.com or a full https URL. Public addresses only."' : ''}>
<button type="submit">Scan</button>
</div>
${browserAvailable ? `<label class="check"><input type="checkbox" name="browser" value="1"${tool ? ' toolparamdescription="Also run the browser checks (accessibility tree, axe rules, WebMCP tools, CLS). Slower."' : ''}> Run browser checks (accessibility, WebMCP, layout stability)</label>\n` : ''}<p class="status" id="${esc(id)}-status" role="status" aria-live="polite"></p>
</form>`;
}

function ring(score) {
  const C = 2 * Math.PI * 52;
  const s = score == null ? 0 : Math.max(0, Math.min(100, score));
  const cls = score == null ? 'na' : s >= 90 ? 'good' : s >= 70 ? 'ok' : s >= 40 ? 'mid' : 'bad';
  return `<svg class="ring ${cls}" viewBox="0 0 120 120" width="140" height="140" role="img" aria-label="Agent-Ready score ${score == null ? 'not available' : `${s} out of 100`}">
<circle class="track" cx="60" cy="60" r="52" fill="none" stroke-width="12"/>
<circle class="bar" cx="60" cy="60" r="52" fill="none" stroke-width="12" stroke-linecap="round" stroke-dasharray="${(C * s / 100).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 60 60)"/>
<text x="60" y="58" text-anchor="middle" class="num">${score == null ? '–' : s}</text><text x="60" y="80" text-anchor="middle" class="of">of 100</text></svg>`;
}

const statusBadge = (st) => `<span class="st st-${esc(st)}"><span aria-hidden="true">${STATUS_ICON[st] || '?'}</span> ${esc(STATUS_LABEL[st] || st)}</span>`;

function stdBadge(std = {}) {
  const m = MATURITY_LABEL[std.maturity] || { label: 'Unrated', text: '' };
  const name = esc(std.name || std.key || 'unknown');
  const href = safeHref(std.url);
  return `<span class="std std-${esc(std.maturity || 'na')}" title="${esc(m.text)}">${esc(m.label)}</span> <span class="stdname">${href ? `<a href="${esc(href)}">${name}</a>` : name}${std.status ? `, ${esc(std.status)}` : ''}${std.date ? `, ${esc(std.date)}` : ''}</span>`;
}

function exchangeHtml(ex) {
  if (!ex) return '';
  if (typeof ex !== 'object') return '';
  if (!ex.request) return `<pre class="ev">${esc(ex.note || JSON.stringify(ex))}</pre>`;
  const rq = ex.request; const rs = ex.response;
  const reqHead = Object.entries(rq.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
  const lines = [`${rq.method || 'GET'} ${rq.url}`, reqHead].filter(Boolean).join('\n');
  let resp;
  if (!rs) resp = `No response: ${ex.error || 'request failed'}`;
  else {
    const h = Object.entries(rs.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
    resp = [`HTTP ${rs.status}${rs.finalUrl && rs.finalUrl !== rq.url ? `  (final URL ${rs.finalUrl})` : ''}  ${rs.bytes ?? 0} bytes${rs.truncated ? ', truncated' : ''}, ${fmtMs(rs.ms)}`, h, '', rs.body ? rs.body : ''].join('\n');
  }
  const redirects = (ex.redirects || []).length ? `<p class="small">Redirects: ${ex.redirects.map((r) => esc(typeof r === 'string' ? r : `${r.status || ''} ${r.url || r.location || ''}`)).join(' → ')}</p>` : '';
  return `<div class="exchange"><p class="small">Request</p><pre class="ev">${esc(lines)}</pre><p class="small">Response</p><pre class="ev">${esc(resp)}</pre>${redirects}</div>`;
}

function exchangeLine(ex) {
  if (!ex || typeof ex !== 'object') return '';
  if (!ex.request) return `<li>${esc(ex.note || JSON.stringify(ex).slice(0, 300))}</li>`;
  const rs = ex.response;
  const res = rs ? `HTTP ${rs.status}${rs.headers?.['content-type'] ? `, ${rs.headers['content-type']}` : ''}, ${fmtMs(rs.ms)}` : `failed: ${ex.error || 'no response'}`;
  return `<li><code>${esc(ex.request.method || 'GET')} ${esc(ex.request.url)}</code> → ${esc(res)} <a href="#ex-${esc(ex.id)}">request and response</a></li>`;
}

function requestsAppendix(report) {
  const list = Object.values(report.exchanges || {});
  if (!list.length) return '';
  return `<section class="card requests" id="requests" aria-labelledby="req-h"><h2 id="req-h">Requests made (${list.length})</h2>
<p class="small">Every request this scan sent, with the response headers and the first 2 KB of each body. Cookies are not stored.</p>
${list.map((ex) => `<details class="sub" id="ex-${esc(ex.id)}"><summary><code>${esc(ex.request?.method || 'GET')} ${esc(ex.request?.url || '')}</code> → ${esc(ex.response ? ex.response.status : 'failed')}</summary>${exchangeHtml(ex)}</details>`).join('\n')}
</section>`;
}

function detailsJson(d) {
  if (d === undefined || d === null) return '';
  let s;
  try { s = JSON.stringify(d, null, 2); } catch { return ''; }
  if (!s || s === '{}' || s === '[]') return '';
  if (s.length > 6000) s = s.slice(0, 6000) + '\n…';
  return `<details class="sub"><summary>Data</summary><pre class="ev">${esc(s)}</pre></details>`;
}

let copyN = 0;
const copyBlock = (label, text, cls = '') => {
  const id = `cp${++copyN}`;
  return `<div class="copyable ${cls}"><div class="copyhead"><span class="small">${esc(label)}</span><button type="button" class="copy" data-copy="${id}" hidden>Copy</button></div><pre id="${id}"><code>${esc(text)}</code></pre></div>`;
};

function findingHtml(c, report, filter) {
  const ex = (c.evidence || []).map((e) => (typeof e === 'number' || typeof e === 'string' ? report.exchanges?.[e] : e)).filter(Boolean);
  const hidden = !matches(c, filter);
  const open = filter?.open === c.id;
  const actionable = c.status === 'fail' || c.status === 'warn';
  const compat = c.compat ? `<p class="compat"><strong>isitagentready rule:</strong> ${statusBadge(c.compat.status === 'unableToCheck' ? 'error' : c.compat.status)} ${esc(c.compat.message || '')}${c.iia ? ` <span class="small">(<code>${esc(c.iia)}</code>)</span>` : ''}</p>` : '';
  const lh = c.lh ? `<p class="small">Lighthouse audit: <code>${esc(c.lh)}</code></p>` : '';
  const fix = [];
  const showFix = !['pass', 'neutral'].includes(c.status);
  if (!showFix) { /* a passing or non-applicable check needs no fix block */ } else if (c.fix?.hint) fix.push(`<p><strong>For this site:</strong> ${esc(c.fix.hint)}</p>`);
  if (showFix && c.fix?.snippet) fix.push(copyBlock('Snippet', c.fix.snippet));
  if (showFix && c.fix?.prompt) fix.push(copyBlock('Fix prompt for a coding agent', c.fix.prompt, 'prompt'));
  return `<details class="finding st-${esc(c.status)}" id="check-${esc(c.id)}" data-status="${esc(c.status)}" data-roles="${esc((c.roles || []).join(' '))}"${hidden ? ' hidden' : ''}${open ? ' open' : ''}>
<summary><span class="sumline">${statusBadge(c.status)} <span class="title">${esc(c.title)}</span></span><span class="msg">${esc(c.message || '')}</span></summary>
<div class="body">
<p class="meta"><code>${esc(c.id)}</code> · ${stdBadge(c.standard)} · weight ${esc(c.weight)}${c.heuristic ? ' · <span class="heur" title="The threshold is this checker\'s own judgement, not a standard\'s.">heuristic</span>' : ''}</p>
${c.why ? `<p><strong>Why it matters:</strong> ${esc(c.why)} <a href="${esc(chapterLink(c.chapter))}">${esc(chapterLabel(c.chapter))}</a>.</p>` : `<p><a href="${esc(chapterLink(c.chapter))}">${esc(chapterLabel(c.chapter))}</a></p>`}
${compat}${lh}
${fix.length ? `<div class="fix${actionable ? ' todo' : ''}"><h4>How to fix it</h4>${fix.join('\n')}</div>` : ''}
${ex.length ? `<div class="evidence"><h4>Evidence</h4><ul>${ex.map(exchangeLine).join('')}</ul></div>` : ''}
${detailsJson(c.details)}
<p class="small">How it is tested: ${esc(c.test || '')}</p>
</div>
</details>`;
}

function matches(c, filter) {
  if (!filter) return true;
  if (filter.role && filter.role !== 'all' && !(c.roles || []).includes(filter.role)) return false;
  if (filter.status?.length && !filter.status.includes(c.status)) return false;
  return true;
}

/** Normalise filter options from query parameters: { role: 'dev', status: ['fail','warn'] } or strings. */
export function parseFilter(q = {}) {
  const get = (k) => (typeof q.get === 'function' ? q.getAll(k) : [].concat(q[k] ?? []));
  const role = get('role')[0];
  const status = get('status').flatMap((s) => String(s).split(',')).filter((s) => STATUSES.includes(s));
  return { role: role && (ROLE_NAMES[role] || role === 'all') ? role : 'all', status };
}

function levelCard(iia) {
  if (!iia) return '';
  const steps = LEVEL_NAMES.map((n, i) => `<li class="${i < iia.level ? 'done' : i === iia.level ? 'cur' : ''}"${i === iia.level ? ' aria-current="step"' : ''}><span class="lv">L${i}</span> ${esc(n)}</li>`).join('');
  const next = iia.next_level ? `<p><strong>Next, Level ${iia.next_level.target} (${esc(iia.next_level.name)}):</strong> ${iia.next_level.requirements.map((r) => `<code>${esc(r)}</code>`).join(', ')}</p>` : '<p>This is the top level.</p>';
  return `<section class="card level" aria-labelledby="lvl-h"><h2 id="lvl-h">isitagentready-compatible level</h2>
<p class="big">Level ${esc(iia.level)}</p><p class="small">${esc(iia.level_name)}</p>
<ol class="steps">${steps}</ol>${next}
<p class="small">Computed with our re-implementation of the 23 published isitagentready checks and level rules${iia.rules_source ? ` (<a href="https://isitagentready.com/llms-full.txt">rules</a>)` : ''}. Cloudflare's live scanner can differ.</p></section>`;
}

function lighthouseCard(lh) {
  if (!lh) return '';
  const rows = lh.audits.map((a) => `<tr><th scope="row"><a href="#check-${esc(a.check)}">${esc(a.id)}</a><br><span class="small">${esc(a.group)}</span></th><td>${a.score === null ? `<span class="muted">${esc(a.display === 'notRun' ? 'not run' : a.display === 'informative' ? 'informative' : 'n/a')}</span>` : esc(a.score)}</td><td>${statusBadge(a.status === 'notRun' ? 'skipped' : a.status)}</td></tr>`).join('');
  return `<section class="card lh" aria-labelledby="lh-h"><h2 id="lh-h">Lighthouse Agentic Browsing view</h2>
<p class="big">${lh.score === null ? '<span class="muted">Not scored</span>' : `${Math.round(lh.score * 100)}%`}</p><p class="small">${esc(lh.passed)} of ${esc(lh.scored)} scored audits pass</p>
<div class="tablewrap"><table><thead><tr><th scope="col">Audit</th><th scope="col">Score</th><th scope="col">Status</th></tr></thead><tbody>${rows}</tbody></table></div>
<p class="small">${esc(lh.note || '')}</p></section>`;
}

function layersCard(layers) {
  const rows = (layers || []).map((l) => {
    const sc = l.applicable ? l.score : null;
    const cls = sc == null ? 'na' : sc >= 90 ? 'good' : sc >= 70 ? 'ok' : sc >= 40 ? 'mid' : 'bad';
    return `<li class="layer ${cls}"><a href="#layer-${esc(l.id)}">${esc(l.name)}</a><meter min="0" max="100" low="40" high="70" optimum="100" value="${sc ?? 0}" aria-label="${esc(l.name)} score">${sc ?? 'n/a'}</meter><span class="val">${sc == null ? '<span class="muted">n/a</span>' : esc(sc)}</span></li>`;
  }).join('');
  return `<section class="card layers" aria-labelledby="layers-h"><h2 id="layers-h">Layers</h2><ul class="bars">${rows}</ul><p class="small">n/a: the layer does not apply to this site (no API, MCP server, shop or OAuth found) or no check could run.</p></section>`;
}

function rolesCard(roles, filter, keep) {
  if (!roles) return '';
  const rows = Object.entries(roles).map(([k, r]) => `<tr><th scope="row"><a href="?${esc(new URLSearchParams({ ...keep, role: k }).toString())}#findings"${filter?.role === k ? ' aria-current="true"' : ''}>${esc(r.name)}</a></th><td>${r.todo.length}</td><td>${r.done.length}</td></tr>`).join('');
  return `<section class="card roles" aria-labelledby="roles-h"><h2 id="roles-h">By role</h2><div class="tablewrap"><table><thead><tr><th scope="col">Role</th><th scope="col">To do</th><th scope="col">Done</th></tr></thead><tbody>${rows}</tbody></table></div><p class="small">Roles from the book's Appendix A checklist.</p></section>`;
}

function filterForm(report, filter, keep) {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, (report.checks || []).filter((c) => c.status === s).length]));
  const roleOpts = [['all', 'All roles'], ...Object.entries(ROLE_NAMES)].map(([k, n]) => `<option value="${k}"${filter.role === k ? ' selected' : ''}>${esc(n)}</option>`).join('');
  const boxes = STATUSES.filter((s) => counts[s]).map((s) => `<label class="check"><input type="checkbox" name="status" value="${s}"${filter.status.includes(s) ? ' checked' : ''} toolparamdescription="Show ${esc(STATUS_LABEL[s])} findings"> ${esc(STATUS_LABEL[s])} (${counts[s]})</label>`).join('');
  return `<form class="filters" id="filters" method="get" action="#findings" toolname="filter_findings" tooldescription="Filter the findings of this report by role and by status. Shows only the matching findings on the page." toolautosubmit>
${Object.entries(keep).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}
<div class="frow"><label for="f-role">Role</label> <select id="f-role" name="role" toolparamdescription="Show findings relevant to one role from the book's Appendix A">${roleOpts}</select></div>
<fieldset><legend>Status (none checked shows all)</legend>${boxes}</fieldset>
<button type="submit">Apply filters</button>
</form>`;
}

/**
 * Full HTML report page.
 * @param {object} report  the scan report (SPEC "Report contract")
 * @param {{ baseUrl?: string, reportId?: string, filter?: object, browserAvailable?: boolean }} [o]
 *   filter: { role, status[] } (see parseFilter) applied server-side as the hidden attribute, so filters work without JS.
 */
export function renderReportHtml(report, { baseUrl = '', reportId, filter, browserAvailable = false } = {}) {
  copyN = 0;
  const f = filter ? { role: filter.role || 'all', status: [].concat(filter.status || []) } : { role: 'all', status: [] };
  const id = reportId || report.id;
  const target = report.final_url || report.url;
  const host = hostOf(target);
  const L = reportLinks(baseUrl, id, host);
  if (!L.html && report.report_url) L.html = report.report_url;
  const iia = report.compat?.isitagentready;
  const lh = report.compat?.lighthouse_agentic;
  const counts = Object.fromEntries(STATUSES.map((s) => [s, (report.checks || []).filter((c) => c.status === s).length]));
  const targetHref = safeHref(target);
  // On an unstored /scan?url= page the filters must keep the url parameter.
  const keep = id ? {} : { url: host, ...(report.mode?.browser ? { browser: '1' } : {}) };

  const byLayer = new Map();
  for (const c of report.checks || []) { if (!byLayer.has(c.layer)) byLayer.set(c.layer, []); byLayer.get(c.layer).push(c); }
  const layerSections = (report.layers || []).map((l) => {
    const cs = (byLayer.get(l.id) || []).sort((a, b) => (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) || ((b.weight || 0) - (a.weight || 0)));
    if (!cs.length) return '';
    const chapters = String(l.chapters || '').split(',').filter(Boolean).map((n) => `<a href="${esc(chapterLink(n))}">${esc(chapterLabel(n.trim()))}</a>`).join(', ');
    return `<section class="layersec" id="layer-${esc(l.id)}" aria-labelledby="lh-${esc(l.id)}">
<h3 id="lh-${esc(l.id)}">${esc(l.name)} <span class="score">${l.applicable ? `${esc(l.score)}/100` : 'n/a'}</span></h3>
<p class="small">${esc(l.summary || '')}. Book: ${chapters}.</p>
${cs.map((c) => findingHtml(c, report, f)).join('\n')}
<p class="nomatch small" hidden>No findings in this layer match the filters.</p>
</section>`;
  }).join('\n');

  const prompts = renderFixPrompts(report, { baseUrl, reportId: id });
  const todo = counts.fail + counts.warn;
  const browserNote = report.mode?.browser
    ? `with a real browser${report.mode.browser_error ? ` (the browser run failed: ${esc(report.mode.browser_error)})` : ''}`
    : `without a browser, so ${esc(counts.skipped)} browser-only checks were skipped${browserAvailable ? ` (<a href="/scan?url=${esc(encodeURIComponent(target))}&amp;browser=1">scan again with the browser</a>)` : ''}`;

  const legend = Object.entries(MATURITY_LABEL).map(([k, v]) => `<li><span class="std std-${k}">${esc(v.label)}</span> ${esc(v.text)}</li>`).join('');
  const differences = (report.differences || []).map((d) => `<li><strong>${esc(d.topic)}.</strong> ${esc(d.text)}</li>`).join('');
  const share = L.html || L.badge ? `<section class="card share" aria-labelledby="share-h"><h2 id="share-h">Share</h2>
${L.html ? `<p>Report link (kept 30 days): <a href="${esc(L.html)}">${esc(L.html)}</a></p>` : ''}
${L.badge ? `<p><img src="${esc(L.badge)}" alt="Agent-Ready badge for ${esc(host)}" width="${badgeWidth({ score: report.score, level: iia?.level })}" height="20"></p>${copyBlock('Badge Markdown', `[![Agent-Ready score](${L.badge})](${L.html || L.rescan || L.badge})`)}` : ''}
<p>Also as ${L.json ? `<a href="${esc(L.json)}">JSON</a>, ` : ''}${L.markdown ? `<a href="${esc(L.markdown)}">Markdown</a>, ` : ''}${L.prompts ? `<a href="${esc(L.prompts)}">fix prompts</a>` : ''}.</p></section>` : '';

  const body = `<div class="top">
<section class="summary" aria-labelledby="sum-h">
<h1 id="sum-h">Agent-readiness of <span class="host">${esc(host)}</span></h1>
<p class="muted">${targetHref ? `<a href="${esc(targetHref)}" rel="nofollow noopener">${esc(target)}</a>` : esc(target)} · scanned <time datetime="${esc(report.scanned_at)}">${esc(String(report.scanned_at || '').replace('T', ' ').slice(0, 16))} UTC</time> in ${esc(fmtMs(report.duration_ms))} · ${esc(report.requests)} requests · ${browserNote}</p>
<div class="hero">${ring(report.score)}<div><p class="big">${esc(grade(report.score))}</p>
<p><strong>${esc(counts.pass)}</strong> pass · <strong>${esc(counts.warn)}</strong> warnings · <strong>${esc(counts.fail)}</strong> fail · ${esc(counts.neutral)} not applicable · ${esc(counts.skipped)} skipped${counts.error ? ` · ${esc(counts.error)} errors` : ''}</p>
<p class="small">Score: the layer scores weighted by layer importance; each check weighs severity × standard maturity. <a href="/checks">How scoring works</a>.</p></div></div>
</section>
${scanForm({ value: host, browserAvailable, id: 'rescan', compact: true })}
</div>
<div class="grid">
${layersCard(report.layers)}
${levelCard(iia)}
${lighthouseCard(lh)}
${rolesCard(report.roles, f, keep)}
</div>
<section id="findings" aria-labelledby="find-h">
<h2 id="find-h">Findings</h2>
<div class="toolbar">
${filterForm(report, f, keep)}
<div class="actions"><a class="btn" href="${esc(L.prompts || '#all-fix-prompts')}" data-copy-all="all-prompts-text">Copy all fix prompts (${todo})</a></div>
</div>
<details class="legend"><summary>What the standard badges mean</summary><ul>${legend}</ul><p class="small">Weights are an opinion of this checker, stated so you can disagree with them.</p></details>
${layerSections}
<details class="allprompts" id="all-fix-prompts"><summary>All fix prompts as one Markdown prompt</summary><pre id="all-prompts-text"><code>${esc(prompts)}</code></pre></details>
</section>
${requestsAppendix(report)}
<section class="card differences" aria-labelledby="diff-h"><h2 id="diff-h">Where we differ from Cloudflare's isitagentready</h2><ul>${differences}</ul></section>
${share}
<p class="live" id="live" role="status" aria-live="polite"></p>`;

  return shell({
    base: baseUrl, path: L.html ? new URL(L.html, 'https://x.invalid').pathname : `/scan?url=${encodeURIComponent(host)}`,
    title: `Agent-readiness of ${host}: ${report.score}/100`,
    description: `${host} scores ${report.score}/100 for agent-readiness${iia ? ` and reaches isitagentready-compatible Level ${iia.level} (${iia.level_name})` : ''}: ${counts.fail} failing and ${counts.warn} warning checks, with fixes.`,
    body, noindex: true, mdPath: L.markdown,
    jsonld: { '@context': 'https://schema.org', '@type': 'WebPage', name: `Agent-readiness of ${host}`, about: { '@type': 'WebSite', url: target }, dateCreated: report.scanned_at, isPartOf: { '@type': 'WebSite', name: SITE.name } },
  });
}

/**
 * Landing page.
 * @param {{ baseUrl?: string, browserAvailable?: boolean, recent?: Array<{host, score, level, url}> }} [o]
 */
export function renderHomeHtml({ baseUrl = '', browserAvailable = false } = {}) {
  const b = String(baseUrl || '').replace(/\/+$/, '');
  const body = `<section class="intro" aria-labelledby="home-h">
<h1 id="home-h">Is your site ready for AI agents?</h1>
<p class="lead">${esc(SITE.checksCount)} checks across ${esc(SITE.layersCount)} layers, from the accessibility tree and robots.txt to MCP, WebMCP, agent discovery and commerce. Every finding comes with evidence, a fix and a prompt for your coding agent.</p>
${scanForm({ browserAvailable, id: 'scan' })}
</section>
<section class="grid three" aria-label="What you get">
<div class="card"><h2>Your score, and theirs</h2><p>An Agent-Ready score per layer, an <strong>isitagentready-compatible Level 0–5</strong> and a <strong>Lighthouse Agentic Browsing</strong> view side by side, with the places where we score differently explained.</p></div>
<div class="card"><h2>Evidence and fixes</h2><p>Each finding shows the request and response it is based on, why it matters with a link to the book chapter, a copy-paste snippet and a fix prompt for coding agents.</p></div>
<div class="card"><h2>Honest about standards</h2><p>Every check shows whether it rests on an RFC, a draft or a vendor proposal. Drafts weigh less, so you don't over-invest in something that may change next month.</p></div>
</section>
<section class="card" aria-labelledby="layers-list-h"><h2 id="layers-list-h">The 13 layers</h2>
<p>Perception · Crawler access · Structured data · Agent-readable content · APIs · MCP · WebMCP · Discovery · Commerce · Identity and auth · Security · Privacy and consent · Performance and stability. <a href="/checks">See all ${esc(SITE.checksCount)} checks</a>.</p></section>
<section class="card" aria-labelledby="agents-h"><h2 id="agents-h">For agents and CI</h2>
<p>This service is agent-ready itself: a <a href="/docs">JSON API</a> (<a href="/openapi.json">OpenAPI</a>), an MCP server at <code>${esc(b || '')}/mcp</code> with a <code>scan_site</code> tool, a WebMCP <code>scan_site</code> tool on this page, an <a href="/.well-known/agent-skills/index.json">Agent Skill</a> and <a href="/llms.txt">llms.txt</a>. In CI: <code>npx agent-ready-check example.com --fail-under 70</code>.</p></section>
<section class="card" aria-labelledby="book-h"><h2 id="book-h">Based on a book</h2>
<p>The checks, thresholds and fixes come from <cite>${esc(BOOK.title)}</cite> by ${esc(BOOK.author)}, and its tested demos at <a href="${esc(BOOK.demos)}">github.com/webmaxru/agent-ready-web-demos</a> (MIT). Standards and statuses were read on ${esc(SITE.updated?.checks || '')}.</p></section>`;
  return shell({
    base: b, path: '/', title: SITE.name, description: SITE.description, body,
    jsonld: { '@context': 'https://schema.org', '@graph': [
      { '@type': 'WebSite', '@id': b ? `${b}/#website` : undefined, name: SITE.name, url: b ? `${b}/` : undefined, description: SITE.description, publisher: { '@id': b ? `${b}/#org` : undefined } },
      { '@type': 'Organization', '@id': b ? `${b}/#org` : undefined, name: SITE.name, url: b ? `${b}/` : undefined },
      { '@type': 'WebApplication', name: SITE.name, url: b ? `${b}/` : undefined, applicationCategory: 'DeveloperApplication', operatingSystem: 'Any', description: SITE.description, isAccessibleForFree: true, license: 'https://opensource.org/licenses/MIT', author: { '@type': 'Person', name: SITE.author } },
    ] },
  });
}
