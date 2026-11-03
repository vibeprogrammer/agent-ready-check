#!/usr/bin/env node
// Compare our isitagentready-compatible results with Cloudflare's live scanner on real sites.
//   node scripts/compare-iia.mjs https://a.com https://b.com ... [--browser] [--out dir]
// Calls POST https://isitagentready.com/api/scan once per site (the public API documented in its llms-full.txt).
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { scanNode } from '../src/node/index.mjs';

const args = process.argv.slice(2);
const browser = args.includes('--browser');
const outIdx = args.indexOf('--out');
const outDir = outIdx >= 0 ? args[outIdx + 1] : 'comparison';
const sites = args.filter((a, i) => !a.startsWith('--') && (outIdx < 0 || i !== outIdx + 1));

async function cloudflare(url) {
  const t0 = Date.now();
  try {
    const r = await fetch('https://isitagentready.com/api/scan', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'agent-ready-check comparison (+https://github.com/vibeprogrammer/agent-ready-check)' }, body: JSON.stringify({ url }), signal: AbortSignal.timeout(90_000) });
    const j = await r.json();
    return { ok: r.ok, ms: Date.now() - t0, level: j.level, checks: j.checks, raw_status: r.status };
  } catch (e) { return { ok: false, ms: Date.now() - t0, error: e.message }; }
}

const rows = [];
for (const site of sites) {
  const [cf, ours] = await Promise.all([cloudflare(site), scanNode(site, { browser }).catch((e) => ({ error: e.message }))]);
  const row = { site, cloudflare_level: cf.level ?? null, our_compat_level: ours.compat?.isitagentready?.level ?? null, our_score: ours.score ?? null, lighthouse_view: ours.compat?.lighthouse_agentic?.score ?? null, layers: ours.layers ? Object.fromEntries(ours.layers.map((l) => [l.id, l.score])) : null, agree: 0, total: 0, disagreements: [], cf_ms: cf.ms, our_ms: ours.duration_ms, our_requests: ours.requests, error: cf.error || ours.error || null };
  if (cf.checks && ours.compat) {
    for (const [cat, checks] of Object.entries(cf.checks)) for (const [id, v] of Object.entries(checks)) {
      const mine = ours.compat.isitagentready.checks?.[cat]?.[id];
      row.total++;
      if (mine && mine.status === v.status) row.agree++;
      else row.disagreements.push({ id, cloudflare: v.status, ours: mine?.status ?? 'missing', cf_message: (v.message || '').slice(0, 160), our_message: (mine?.message || '').slice(0, 160) });
    }
  }
  rows.push(row);
  console.error(`${site}: CF L${row.cloudflare_level} / ours L${row.our_compat_level}, score ${row.our_score}, ${row.agree}/${row.total} checks agree`);
}

const date = new Date().toISOString().slice(0, 10);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `iia-comparison-${date}.json`), JSON.stringify({ date, browser, rows }, null, 1));
const md = [`# Comparison with isitagentready.com (${date})`, '', `Mode: ${browser ? 'with browser checks' : 'HTTP checks only'}. Cloudflare via POST /api/scan; ours via the same machine.`, '',
  '| Site | Cloudflare level | Our compat level | Checks agreeing | Our score | Lighthouse view |', '|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.site} | ${r.cloudflare_level ?? '—'} | ${r.our_compat_level ?? '—'} | ${r.agree}/${r.total} | ${r.our_score ?? '—'} | ${r.lighthouse_view ?? '—'} |`),
  '', '## Disagreements', '', ...rows.flatMap((r) => r.disagreements.map((d) => `- ${r.site} \`${d.id}\`: Cloudflare ${d.cloudflare}, ours ${d.ours}. CF: "${d.cf_message}" Ours: "${d.our_message}"`))].join('\n');
writeFileSync(join(outDir, `iia-comparison-${date}.md`), md + '\n');
console.log(md);
