// Load api/dist/index.mjs (built by scripts/build-azure.mjs) with a stand-in for @azure/functions and request a few
// addresses the way Static Web Apps forwards them: rewritten pages arrive at /api/__site with x-ms-original-url,
// /api/* arrives as is. Used by CI; no Azure account needed.
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const shimDir = join(ROOT, 'api/node_modules/@azure/functions');
const real = await import('node:fs').then((fs) => fs.existsSync(join(shimDir, 'package.json')) && !fs.readFileSync(join(shimDir, 'package.json'), 'utf8').includes('smoke-shim'));
if (real) { console.error('api/node_modules/@azure/functions is the real package; run this before npm ci --prefix api'); process.exit(1); }
await mkdir(shimDir, { recursive: true });
await writeFile(join(shimDir, 'package.json'), '{"name":"@azure/functions","version":"0.0.0-smoke-shim","type":"module","main":"index.js"}');
await writeFile(join(shimDir, 'index.js'), 'export const registered = {}; export const app = { http(name, o) { registered[name] = o; } };');
try {
  process.env.BASE_URL = 'https://ci.example';
  const { registered } = await import(pathToFileURL(join(shimDir, 'index.js')).href);
  await import(pathToFileURL(join(ROOT, 'api/dist/index.mjs')).href);
  const fn = registered.site;
  if (!fn || fn.route !== '{*path}' || fn.authLevel !== 'anonymous') throw new Error('function "site" not registered as expected');
  const call = async (method, path, { orig = null, headers = {}, body } = {}) => {
    const h = new Headers(headers);
    if (orig) h.set('x-ms-original-url', `https://ci.example${orig}`);
    const res = await fn.handler(new Request(`https://ci.example${path}`, { method, headers: h, body }), {});
    return { ...res, text: res.body ? new TextDecoder().decode(res.body) : '' };
  };
  const expect = (name, r, status, ctRe) => {
    const ok = r.status === status && ctRe.test(r.headers['content-type'] || '');
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${r.status} ${r.headers['content-type']}`);
    if (!ok) process.exitCode = 1;
  };
  expect('/', await call('GET', '/api/__site', { orig: '/' }), 200, /text\/html/);
  expect('/ as Markdown', await call('GET', '/api/__site', { orig: '/', headers: { accept: 'text/markdown' } }), 200, /text\/markdown/);
  expect('/robots.txt', await call('GET', '/api/__site', { orig: '/robots.txt' }), 200, /text\/plain/);
  expect('/llms.txt', await call('GET', '/api/__site', { orig: '/llms.txt' }), 200, /text\/plain/);
  expect('/.well-known/api-catalog', await call('GET', '/api/__site', { orig: '/.well-known/api-catalog' }), 200, /linkset\+json/);
  expect('/api/health', await call('GET', '/api/health'), 200, /json/);
  expect('/api/checks', await call('GET', '/api/checks'), 200, /json/);
  expect('POST /mcp tools/list', await call('POST', '/api/__site', { orig: '/mcp', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) }), 200, /json/);
  expect('unknown page', await call('GET', '/api/__site', { orig: '/no-such-page' }), 404, /problem\+json|text\/html/);
} finally {
  await rm(join(ROOT, 'api/node_modules'), { recursive: true, force: true });
}
