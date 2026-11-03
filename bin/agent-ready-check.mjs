#!/usr/bin/env node
// agent-ready-check CLI: scan a URL from the terminal or in CI.
//   agent-ready-check <url> [--json|--md|--prompts] [--browser] [--allow-private] [--fail-under N]
//                           [--level-at-least N] [--only id,id] [--timeout S] [--help] [--version]
// Exit codes: 0 ok, 1 a gate failed (--fail-under / --level-at-least), 2 usage or scan error.
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

export const USAGE = `Usage: agent-ready-check <url> [options]

Scan a website for agent-readiness (checks from the book "The Agent-Ready Web").

Output (default: a table):
  --json                 the full report as JSON
  --md                   the report as Markdown
  --prompts              only the failing and warning checks, as fix prompts for a coding agent

Scan:
  --browser              also run the browser checks (needs playwright-core and Chromium; CHROMIUM_PATH overrides)
  --allow-private        allow localhost and private addresses (local dev servers)
  --only <ids>           run only these check ids, comma-separated

Gates (exit code 1 when not met):
  --fail-under <N>       overall score below N (0-100)
  --level-at-least <N>   isitagentready-compatible level below N (0-5)

  -h, --help             this help
  -v, --version          print the version`;

/** Parse argv (without node and script). Throws Error with a usage message on bad input. */
export function parseArgs(argv) {
  const o = { url: null, format: 'table', browser: false, allowPrivate: false, failUnder: null, levelAtLeast: null, only: null, help: false, version: false };
  const num = (name, v, min, max) => {
    const n = Number(v);
    if (v === undefined || v === '' || !Number.isFinite(n) || n < min || n > max) throw new Error(`${name} needs a number from ${min} to ${max}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let val;
    if (/^--[a-z-]+=/.test(a)) { val = a.slice(a.indexOf('=') + 1); a = a.slice(0, a.indexOf('=')); }
    const next = () => (val !== undefined ? val : argv[++i]);
    switch (a) {
      case '--json': o.format = 'json'; break;
      case '--md': case '--markdown': o.format = 'md'; break;
      case '--prompts': o.format = 'prompts'; break;
      case '--browser': o.browser = true; break;
      case '--allow-private': o.allowPrivate = true; break;
      case '--fail-under': o.failUnder = num('--fail-under', next(), 0, 100); break;
      case '--level-at-least': o.levelAtLeast = num('--level-at-least', next(), 0, 5); break;
      case '--only': {
        const v = next();
        if (!v || v.startsWith('--')) throw new Error('--only needs a comma-separated list of check ids');
        o.only = v.split(',').map((s) => s.trim()).filter(Boolean);
        break;
      }
      case '-h': case '--help': o.help = true; break;
      case '-v': case '--version': o.version = true; break;
      default:
        if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
        if (o.url) throw new Error(`only one URL, got "${o.url}" and "${a}"`);
        o.url = a;
    }
  }
  if (!o.url && !o.help && !o.version) throw new Error('a URL is required');
  return o;
}

/** Evaluate the CI gates. Returns a list of failure messages (empty = pass). */
export function gates(report, o) {
  const out = [];
  if (o.failUnder != null && report.score < o.failUnder) out.push(`score ${report.score} is below --fail-under ${o.failUnder}`);
  const level = report.compat?.isitagentready?.level ?? 0;
  if (o.levelAtLeast != null && level < o.levelAtLeast) out.push(`isitagentready-compatible level ${level} is below --level-at-least ${o.levelAtLeast}`);
  return out;
}

const SYMBOL = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', info: 'INFO', neutral: 'n/a ', skipped: 'SKIP', error: 'ERR ' };

/** Human-readable table (plain text, no colours, fits 100 columns). */
export function table(report) {
  const iia = report.compat?.isitagentready;
  const lh = report.compat?.lighthouse_agentic;
  const lines = [
    `Agent-Ready Check: ${report.final_url || report.url}`,
    `Score ${report.score}/100${iia ? ` | isitagentready-compatible level ${iia.level} (${iia.level_name})` : ''}${lh?.score != null ? ` | Lighthouse Agentic view ${Math.round(lh.score * 100)}` : ''}`,
    `${report.requests} requests, ${(report.duration_ms / 1000).toFixed(1)} s, browser ${report.mode?.browser ? 'on' : 'off'}`,
    '',
    'Layer                      Score',
    ...(report.layers || []).map((l) => `${l.name.padEnd(26)} ${l.applicable ? String(l.score).padStart(5) : '  n/a'}`),
    '',
  ];
  const order = { fail: 0, warn: 1, error: 2, pass: 3, info: 4, skipped: 5, neutral: 6 };
  for (const c of [...(report.checks || [])].sort((a, b) => order[a.status] - order[b.status] || (b.weight || 0) - (a.weight || 0))) {
    const msg = String(c.message || '').replace(/\s+/g, ' ');
    lines.push(`${SYMBOL[c.status] || c.status} ${c.id.padEnd(38)} ${msg.length > 100 ? `${msg.slice(0, 97)}...` : msg}`);
  }
  if (iia?.next_level) lines.push('', `Next isitagentready level (${iia.next_level.target}): ${iia.next_level.requirements.join('; ')}`);
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2), io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  let o;
  try { o = parseArgs(argv); } catch (e) { io.err(`agent-ready-check: ${e.message}\n\n${USAGE}\n`); return 2; }
  if (o.help) { io.out(`${USAGE}\n`); return 0; }
  const { VERSION } = await import('../src/core/fetcher.mjs');
  if (o.version) { io.out(`${VERSION}\n`); return 0; }
  let report;
  try {
    const { scanNode } = await import('../src/node/index.mjs');
    report = await scanNode(o.url, { browser: o.browser, allowPrivate: o.allowPrivate, only: o.only || undefined, runtime: 'cli', browserOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {} });
  } catch (e) {
    io.err(`agent-ready-check: ${e.message}\n`);
    return 2;
  }
  if (o.format === 'json') io.out(`${JSON.stringify(report, null, 2)}\n`);
  else if (o.format === 'md' || o.format === 'prompts') {
    const R = await import('../server/render.mjs');
    io.out(`${o.format === 'md' ? R.renderReportMarkdown(report, {}) : R.renderFixPrompts(report)}\n`);
  } else io.out(`${table(report)}\n`);
  const failed = gates(report, o);
  for (const f of failed) io.err(`gate failed: ${f}\n`);
  return failed.length ? 1 : 0;
}

// npx and npm link start the CLI through a symlink, so compare real paths.
const realOrSame = (p) => { try { return realpathSync(p); } catch { return p; } };
if (process.argv[1] && realOrSame(resolvePath(process.argv[1])) === realOrSame(fileURLToPath(import.meta.url))) {
  // Exit once stdout has drained, so open keep-alive sockets or a browser cannot hold the process.
  main().then((code) => { process.stdout.write('', () => process.exit(code)); });
}
