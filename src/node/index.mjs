// Node entry: scan with the pinned http/https transport, optionally with a real browser.
import { scan as coreScan, normalizeUrl } from '../core/scan.mjs';
import { transport, resolve } from './transport.mjs';

/**
 * @param {string} url
 * @param {{browser?:boolean, allowPrivate?:boolean, only?:string[], browserOptions?:object, fetcherOptions?:object}} [o]
 */
export async function scanNode(url, o = {}) {
  let browserData = null;
  if (o.browser) {
    const { collectBrowser } = await import('../browser/collect.mjs');
    browserData = collectBrowser(normalizeUrl(url).href, { allowPrivate: o.allowPrivate, ...(o.browserOptions || {}) }).catch((e) => ({ ok: false, error: e.message }));
  }
  return coreScan(url, { transport, resolve, allowPrivate: o.allowPrivate, browserData, only: o.only, runtime: o.runtime || 'node', fetcherOptions: o.fetcherOptions });
}
export { normalizeUrl };
