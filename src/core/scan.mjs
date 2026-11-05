// scan(): run every check against one URL and build the report.
import { SafeFetcher, VERSION, DEFAULT_UA } from './fetcher.mjs';
import { ScanContext } from './context.mjs';
import { CHECKS, LAYERS, catalog } from '../checks/index.mjs';
import { commerceSignals } from './discover.mjs';
import { effectiveWeight, layerScores, overallScore, iiaCompat, lighthouseView, roleView } from './score.mjs';

export { VERSION };

/** Accept "example.com", "https://example.com/path"; reject other schemes. */
export function normalizeUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw Object.assign(new Error('url is required'), { status: 400 });
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { throw Object.assign(new Error(`not a valid URL: ${input}`), { status: 400 }); }
  if (!['http:', 'https:'].includes(u.protocol)) throw Object.assign(new Error('only http and https URLs can be scanned'), { status: 400 });
  u.hash = '';
  return u;
}

const CHECK_TIMEOUT_MS = 45_000;
const APPLIES_WORDS = { commerce: 'no shop signals found', api: 'no public API found', mcp: 'no MCP server found', auth: 'no OAuth metadata or MCP auth found', forms: 'the page has no forms' };

/**
 * @param {string} input  URL
 * @param {object} o
 * @param {Function} o.transport  see SafeFetcher
 * @param {Function} o.resolve
 * @param {boolean} [o.allowPrivate]
 * @param {object|Promise<object>|null} [o.browserData]   result of src/browser/collect.mjs, or a promise of it
 * @param {string[]} [o.only]   run only these check ids (tests)
 * @param {string} [o.runtime]  'node' | 'worker' | 'cli'
 * @param {object} [o.fetcherOptions]
 */
export async function scan(input, o) {
  const started = Date.now();
  const url = normalizeUrl(input);
  const fetcher = new SafeFetcher({ transport: o.transport, resolve: o.resolve, allowPrivate: o.allowPrivate, userAgent: o.userAgent || DEFAULT_UA, ...(o.fetcherOptions || {}) });
  const ctx = new ScanContext({ url, fetcher, browser: o.browserData ?? null, options: o });
  const list = o.only ? CHECKS.filter((c) => o.only.includes(c.id)) : CHECKS;

  const results = await Promise.all(list.map(async (meta) => {
    const base = { id: meta.id, layer: meta.layer, title: meta.title, severity: meta.severity, weight: effectiveWeight(meta), standard: { key: meta.standard, ...meta.standardInfo }, chapter: meta.chapter, iia: meta.iia, lh: meta.lh, roles: meta.roles.split(','), heuristic: meta.heuristic, requires: meta.requires, applies: meta.applies, test: meta.test, why: meta.impl?.why || null, fix: { snippet: meta.impl?.fix?.snippet || null, prompt: meta.impl?.fix?.prompt || null, hint: null } };
    let r;
    try {
      if (!meta.impl) r = { status: 'skipped', message: 'Not implemented yet in this version.' };
      else if (meta.requires === 'browser' && !(await ctx.browserData())) r = { status: 'skipped', message: 'Needs a real browser run (CLI --browser, or a deployment with the browser runner).' };
      else if (meta.applies !== 'always' && meta.applies !== 'optin' && !meta.iia && !(await ctx.applies(meta.applies))) r = { status: 'neutral', message: `Not applicable: ${APPLIES_WORDS[meta.applies] || meta.applies}.` };
      else r = await withTimeout(meta.impl.run(ctx), CHECK_TIMEOUT_MS, meta.id);
    } catch (e) {
      r = { status: 'error', message: `The check failed to run: ${e?.message || e}` };
    }
    if (meta.applies === 'optin' && r.status === 'fail') r = { ...r, status: 'neutral', message: `Opt-in, not scored: ${r.message}` };
    else if (meta.iia && meta.applies !== 'always' && meta.applies !== 'optin' && ['fail', 'warn'].includes(r.status) && !(await ctx.applies(meta.applies))) r = { ...r, status: 'neutral', message: `Not applicable (${APPLIES_WORDS[meta.applies]}): ${r.message}` };
    const evidence = (r.evidence || []).map((e) => (e && typeof e.id === 'number' && e.requestHeaders ? e.id : e)).filter((e) => e !== undefined && e !== null);
    return { ...base, status: r.status, message: r.message, details: r.details, evidence, compat: r.compat, fix: { ...base.fix, hint: r.fix || null } };
  }));

  const exchanges = Object.fromEntries(fetcher.log.map((ex) => [ex.id, SafeFetcher.evidence(ex)]));
  const layers = layerScores(LAYERS, results);
  const commerce = await commerceSignals(ctx).catch(() => ({ isCommerce: false, signals: [] }));
  const home = await ctx.home();
  const browserData = await ctx.browserData();
  return {
    tool: { name: 'agent-ready-check', version: VERSION, catalog_checked: catalog.checked, checks: CHECKS.length },
    url: url.href,
    final_url: home.finalUrl,
    scanned_at: new Date(started).toISOString(),
    duration_ms: Date.now() - started,
    mode: { runtime: o.runtime || 'node', browser: !!browserData, browser_error: browserData?.error || null },
    requests: fetcher.count,
    score: overallScore(layers),
    layers,
    compat: { isitagentready: iiaCompat(results, commerce.isCommerce), lighthouse_agentic: lighthouseView(results) },
    commerce,
    roles: roleView(results),
    checks: results,
    exchanges,
  };
}

function withTimeout(p, ms, id) {
  let t;
  return Promise.race([Promise.resolve(p), new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${id} timed out after ${ms / 1000} s`)), ms); })]).finally(() => clearTimeout(t));
}
