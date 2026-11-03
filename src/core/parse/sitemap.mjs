// Sitemap parser (sitemaps.org protocol 0.9): urlset and sitemapindex, regex based so it runs in
// Node and Workers without an XML library. Lenient on namespaces and CDATA; reports what it finds.

const LIMIT_URLS = 50_000; // sitemaps.org: at most 50,000 URLs per sitemap file
const LIMIT_BYTES = 52_428_800; // sitemaps.org: at most 50 MB (52,428,800 bytes) uncompressed

const decode = (s) => String(s || '')
  .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
  .trim();

/** W3C Datetime as sitemaps.org allows it: YYYY, YYYY-MM, YYYY-MM-DD, or with time and zone. */
export const W3C_DATETIME = /^\d{4}(-\d{2}(-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?)?)?$/;

/**
 * @param {string} xml
 * @returns {{kind:'urlset'|'sitemapindex'|null, entries:{loc:string,lastmod:string|null}[], errors:string[]}}
 */
export function parseSitemap(xml) {
  const text = String(xml || '').replace(/^\uFEFF/, '');
  const errors = [];
  const root = /<\s*(?:[\w-]+:)?(urlset|sitemapindex)\b[^>]*>/i.exec(text);
  if (!root) return { kind: null, entries: [], errors: ['no <urlset> or <sitemapindex> root element'] };
  const kind = root[1].toLowerCase();
  if (/^\s*<!doctype html|<html[\s>]/i.test(text.slice(0, 500))) errors.push('the response looks like HTML');
  if (!new RegExp(`</\\s*(?:[\\w-]+:)?${kind}\\s*>`, 'i').test(text)) errors.push(`no closing </${kind}> (truncated or malformed)`);
  const item = kind === 'urlset' ? 'url' : 'sitemap';
  const entries = [];
  const re = new RegExp(`<\\s*(?:[\\w-]+:)?${item}\\b[^>]*>([\\s\\S]*?)<\\/\\s*(?:[\\w-]+:)?${item}\\s*>`, 'gi');
  let m;
  while ((m = re.exec(text))) {
    const loc = /<\s*(?:[\w-]+:)?loc\s*>([\s\S]*?)<\/\s*(?:[\w-]+:)?loc\s*>/i.exec(m[1]);
    const lastmod = /<\s*(?:[\w-]+:)?lastmod\s*>([\s\S]*?)<\/\s*(?:[\w-]+:)?lastmod\s*>/i.exec(m[1]);
    if (!loc) { errors.push(`a <${item}> entry has no <loc>`); continue; }
    entries.push({ loc: decode(loc[1]), lastmod: lastmod ? decode(lastmod[1]) : null });
  }
  return { kind, entries, errors };
}

export const SITEMAP_LIMITS = { urls: LIMIT_URLS, bytes: LIMIT_BYTES };
