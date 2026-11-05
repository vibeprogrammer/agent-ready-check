// HTML renderers: the report page and the landing page. Runtime-neutral (Node and Workers), no inline scripts or styles
// (the server's CSP allows only 'self').
//
// DECISION (H3): the landing page is rendered by renderHomeHtml({ baseUrl }) rather than a static public/index.html,
// so the server can fill in the base URL, canonical link and the browser-checks option. The stylesheet, the client
// script and the fonts are strings in src/report/assets.mjs (ASSETS), served by the server at /assets/*; that works the
// same in Node and in the Worker without a static-assets binding. public/ is not used.
//
// Design (v0.2.0): a pixel theme, documented in docs/DESIGN.md. Icons are tiny SVGs drawn from pixel grids (pixelSvg);
// every status is shown as colour, a distinct glyph and a text label.
//
// Every string that comes from a scanned site (messages, evidence, headers, bodies, details) is escaped with esc();
// only http(s) URLs become links (safeHref).
import { esc, safeHref, STATUS_LABEL, STATUS_ORDER, MATURITY_LABEL, ROLE_NAMES, grade, hostOf, fmtMs } from './util.mjs';
import { chapterLink, chapterLabel, reportLinks, BOOK } from './links.mjs';
import { renderFixPrompts } from './markdown.mjs';
import { badgeWidth } from './badge.mjs';
import { SITE } from '../agent-files/site.mjs';
import catalog from '../catalog.json' with { type: 'json' };

export const ASSET_VERSION = '2';
const LEVEL_NAMES = ['Not Ready', 'Basic Web Presence', 'Bot-Aware', 'Agent-Readable', 'Agent-Integrated', 'Agent-Native'];
const STATUSES = ['fail', 'warn', 'pass', 'info', 'error', 'skipped', 'neutral'];

/** A pixel-art SVG from rows of '#' (on) and '.' (off). Decorative: aria-hidden. */
export function pixelSvg(rows, { size = 14, cls = 'px', fill = 'currentColor' } = {}) {
  const w = Math.max(...rows.map((r) => r.length)); const h = rows.length;
  let d = '';
  rows.forEach((row, y) => { for (const m of row.matchAll(/#+/g)) d += `M${m.index} ${y}h${m[0].length}v1h-${m[0].length}z`; });
  const px = Math.round((size * w) / Math.max(w, h));
  return `<svg class="${cls}" viewBox="0 0 ${w} ${h}" width="${px}" height="${Math.round((px * h) / w)}" aria-hidden="true" focusable="false"><path d="${d}" fill="${fill}"/></svg>`;
}

// One 7x7 glyph per status, each a different shape (colour-blind safe together with the label).
const GLYPHS = {
  pass: ['.......', '......#', '.....##', '#...##.', '##.##..', '.###...', '..#....'],
  fail: ['#.....#', '##...##', '.##.##.', '..###..', '.##.##.', '##...##', '#.....#'],
  warn: ['..###..', '..###..', '..###..', '..###..', '.......', '..###..', '..###..'],
  info: ['..##...', '.......', '.###...', '..##...', '..##...', '..##...', '.####..'],
  error: ['.#####.', '##...##', '....##.', '...##..', '...##..', '.......', '...##..'],
  neutral: ['.......', '.......', '.......', '#######', '.......', '.......', '.......'],
  skipped: ['#######', '#.....#', '#.....#', '#.....#', '#.....#', '#.....#', '#######'],
};
export const statusGlyph = (st, size = 14) => pixelSvg(GLYPHS[st] || GLYPHS.error, { size });

const LOGO_ROWS = ['..........', '........#.', '.......##.', '......##..', '.#...##...', '.##.##....', '..###.....', '...#......', '..........', '..........'];
const LOGO = pixelSvg(LOGO_ROWS, { size: 32, cls: 'logo' })
  .replace('<path', '<rect width="10" height="10" fill="#1e162b"/><path').replace('fill="currentColor"', 'fill="#5fed83"');

const band = (s) => (s == null ? 'na' : s >= 90 ? 'good' : s >= 70 ? 'ok' : s >= 40 ? 'mid' : 'bad');
const blocks = (n, on) => Array.from({ length: n }, (_, i) => `<span${i < on ? ' class="on"' : ''}></span>`).join('');

/** Page shell shared by the landing page, reports, docs and error pages: landmarks, skip link, nav, footer. */
export function shell({ base = '', path = '/', title, description, body, head = '', noindex = false, mdPath = null, jsonld = null }) {
  const b = String(base || '').replace(/\/+$/, '');
  const full = title === SITE.name ? title : `${title} | ${SITE.name}`;
  const canonical = b ? `${b}${path}` : null;
  const cur = (p) => (path === p || (p !== '/' && path.startsWith(`${p}`)) ? ' aria-current="page"' : '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(full)}</title>
<meta name="description" content="${esc(description)}">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#1e162b">
${noindex ? '<meta name="robots" content="noindex">\n' : ''}${canonical ? `<link rel="canonical" href="${esc(canonical)}">\n` : ''}${mdPath ? `<link rel="alternate" type="text/markdown" href="${esc(mdPath)}">\n` : ''}<link rel="preload" href="/assets/fonts/silkscreen-700.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/silkscreen-400.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/app.css?v=${ASSET_VERSION}">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<meta property="og:title" content="${esc(full)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
${canonical ? `<meta property="og:url" content="${esc(canonical)}">\n` : ''}${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, '\\u003c')}</script>\n` : ''}${head}<script type="module" src="/assets/app.js?v=${ASSET_VERSION}"></script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site">
<a class="brand" href="/">${LOGO}${esc(SITE.name)}</a>
<nav aria-label="Main">
<a href="/"${path === '/' ? ' aria-current="page"' : ''}>Scan</a>
<a href="/docs"${cur('/docs')}>API and MCP</a>
<a href="/checks"${cur('/checks')}>Checks</a>
<a href="${esc(SITE.repo)}">Source</a>
</nav>
</header>
<div class="colorbar" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>
<main id="main">
${body}
</main>
<footer class="site">
<div class="colorbar" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>
<div class="wrap">
<div>
<p class="fname">${esc(SITE.name)} ${esc(SITE.version)}</p>
<p>MIT licensed. The checks and fixes come from the book <cite>${esc(BOOK.title)}</cite> by ${esc(BOOK.author)} and its <a href="${esc(BOOK.demos)}">demos</a>. Not affiliated with Cloudflare or Google.</p>
</div>
<ul aria-label="More">
<li><a href="/docs">API, MCP and CLI</a></li>
<li><a href="/llms.txt">llms.txt</a></li>
<li><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></li>
<li><a href="${esc(SITE.repo)}">Source code</a></li>
</ul>
</div>
</footer>
</body>
</html>
`;
}

/** The scan form: a real GET form to /scan, and a declarative WebMCP tool (scan_site). */
export function scanForm({ value = '', browserAvailable = false, id = 'scan', compact = false, tool = true } = {}) {
  const t = tool ? ' toolname="scan_site" tooldescription="Scan a website for agent-readiness: 113 checks in 13 layers (robots.txt and AI crawlers, structured data, Markdown and llms.txt, APIs, MCP, WebMCP, discovery, commerce, identity, security, privacy, performance). Returns the score, the isitagentready-compatible level and the findings with fixes." toolautosubmit' : '';
  return `<form class="scan${compact ? ' compact' : ''}" id="${esc(id)}" action="/scan" method="get" role="search"${t}>
<label for="${esc(id)}-url">${compact ? 'Scan again' : 'Website address'}</label>
<div class="row">
<input id="${esc(id)}-url" name="url" type="text" inputmode="url" autocomplete="url" spellcheck="false" required placeholder="example.com" value="${esc(value)}"${tool ? ' toolparamdescription="The site or page to scan: a domain like example.com or a full https URL. Public addresses only."' : ''}>
<button type="submit">Scan</button>
</div>
${browserAvailable ? `<label class="check"><input type="checkbox" name="browser" value="1"${tool ? ' toolparamdescription="Also run the browser checks (accessibility tree, axe rules, WebMCP tools, CLS). Slower."' : ''}>${compact ? ' Also run the browser checks (slower)' : ' Also run the browser checks: accessibility tree, WebMCP tools, layout shift (slower)'}</label>\n` : ''}<p class="status" id="${esc(id)}-status" role="status" aria-live="polite"></p>
</form>`;
}

const statusBadge = (st) => `<span class="st st-${esc(st)}">${statusGlyph(st)}${esc(STATUS_LABEL[st] || st)}</span>`;

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
  return `<section class="band requests" id="requests" aria-labelledby="req-h"><h2 id="req-h" class="sh">Requests made (${list.length})</h2>
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

/** The six levels as pixel stairs. level = null shows the scale without a current step (landing page). */
function ladder(level = null) {
  return `<ol class="ladder" aria-label="isitagentready-compatible levels">${LEVEL_NAMES.map((n, i) => {
    const cls = level == null ? '' : i < level ? ' done' : i === level ? ' cur' : '';
    return `<li class="s${i}${cls}"${level === i ? ' aria-current="step"' : ''}><span class="bar">L${i}</span><span class="ln">${esc(n)}</span></li>`;
  }).join('')}</ol>`;
}

function levelPanel(iia) {
  if (!iia) return '<div><h2>isitagentready-compatible level</h2><p>Not computed for this scan.</p></div>';
  const next = iia.next_level
    ? `<div class="next"><p><strong>To reach Level ${esc(iia.next_level.target)}, ${esc(iia.next_level.name)}:</strong></p><ul>${iia.next_level.requirements.map((r) => `<li><code>${esc(r)}</code></li>`).join('')}</ul></div>`
    : '<div class="next"><p>This is the top level.</p></div>';
  return `<div><h2 id="lvl-h">isitagentready-compatible level: L${esc(iia.level)}, ${esc(iia.level_name)}</h2>
${ladder(iia.level)}${next}
<p class="small">Computed with our re-implementation of the 23 published isitagentready checks and level rules${iia.rules_source ? ` (<a href="https://isitagentready.com/llms-full.txt">rules</a>)` : ''}. Cloudflare's live scanner can differ.</p></div>`;
}

function lighthouseTable(lh) {
  if (!lh) return '';
  const rows = lh.audits.map((a) => `<tr><th scope="row"><a href="#check-${esc(a.check)}">${esc(a.id)}</a><br><span class="small">${esc(a.group)}</span></th><td class="num">${a.score === null ? `<span class="muted">${esc(a.display === 'notRun' ? 'not run' : a.display === 'informative' ? 'informative' : 'n/a')}</span>` : esc(a.score)}</td><td>${statusBadge(a.status === 'notRun' ? 'skipped' : a.status)}</td></tr>`).join('');
  return `<section class="lh" aria-labelledby="lh-h"><h2 id="lh-h" class="sh">Lighthouse Agentic Browsing view</h2>
<p class="lhscore">${lh.score === null ? '<span class="muted">Not scored</span>' : `${Math.round(lh.score * 100)}%`}</p><p class="small">${esc(lh.passed)} of ${esc(lh.scored)} scored audits pass. ${esc(lh.note || '')}</p>
<div class="tablewrap"><table><thead><tr><th scope="col">Audit</th><th scope="col">Score</th><th scope="col">Status</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function layersList(layers) {
  const rows = (layers || []).map((l) => {
    const sc = l.applicable ? l.score : null;
    return `<li class="${band(sc)}"><a href="#layer-${esc(l.id)}">${esc(l.name)}</a><span class="mini band-${band(sc)}" aria-hidden="true">${blocks(10, sc == null ? 0 : Math.round(sc / 10))}</span><span class="val">${sc == null ? 'n/a' : esc(sc)}</span></li>`;
  }).join('');
  return `<section class="band" aria-labelledby="layers-h"><h2 id="layers-h" class="sh">Layers</h2><ul class="layers">${rows}</ul><p class="small">Score out of 100 per layer. n/a: the layer does not apply to this site (no API, MCP server, shop or OAuth found) or no check could run.</p></section>`;
}

function rolesTable(roles, filter, keep) {
  if (!roles) return '';
  const rows = Object.entries(roles).map(([k, r]) => `<tr><th scope="row"><a href="?${esc(new URLSearchParams({ ...keep, role: k }).toString())}#findings"${filter?.role === k ? ' aria-current="true"' : ''}>${esc(r.name)}</a></th><td class="num">${r.todo.length}</td><td class="num">${r.done.length}</td></tr>`).join('');
  return `<section class="roles" aria-labelledby="roles-h"><h2 id="roles-h" class="sh">By role</h2><div class="tablewrap"><table><thead><tr><th scope="col">Role</th><th scope="col">To do</th><th scope="col">Done</th></tr></thead><tbody>${rows}</tbody></table></div><p class="small">Roles from the book's Appendix A checklist.</p></section>`;
}

function filterForm(report, filter, keep) {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, (report.checks || []).filter((c) => c.status === s).length]));
  const roleOpts = [['all', 'All roles'], ...Object.entries(ROLE_NAMES)].map(([k, n]) => `<option value="${k}"${filter.role === k ? ' selected' : ''}>${esc(n)}</option>`).join('');
  const boxes = STATUSES.filter((s) => counts[s]).map((s) => `<label class="check"><input type="checkbox" name="status" value="${s}"${filter.status.includes(s) ? ' checked' : ''} toolparamdescription="Show ${esc(STATUS_LABEL[s])} findings"> ${esc(STATUS_LABEL[s])} (${counts[s]})</label>`).join('');
  return `<form class="filters" id="filters" method="get" action="#findings" toolname="filter_findings" tooldescription="Filter the findings of this report by role and by status. Shows only the matching findings on the page." toolautosubmit>
${Object.entries(keep).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}
<div class="frow"><label for="f-role">Role</label> <select id="f-role" name="role" toolparamdescription="Show findings relevant to one role from the book's Appendix A">${roleOpts}</select></div>
<fieldset><legend>Status (none checked shows all)</legend>${boxes}</fieldset>
<button type="submit" class="quiet">Apply filters</button>
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
  const score = report.score == null ? null : Math.max(0, Math.min(100, Math.round(report.score)));

  const byLayer = new Map();
  for (const c of report.checks || []) { if (!byLayer.has(c.layer)) byLayer.set(c.layer, []); byLayer.get(c.layer).push(c); }
  const layerSections = (report.layers || []).map((l) => {
    const cs = (byLayer.get(l.id) || []).sort((a, b) => (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) || ((b.weight || 0) - (a.weight || 0)));
    if (!cs.length) return '';
    const sc = l.applicable ? l.score : null;
    const chapters = String(l.chapters || '').split(',').filter(Boolean).map((n) => `<a href="${esc(chapterLink(n))}">${esc(chapterLabel(n.trim()))}</a>`).join(', ');
    return `<section class="layersec" id="layer-${esc(l.id)}" aria-labelledby="lh-${esc(l.id)}">
<header><h3 id="lh-${esc(l.id)}">${esc(l.name)}</h3><span class="mini band-${band(sc)}" aria-hidden="true">${blocks(10, sc == null ? 0 : Math.round(sc / 10))}</span><span class="lscore">${sc == null ? 'n/a' : `${esc(sc)}/100`}</span></header>
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

  const tally = [['pass', counts.pass], ['warn', counts.warn], ['fail', counts.fail]].map(([s, n]) => `<li>${statusBadge(s)} <span>${esc(n)}</span></li>`).join('');
  const legend = Object.entries(MATURITY_LABEL).map(([k, v]) => `<li><span class="std std-${k}">${esc(v.label)}</span> ${esc(v.text)}</li>`).join('');
  const share = L.html || L.badge ? `<section class="band share" aria-labelledby="share-h"><h2 id="share-h" class="sh">Share</h2>
${L.html ? `<p>Report link, kept 30 days: <a href="${esc(L.html)}">${esc(L.html)}</a></p>` : ''}
${L.badge ? `<p class="badge"><img src="${esc(L.badge)}" alt="Agent-Ready badge for ${esc(host)}" width="${badgeWidth({ score: report.score, level: iia?.level })}" height="20"></p>${copyBlock('Badge Markdown', `[![Agent-Ready score](${L.badge})](${L.html || L.rescan || L.badge})`)}` : ''}
<p>Also as ${L.json ? `<a href="${esc(L.json)}">JSON</a>, ` : ''}${L.markdown ? `<a href="${esc(L.markdown)}">Markdown</a>, ` : ''}${L.prompts ? `<a href="${esc(L.prompts)}">fix prompts</a>` : ''}.</p></section>` : '';

  const body = `${scanForm({ value: host, browserAvailable, id: 'rescan', compact: true })}
<section class="rhead" aria-labelledby="sum-h">
<div class="console">
<div>
<h1 id="sum-h">Agent-readiness of <span class="host">${esc(host)}</span></h1>
<p class="small">${targetHref ? `<a href="${esc(targetHref)}" rel="nofollow noopener">${esc(target)}</a>` : esc(target)} · <time datetime="${esc(report.scanned_at)}">${esc(String(report.scanned_at || '').replace('T', ' ').slice(0, 16))} UTC</time> · ${esc(fmtMs(report.duration_ms))} · ${esc(report.requests)} requests · ${browserNote}</p>
<div class="score band-${band(score)}" role="img" aria-label="Agent-Ready score ${score == null ? 'not available' : `${score} out of 100`}"><span class="num">${score == null ? '–' : score}</span><span class="of">/100</span></div>
<div class="meter band-${band(score)}" aria-hidden="true">${blocks(20, score == null ? 0 : Math.round(score / 5))}</div>
<p class="grade">${esc(grade(report.score))}</p>
<ul class="tally" aria-label="Check results">${tally}</ul>
<p class="small">${esc(counts.neutral)} not applicable · ${esc(counts.skipped)} skipped · ${esc(counts.info)} info${counts.error ? ` · ${esc(counts.error)} errors` : ''}. The score weighs each layer by importance and each check by severity and standard maturity. <a href="/checks">How scoring works</a>.</p>
</div>
${levelPanel(iia)}
</div>
</section>
${layersList(report.layers)}
<div class="band tables">
${lighthouseTable(lh)}
${rolesTable(report.roles, f, keep)}
</div>
<section class="band" id="findings" aria-labelledby="find-h">
<h2 id="find-h" class="sh">Findings</h2>
<div class="toolbar">
${filterForm(report, f, keep)}
<div class="actions"><a class="btn" href="${esc(L.prompts || '#all-fix-prompts')}" data-copy-all="all-prompts-text">Copy all fix prompts (${todo})</a></div>
</div>
<details class="legend"><summary>What the standard badges mean</summary><ul>${legend}</ul><p class="small">Weights are an opinion of this checker, stated so you can disagree with them.</p></details>
${layerSections}
<details class="allprompts" id="all-fix-prompts"><summary>All fix prompts as one Markdown prompt</summary><pre id="all-prompts-text"><code>${esc(prompts)}</code></pre></details>
</section>
${requestsAppendix(report)}
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
 * @param {{ baseUrl?: string, browserAvailable?: boolean }} [o]
 */
export function renderHomeHtml({ baseUrl = '', browserAvailable = false } = {}) {
  const b = String(baseUrl || '').replace(/\/+$/, '');
  const perLayer = {};
  for (const c of catalog.checks || []) perLayer[c.layer] = (perLayer[c.layer] || 0) + 1;
  const layers = (catalog.layers || []).map((l, i) => `<li><span class="n" aria-hidden="true">${String(i + 1).padStart(2, '0')}</span><span class="nm">${esc(l.name)}</span><span class="ct">${esc(perLayer[l.id] || 0)} checks</span><span class="sm">${esc(l.summary || '')}</span></li>`).join('');
  const weights = Object.entries(MATURITY_LABEL).map(([k, v]) => `<li><span class="std std-${k}">${esc(v.label)}</span><span>${esc(v.text)}</span></li>`).join('');
  const body = `<section class="intro" aria-labelledby="home-h">
<div>
<p class="kicker">${esc(SITE.checksCount)} checks · ${esc(SITE.layersCount)} layers</p>
<h1 id="home-h">Check your site for AI agents</h1>
<p class="lead">Enter an address. Agent-Ready Check reads it the way crawlers, assistants and browser agents do: robots.txt, structured data, Markdown, APIs, MCP, WebMCP and more. Every finding shows the request it rests on and how to fix it.</p>
${scanForm({ browserAvailable, id: 'scan' })}
</div>
<aside class="readout" aria-labelledby="out-h">
<h2 id="out-h">What you get back</h2>
<p class="scoreline"><b>0–100</b> score, per layer and overall</p>
${ladder(null)}
<p>A level from L0 to L5 by isitagentready's published rules, a Lighthouse Agentic Browsing view, and a list of fixes in order of weight.</p>
</aside>
</section>
<section aria-labelledby="layers-list-h">
<h2 id="layers-list-h" class="sh">What it checks</h2>
<ol class="layerlist">${layers}</ol>
<p class="small"><a href="/checks">All ${esc(SITE.checksCount)} checks with their tests and sources</a></p>
</section>
<section class="twocol" aria-label="Findings and weights">
<div>
<h2 class="sh">Every finding comes with</h2>
<dl class="gets">
<div><dt>Evidence</dt><dd>The exact request and response it is based on.</dd></div>
<div><dt>Why</dt><dd>Why it matters for agents, with a link to the chapter of the book.</dd></div>
<div><dt>Fix</dt><dd>A snippet you can copy, adapted to your site where possible.</dd></div>
<div><dt>Prompt</dt><dd>A fix prompt for your coding agent, or all of them at once.</dd></div>
</dl>
</div>
<div>
<h2 class="sh">Weighted by maturity</h2>
<ul class="weights">${weights}</ul>
</div>
</section>
<section class="term" aria-labelledby="agents-h">
<h2 id="agents-h" class="sh">For agents and CI</h2>
<pre><code><span class="prompt">$</span> npx agent-ready-check example.com --fail-under 70
<span class="prompt">POST</span> ${esc(b)}/api/scan <span class="dim">{"url":"example.com"}</span>
<span class="prompt">MCP</span>  ${esc(b)}/mcp <span class="dim">tool: scan_site</span></code></pre>
<p>This page is a WebMCP tool too: the scan form above is <code>scan_site</code>.</p>
<ul class="links"><li><a href="/docs">API, MCP and CLI docs</a></li><li><a href="/openapi.json">OpenAPI</a></li><li><a href="/.well-known/agent-skills/index.json">Agent Skill</a></li><li><a href="/llms.txt">llms.txt</a></li></ul>
</section>
<section aria-labelledby="book-h">
<h2 id="book-h" class="sh">Where the checks come from</h2>
<p>The checks, thresholds and fixes come from <cite>${esc(BOOK.title)}</cite> by ${esc(BOOK.author)} and its tested demos at <a href="${esc(BOOK.demos)}">github.com/webmaxru/agent-ready-web-demos</a> (MIT). Standards and their status were last read on ${esc(SITE.updated?.checks || '')}.</p>
</section>`;
  return shell({
    base: b, path: '/', title: SITE.name, description: SITE.description, body,
    jsonld: { '@context': 'https://schema.org', '@graph': [
      { '@type': 'WebSite', '@id': b ? `${b}/#website` : undefined, name: SITE.name, url: b ? `${b}/` : undefined, description: SITE.description, publisher: { '@id': b ? `${b}/#org` : undefined } },
      { '@type': 'Organization', '@id': b ? `${b}/#org` : undefined, name: SITE.name, url: b ? `${b}/` : undefined },
      { '@type': 'WebApplication', name: SITE.name, url: b ? `${b}/` : undefined, applicationCategory: 'DeveloperApplication', operatingSystem: 'Any', description: SITE.description, isAccessibleForFree: true, license: 'https://opensource.org/licenses/MIT', author: { '@type': 'Person', name: SITE.author } },
    ] },
  });
}
