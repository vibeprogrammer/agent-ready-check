// Node entry: `node server/node.mjs` (also the Docker entry).
// Env: PORT (8080), HOST (0.0.0.0), BASE_URL (public origin, else from the request), REPORTS_DIR (fs store; memory
// when unset), RATE_LIMIT (10 scans) and RATE_WINDOW (600 s) per client, BROWSER=1 (browser checks with
// playwright-core + Chromium; CHROMIUM_PATH overrides the executable), ALLOW_PRIVATE=1 (local testing only),
// TRUST_PROXY=1 (use X-Forwarded-For for the client key; set behind a reverse proxy).
import http from 'node:http';
import zlib from 'node:zlib';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, extname, normalize, resolve as resolvePath } from 'node:path';
import { Readable } from 'node:stream';
import { createApp } from './app.mjs';
import { memoryRateLimiter } from './ratelimit.mjs';
import { scanNode } from '../src/node/index.mjs';
import { resolve as dnsResolve } from '../src/node/transport.mjs';
import { memoryStore } from '../src/store/memory.mjs';
import { fsStore } from '../src/store/fs.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };
const COMPRESSIBLE = /^(text\/|application\/(json|xml|javascript|openapi\+json|linkset\+json|problem\+json|mcp-server-card\+json|manifest\+json)|image\/svg)/;

/** Static files from public/ (path traversal safe). */
export function publicAssets(dir = PUBLIC) {
  const root = resolvePath(dir);
  return async (path) => {
    const p = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, '');
    const file = resolvePath(root, p);
    if (!file.startsWith(root)) return null;
    try {
      const s = await stat(file);
      if (!s.isFile()) return null;
      return new Response(await readFile(file), { status: 200, headers: { 'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'public, max-age=3600' } });
    } catch { return null; }
  };
}

/** Is a browser usable here? playwright-core importable and a Chromium executable present. */
export async function detectBrowser(env = process.env) {
  if (env.BROWSER !== '1' && env.BROWSER !== 'true') return false;
  try {
    const { chromium } = await import('playwright-core');
    const exe = env.CHROMIUM_PATH || chromium.executablePath();
    return !!exe && existsSync(exe);
  } catch { return false; }
}

/** Serve a Hono app on Node's http server (no adapter dependency). */
export function serve(app, { port = 8080, host = '0.0.0.0', trustProxy = false } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const proto = trustProxy && req.headers['x-forwarded-proto'] ? String(req.headers['x-forwarded-proto']).split(',')[0] : 'http';
      const url = `${proto}://${req.headers.host || `localhost:${port}`}${req.url}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        if (!trustProxy && /^x-forwarded-/.test(k)) continue;
        headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      }
      const hasBody = !['GET', 'HEAD'].includes(req.method);
      const request = new Request(url, { method: req.method, headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: hasBody ? 'half' : undefined });
      const response = await app.fetch(request, { remoteAddress: req.socket.remoteAddress, incoming: req });
      const out = {};
      response.headers.forEach((v, k) => { if (k !== 'set-cookie') out[k] = v; });
      const ae = String(req.headers['accept-encoding'] || '');
      const type = response.headers.get('content-type') || '';
      const compress = response.body && req.method !== 'HEAD' && !out['content-encoding'] && COMPRESSIBLE.test(type) && /\b(gzip|br)\b/.test(ae);
      if (compress) {
        const br = /\bbr\b/.test(ae);
        out['content-encoding'] = br ? 'br' : 'gzip';
        delete out['content-length'];
        out.vary = out.vary ? (/accept-encoding/i.test(out.vary) ? out.vary : `${out.vary}, Accept-Encoding`) : 'Accept-Encoding';
        res.writeHead(response.status, out);
        Readable.fromWeb(response.body).pipe(br ? zlib.createBrotliCompress() : zlib.createGzip()).pipe(res);
        return;
      }
      res.writeHead(response.status, out);
      if (!response.body || req.method === 'HEAD') { res.end(); return; }
      Readable.fromWeb(response.body).pipe(res);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/problem+json' });
      res.end(JSON.stringify({ type: 'about:blank', title: 'Internal Server Error', status: 500 }));
    }
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;
  return new Promise((ok) => server.listen(port, host, () => ok(server)));
}

/** Build the app for Node from env-like options. */
export async function createNodeApp(env = process.env) {
  const browserAvailable = await detectBrowser(env);
  const allowPrivate = env.ALLOW_PRIVATE === '1';
  const store = env.REPORTS_DIR ? fsStore({ dir: env.REPORTS_DIR }) : memoryStore();
  const rateLimit = memoryRateLimiter({ limit: Number(env.RATE_LIMIT || 10), windowSeconds: Number(env.RATE_WINDOW || 600) });
  const browserOptions = env.CHROMIUM_PATH ? { executablePath: env.CHROMIUM_PATH } : {};
  const app = createApp({
    scan: (url, { browser }) => scanNode(url, { browser, allowPrivate, browserOptions, runtime: 'node' }),
    store, rateLimit, browserAvailable, allowPrivate, resolve: dnsResolve,
    baseUrl: env.BASE_URL || undefined, assets: publicAssets(env.PUBLIC_DIR || PUBLIC), runtime: 'node',
  });
  return { app, store, browserAvailable };
}

export async function start(env = process.env) {
  const { app, browserAvailable, store } = await createNodeApp(env);
  const port = Number(env.PORT || 8080);
  const server = await serve(app, { port, host: env.HOST || '0.0.0.0', trustProxy: env.TRUST_PROXY === '1' });
  const addr = server.address();
  console.log(`agent-ready-check listening on http://${env.HOST || '0.0.0.0'}:${addr.port} (browser ${browserAvailable ? 'on' : 'off'}, store ${store.kind})`);
  const stop = () => server.close(() => process.exit(0));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return server;
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) start();
