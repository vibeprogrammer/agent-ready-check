// Cloudflare Worker entry (bundled by scripts/build-worker.mjs into dist/worker/_worker.mjs).
// Bindings: DB (D1, reports + rate limits), ASSETS (static files from public/). Vars (optional): BASE_URL,
// RATE_LIMIT, RATE_WINDOW. The Worker cannot run a browser; with a browser runner configured
// (server/runner.mjs) browser checks run there, otherwise they report "skipped".
import { createApp } from './app.mjs';
import { scan as coreScan } from '../src/core/scan.mjs';
import { transport, resolve } from '../src/worker/transport.mjs';
import { d1Store, d1RateLimiter } from '../src/store/d1.mjs';
import { memoryStore } from '../src/store/memory.mjs';
import { memoryRateLimiter } from './ratelimit.mjs';
// public/index.html inlined at build time: Workers static assets would otherwise answer "/" before the Worker
// runs, without the Link headers and Markdown negotiation.
import HOME_HTML from 'virtual:home-html';

// Injected at bundle time by scripts/build-worker.mjs (esbuild define) from the deployer's environment.
// Never committed. Empty strings mean: no browser runner, browser checks are skipped.
/* global __BROWSER_RUNNER_URL__, __RUNNER_TOKEN__ */
const RUNNER_URL = typeof __BROWSER_RUNNER_URL__ === 'string' ? __BROWSER_RUNNER_URL__ : '';
const RUNNER_TOKEN = typeof __RUNNER_TOKEN__ === 'string' ? __RUNNER_TOKEN__ : '';

/** Ask the browser runner for browserData; never throws (failures become { ok:false, error }). */
async function remoteBrowser(url, env) {
  const endpoint = env.BROWSER_RUNNER_URL || RUNNER_URL; const token = env.RUNNER_TOKEN || RUNNER_TOKEN;
  try {
    const r = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ url }), signal: AbortSignal.timeout(45_000) });
    if (!r.ok) return { ok: false, error: r.status === 503 ? 'the browser runner is busy, try again in a minute' : `browser runner answered HTTP ${r.status}` };
    return await r.json();
  } catch (e) { return { ok: false, error: `browser runner unreachable: ${e.message}` }; }
}

let cached = null;

function build(env) {
  const store = env.DB ? d1Store(env.DB) : memoryStore();
  const opts = { limit: Number(env.RATE_LIMIT || 10), windowSeconds: Number(env.RATE_WINDOW || 600) };
  const rateLimit = env.DB ? d1RateLimiter(env.DB, opts) : memoryRateLimiter(opts);
  const assets = env.ASSETS ? async (path, request) => {
    const r = await env.ASSETS.fetch(new Request(new URL(path, request.url), { headers: { accept: request.headers.get('accept') || '*/*' } }));
    return r.ok ? r : null;
  } : null;
  const runnerOn = !!((env.BROWSER_RUNNER_URL || RUNNER_URL) && (env.RUNNER_TOKEN || RUNNER_TOKEN));
  return createApp({
    scan: (url, { browser } = {}) => coreScan(url, { transport, resolve, runtime: 'worker', browserData: browser && runnerOn ? remoteBrowser(url, env) : null }),
    store, rateLimit, browserAvailable: runnerOn, resolve, assets, baseUrl: env.BASE_URL || undefined, runtime: 'worker', homeHtml: HOME_HTML || undefined,
  });
}

export default {
  fetch(request, env, ctx) {
    if (!cached || cached.env !== env) cached = { env, app: build(env) };
    return cached.app.fetch(request, env, ctx);
  },
};
