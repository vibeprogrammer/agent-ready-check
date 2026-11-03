// Browser runner: a small HTTP service that runs src/browser/collect.mjs for the Worker deployment,
// which cannot run a browser itself. One job at a time, a short queue, a bearer token.
//   RUNNER_TOKEN=... PORT=8080 node server/runner.mjs
//   POST /collect {"url":"https://example.com"}  (Authorization: Bearer <RUNNER_TOKEN>) -> browserData JSON
//   GET  /health
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import { collectBrowser } from '../src/browser/collect.mjs';

const TOKEN = process.env.RUNNER_TOKEN || '';
const PORT = Number(process.env.PORT || 8080);
const JOB_TIMEOUT_MS = Number(process.env.RUNNER_JOB_TIMEOUT_MS || 40_000);
const DEFAULT_ARGS = process.env.CHROMIUM_ARGS || '';
const MAX_QUEUE = Number(process.env.RUNNER_MAX_QUEUE || 2);

let running = 0; const queue = [];
let served = 0; let failed = 0; const started = Date.now();

const authorized = (h) => {
  if (!TOKEN) return false;
  const got = Buffer.from(String(h || '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
};

async function runJob(url) {
  running++;
  try {
    let t;
    const timeout = new Promise((r) => { t = setTimeout(() => r({ ok: false, error: `browser run timed out after ${JOB_TIMEOUT_MS / 1000} s` }), JOB_TIMEOUT_MS); });
    const out = await Promise.race([collectBrowser(url, { allowPrivate: false, timeoutMs: JOB_TIMEOUT_MS - 5000 }), timeout]).finally(() => clearTimeout(t));
    if (out?.ok) served++; else failed++;
    return out;
  } catch (e) { failed++; return { ok: false, error: e.message }; } finally {
    running--;
    const next = queue.shift(); if (next) next();
  }
}

function send(res, status, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://runner');
  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
    return send(res, 200, { status: 'ok', service: 'agent-ready-check browser runner', running, queued: queue.length, served, failed, uptime_s: Math.round((Date.now() - started) / 1000), mem_free_mb: Math.round(os.freemem() / 1048576), mem_total_mb: Math.round(os.totalmem() / 1048576), auth: TOKEN ? 'bearer' : 'disabled (RUNNER_TOKEN unset)' });
  }
  if (req.method === 'GET' && url.pathname === '/diag' && authorized(req.headers.authorization)) {
    const { execSync } = await import('node:child_process');
    const sh = (cmd, ms = 10_000) => { try { return execSync(cmd, { timeout: ms }).toString(); } catch (e) { return `ERR ${e.message}`.slice(0, 500); } };
    return send(res, 200, { shm: sh('df -h /dev/shm'), mem: sh('free -m; /sbin/swapon --show'), args: process.env.CHROMIUM_ARGS || '', node: process.version, overcommit: sh('cat /proc/sys/vm/overcommit_memory; ulimit -v'), dmesg: sh('sudo dmesg 2>/dev/null | tail -15'), chrome: sh('ls ~/.cache/ms-playwright'), dump: url.searchParams.get('dump') ? sh('timeout 20 $(ls -d ~/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell | tail -1) --no-sandbox --disable-dev-shm-usage --enable-logging=stderr --v=0 --dump-dom https://example.com 2>&1 | tail -c 2500', 40_000) : '' });
  }
  if (req.method !== 'POST' || url.pathname !== '/collect') return send(res, 404, { error: 'not found' });
  if (!authorized(req.headers.authorization)) return send(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 10_000) return send(res, 413, { error: 'body too large' }); }
  let target; let parsed = {};
  try { parsed = JSON.parse(body); target = new URL(parsed.url); if (!['http:', 'https:'].includes(target.protocol)) throw new Error('scheme'); } catch { return send(res, 400, { error: 'body must be {"url":"https://..."}' }); }
  if (running >= 1) {
    if (queue.length >= MAX_QUEUE) return send(res, 503, { ok: false, error: 'browser runner busy' }, { 'retry-after': '20' });
    await new Promise((r) => queue.push(r));
  }
  // Operators can try other Chromium flags per request (authorized callers only), e.g. on small machines.
  process.env.CHROMIUM_ARGS = Array.isArray(parsed.chromiumArgs) ? parsed.chromiumArgs.filter((a) => /^--[a-z0-9-]+(=[\w.,=-]*)?$/i.test(a)).join(' ') : DEFAULT_ARGS;
  const out = await runJob(target.href);
  send(res, 200, out);
});
server.listen(PORT, '0.0.0.0', () => console.log(`browser runner on :${PORT} (auth ${TOKEN ? 'on' : 'OFF: /collect refuses everything'})`));
