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

/**
 * Ask the browser runner for browserData; never throws (failures become { ok:false, error }).
 * BROWSER_RUNNER_URL may list several endpoints separated by commas (for example the runner's direct origin
 * and its public name); they are tried in order while the answer is a network error or an edge 52x.
 */
async function remoteBrowser(url, env) {
  const endpoints = String(env.BROWSER_RUNNER_URL || RUNNER_URL).split(',').map((u) => u.trim()).filter(Boolean);
  const token = env.RUNNER_TOKEN || RUNNER_TOKEN;
  let last = 'no browser runner configured';
  for (const endpoint of endpoints) {
    try {
      const r = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ url }), signal: AbortSignal.timeout(80_000) });
      if (r.ok) return await r.json();
      last = r.status === 503 ? 'the browser runner is busy, try again in a minute' : `browser runner answered HTTP ${r.status}`;
      if (!(r.status >= 520 && r.status <= 530) && r.status !== 502 && r.status !== 504) break;
    } catch (e) { last = `browser runner unreachable: ${e.message}`; }
  }
  return { ok: false, error: last };
}

let cached = null;
let selfHost = null;

function build(env) {
  const store = env.DB ? d1Store(env.DB) : memoryStore();
  const opts = { limit: Number(env.RATE_LIMIT || 10), windowSeconds: Number(env.RATE_WINDOW || 600) };
  const rateLimit = env.DB ? d1RateLimiter(env.DB, opts) : memoryRateLimiter(opts);
  const assets = env.ASSETS ? async (path, request) => {
    const r = await env.ASSETS.fetch(new Request(new URL(path, request.url), { headers: { accept: request.headers.get('accept') || '*/*' } }));
    return r.ok ? r : null;
  } : null;
  // Workers on this platform cannot fetch their own hostname over the network (the edge answers 522), so a
  // scan of this service is served in-process by the app itself; every other host goes over the network.
  let selfApp = null;
  const selfTransport = async (o) => {
    if (!selfApp || o.url.host !== selfHost) return transport(o);
    const t0 = Date.now();
    const res = await frontDoor(new Request(o.url.href, { method: o.method, headers: o.headers, body: o.body, redirect: 'manual' }), env, { waitUntil() {}, passThroughOnException() {} });
    const hdrs = {}; res.headers.forEach((v, k) => { hdrs[k] = v; });
    // In process the body is never compressed: Content-Encoding here is the instruction the runtime carries out on the wire.
    let body = new Uint8Array(o.method === 'HEAD' || !res.body ? 0 : await res.arrayBuffer());
    const truncated = body.byteLength > o.maxBytes; if (truncated) body = body.subarray(0, o.maxBytes);
    return { status: res.status, headers: hdrs, body, truncated, ttfb: Date.now() - t0 };
  };
  const runnerOn = !!((env.BROWSER_RUNNER_URL || RUNNER_URL) && (env.RUNNER_TOKEN || RUNNER_TOKEN));
  selfApp = createApp({
    scan: (url, { browser } = {}) => coreScan(url, { transport: selfTransport, resolve, runtime: 'worker', browserData: browser && runnerOn ? remoteBrowser(url, env) : null }),
    store, rateLimit, browserAvailable: runnerOn, resolve, assets, baseUrl: env.BASE_URL || undefined, runtime: 'worker', homeHtml: HOME_HTML || undefined,
  });
  return selfApp;
}

async function frontDoor(request, env, ctx) {
  const u = new URL(request.url);
  if (!selfHost) selfHost = u.host;
  // HTTPS only: plain http:// is redirected (the edge in front of this Worker does not do it).
  if (u.protocol === 'http:' && !/^(localhost|127\.0\.0\.1)(:|$)/.test(u.host)) {
    u.protocol = 'https:';
    return new Response(null, { status: 301, headers: { location: u.href, 'cache-control': 'public, max-age=3600' } });
  }
  if (!cached || cached.env !== env) cached = { env, app: build(env) };
  return withCompression(request, await cached.app.fetch(request, env, ctx));
}

// Text responses of 1 KB or more: setting Content-Encoding: gzip makes the Workers runtime compress the body on
// the wire (its default encodeBody: "automatic"); the app itself hands over plain bytes.
const COMPRESSIBLE = /^(text\/(?!event-stream)|application\/(json|[\w.+-]+\+json|xml|[\w.+-]+\+xml|javascript|yaml|x-yaml|linkset\+json)|image\/svg\+xml)/i;
function withCompression(request, res) {
  if (request.method === 'HEAD' || !res.body || res.headers.has('content-encoding')) return res;
  if (!/\bgzip\b/i.test(request.headers.get('accept-encoding') || '')) return res;
  if (!COMPRESSIBLE.test(res.headers.get('content-type') || '')) return res;
  const len = Number(res.headers.get('content-length') || NaN);
  if (Number.isFinite(len) && len < 1024) return res;
  const out = new Response(res.body, res);
  out.headers.set('content-encoding', 'gzip');
  out.headers.delete('content-length');
  const vary = out.headers.get('vary');
  if (!/accept-encoding/i.test(vary || '')) out.headers.set('vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding');
  return out;
}

export default { fetch: frontDoor };
