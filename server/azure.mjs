// Azure entry (Static Web Apps + managed Azure Functions): one fetch-style handler for the whole site.
//
// Static Web Apps serves /assets/* from its CDN and routes every other request to the managed function
// (staticwebapp.config.json: route "/*" and navigationFallback rewrite to /api/__site). A rewritten request
// arrives at /api/__site with the address the visitor asked for in the x-ms-original-url header; direct /api/*
// calls arrive as they are. Either way the Hono app (server/app.mjs) sees the original URL, so pages, Markdown
// negotiation, the agent files, /mcp and /api/* behave exactly as on Node and in the Worker.
//
// Settings (Static Web Apps application settings, set by infra/main.bicep):
//   BASE_URL                    public origin, e.g. https://agent.isainative.dev
//   REPORTS_CONNECTION_STRING   storage account connection string (reports in Blob Storage); unset = memory only
//   REPORTS_CONTAINER           blob container (default "reports")
//   BROWSER_RUNNER_URL          optional browser runner endpoint(s), comma-separated (.../collect)
//   RUNNER_TOKEN                bearer token for the runner
//   RATE_LIMIT, RATE_WINDOW     scans per client per window (default 10 per 600 s; per function instance)
//   SCAN_TIMEOUT_MS             network budget per scan (default 30000; Static Web Apps ends API calls at 45 s)
import { createApp } from './app.mjs';
import { memoryRateLimiter } from './ratelimit.mjs';
import { scan as coreScan } from '../src/core/scan.mjs';
import { transport, resolve } from '../src/node/transport.mjs';
import { memoryStore } from '../src/store/memory.mjs';
import { azureBlobStore } from '../src/store/azure-blob.mjs';

/** Rebuild the visitor's URL: x-ms-original-url when Static Web Apps rewrote the request, else the request URL. */
export function originalUrl(requestUrl, headers) {
  const get = (k) => (typeof headers.get === 'function' ? headers.get(k) : headers[k]);
  const orig = get('x-ms-original-url');
  if (orig) {
    try { return new URL(orig).href; } catch { /* fall through */ }
  }
  return new URL(requestUrl).href;
}

async function remoteBrowser(url, env, timeoutMs) {
  const endpoints = String(env.BROWSER_RUNNER_URL || '').split(',').map((u) => u.trim()).filter(Boolean);
  let last = 'no browser runner configured';
  for (const endpoint of endpoints) {
    try {
      const r = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.RUNNER_TOKEN || ''}` }, body: JSON.stringify({ url }), signal: AbortSignal.timeout(timeoutMs) });
      if (r.ok) return await r.json();
      last = r.status === 503 ? 'the browser runner is busy, try again in a minute' : `browser runner answered HTTP ${r.status}`;
      if (![502, 503, 504].includes(r.status)) break;
    } catch (e) { last = `browser runner unreachable: ${e.message}`; }
  }
  return { ok: false, error: last };
}

/**
 * @param {Record<string,string|undefined>} env  process.env in Azure
 * @param {{store?:object}} [o]  tests inject a store
 * @returns {(request: Request) => Promise<Response>}
 */
export function createAzureHandler(env = {}, o = {}) {
  const store = o.store || (env.REPORTS_CONNECTION_STRING
    ? azureBlobStore({ connectionString: env.REPORTS_CONNECTION_STRING, container: env.REPORTS_CONTAINER || 'reports' })
    : memoryStore());
  const rateLimit = memoryRateLimiter({ limit: Number(env.RATE_LIMIT || 10), windowSeconds: Number(env.RATE_WINDOW || 600) });
  const scanTimeoutMs = Number(env.SCAN_TIMEOUT_MS || 30_000);
  const runnerOn = !!(env.BROWSER_RUNNER_URL && env.RUNNER_TOKEN);
  const app = createApp({
    scan: (url, { browser } = {}) => coreScan(url, {
      transport, resolve, runtime: 'azure',
      browserData: browser && runnerOn ? remoteBrowser(url, env, scanTimeoutMs + 5_000) : null,
      fetcherOptions: { scanTimeoutMs },
    }),
    store, rateLimit, browserAvailable: runnerOn, resolve, baseUrl: env.BASE_URL || undefined, runtime: 'azure',
  });
  return async (request) => {
    const url = originalUrl(request.url, request.headers);
    const init = { method: request.method, headers: request.headers, redirect: 'manual' };
    if (!['GET', 'HEAD'].includes(request.method)) { init.body = await request.arrayBuffer(); }
    return app.fetch(new Request(url, init));
  };
}
