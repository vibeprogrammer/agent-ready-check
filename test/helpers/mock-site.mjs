// A fake site for unit tests: map paths (or full URLs) to responses, then scan without the network.
//   const site = mockSite({ '/': html('<h1>Hi</h1>'), '/robots.txt': text('User-agent: *\nAllow: /') });
//   const ctx = site.ctx();                 // ScanContext for https://example.com/
//   const r = await site.run('crawl.robots-txt');   // run one check -> result object (status, message, ...)
//   const report = await site.scan({ only: ['crawl.robots-txt'] });
// Unlisted paths answer 404 text/plain. A function value gets ({url, method, headers, body}) and returns a response.
import { SafeFetcher } from '../../src/core/fetcher.mjs';
import { ScanContext } from '../../src/core/context.mjs';
import { scan } from '../../src/core/scan.mjs';
import { CHECKS } from '../../src/checks/index.mjs';

export const html = (body, headers = {}) => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...headers }, body });
export const text = (body, headers = {}) => ({ status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers }, body });
export const json = (obj, headers = {}, status = 200) => ({ status, headers: { 'content-type': 'application/json', ...headers }, body: typeof obj === 'string' ? obj : JSON.stringify(obj) });
export const status = (code, headers = {}, body = '') => ({ status: code, headers, body });

export function mockSite(routes, { origin = 'https://example.com', browserData = null } = {}) {
  const calls = [];
  const transport = async ({ method, url, headers, body }) => {
    calls.push({ method, url: url.href, headers, body });
    let r = routes[url.href] ?? routes[url.pathname + url.search] ?? routes[url.pathname];
    if (typeof r === 'function') r = await r({ url, method, headers, body });
    if (!r) r = { status: 404, headers: { 'content-type': 'text/plain' }, body: 'Not found' };
    const b = r.body instanceof Uint8Array ? r.body : new TextEncoder().encode(String(r.body ?? ''));
    return { status: r.status ?? 200, headers: r.headers || {}, body: b, truncated: false, ttfb: r.ttfb ?? 5 };
  };
  const resolve = async () => ['93.184.216.34'];
  const fetcher = () => new SafeFetcher({ transport, resolve });
  return {
    calls,
    transport, resolve,
    ctx: (path = '/') => new ScanContext({ url: new URL(path, origin), fetcher: fetcher(), browser: browserData }),
    async run(id, path = '/') {
      const meta = CHECKS.find((c) => c.id === id);
      if (!meta?.impl) throw new Error(`no implementation for ${id}`);
      return meta.impl.run(this.ctx(path));
    },
    scan: (opts = {}) => scan(new URL(opts.path || '/', origin).href, { transport, resolve, browserData, ...opts }),
  };
}
