// RFC 8288 Link header parser: '<url>; rel="a b"; type="text/markdown", <url2>; rel=x'
export function parseLinkHeader(value, base) {
  const out = [];
  if (!value) return out;
  const re = /<([^>]*)>\s*((?:;\s*[^;,]+(?:=(?:"[^"]*"|[^;,]*))?\s*)*)/g;
  let m;
  while ((m = re.exec(value))) {
    const params = {};
    const pre = /;\s*([^=;,\s]+)\s*(?:=\s*("([^"]*)"|[^;,]*))?/g;
    let p;
    while ((p = pre.exec(m[2]))) params[p[1].toLowerCase()] = p[3] !== undefined ? p[3] : (p[2] || '').trim();
    let href = m[1];
    try { href = new URL(m[1], base).href; } catch { /* keep raw */ }
    for (const rel of String(params.rel || '').toLowerCase().split(/\s+/).filter(Boolean)) out.push({ rel, href, type: params.type || null, title: params.title || null, source: 'header' });
  }
  return out;
}
