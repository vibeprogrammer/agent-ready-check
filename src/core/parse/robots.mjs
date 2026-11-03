// robots.txt parser and matcher per RFC 9309, plus the extension lines agents care about:
// Content-Signal (contentsignals.org), Content-Usage (IETF aipref), Sitemap, Agentmap (ARD), License (RSL).

const KNOWN = new Set(['user-agent', 'allow', 'disallow', 'sitemap', 'crawl-delay', 'host', 'content-signal', 'content-usage', 'agentmap', 'license', 'clean-param', 'request-rate', 'visit-time', 'noindex']);

/**
 * @param {string} text
 * @returns {{groups:{agents:string[],rules:{type:'allow'|'disallow',path:string,line:number}[],extensions:{key:string,value:string,line:number}[],line:number}[], sitemaps:string[], agentmaps:string[], licenses:string[], unknown:{line:number,text:string}[], errors:{line:number,message:string}[], contentSignals:{agents:string[],value:string,line:number,pairs:Record<string,string>}[], contentUsage:{agents:string[],value:string,line:number}[]}}
 */
export function parseRobots(text) {
  const out = { groups: [], sitemaps: [], agentmaps: [], licenses: [], unknown: [], errors: [], contentSignals: [], contentUsage: [] };
  let cur = null; let lastWasAgent = false;
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  lines.forEach((raw, i) => {
    const line = i + 1;
    const s = raw.replace(/#.*$/, '').trim();
    if (!s) return;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(s);
    if (!m) { out.errors.push({ line, message: `not a "field: value" line: ${s.slice(0, 80)}` }); return; }
    const key = m[1].toLowerCase(); const value = m[2].trim();
    if (!KNOWN.has(key)) out.unknown.push({ line, text: s.slice(0, 120) });
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [], extensions: [], line }; out.groups.push(cur); }
      cur.agents.push(value);
      lastWasAgent = true;
      return;
    }
    lastWasAgent = false;
    if (key === 'sitemap') { out.sitemaps.push(value); return; }
    if (key === 'agentmap') { out.agentmaps.push(value); return; }
    if (key === 'license') { out.licenses.push(value); return; }
    if (key === 'allow' || key === 'disallow') {
      if (!cur) { out.errors.push({ line, message: `${m[1]} before any User-agent line` }); return; }
      cur.rules.push({ type: key, path: value, line });
      return;
    }
    if (key === 'content-signal') {
      const pairs = {};
      for (const part of value.split(',')) { const [k, v] = part.split('=').map((x) => (x || '').trim().toLowerCase()); if (k) pairs[k] = v; }
      out.contentSignals.push({ agents: cur ? [...cur.agents] : [], value, line, pairs });
    }
    if (key === 'content-usage') out.contentUsage.push({ agents: cur ? [...cur.agents] : [], value, line });
    if (cur) cur.extensions.push({ key, value, line });
  });
  return out;
}

/** The groups that apply to a user-agent product token (RFC 9309 2.2.1): exact token match (case-insensitive), merged; else '*'. */
export function groupsFor(parsed, token) {
  const t = token.toLowerCase();
  const exact = parsed.groups.filter((g) => g.agents.some((a) => a.toLowerCase() === t));
  if (exact.length) return { groups: exact, matched: token };
  const star = parsed.groups.filter((g) => g.agents.some((a) => a.trim() === '*'));
  return { groups: star, matched: star.length ? '*' : null };
}

function patternToRegex(p) {
  let anchored = false;
  if (p.endsWith('$')) { anchored = true; p = p.slice(0, -1); }
  const esc = p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + esc + (anchored ? '$' : ''));
}

/** Is `path` allowed for `token`? Longest matching rule wins; allow wins a tie (RFC 9309 2.2.2). */
export function isAllowed(parsed, token, path = '/') {
  const { groups, matched } = groupsFor(parsed, token);
  if (!groups.length) return { allowed: true, group: null, rule: null };
  let best = null;
  for (const g of groups) for (const r of g.rules) {
    if (r.type === 'disallow' && r.path === '') continue;
    let p = r.path;
    try { p = decodeURI(p); } catch { /* keep */ }
    if (!patternToRegex(p).test(path)) continue;
    const len = p.replace(/\$$/, '').length;
    if (!best || len > best.len || (len === best.len && r.type === 'allow')) best = { ...r, len };
  }
  return { allowed: !best || best.type === 'allow', group: matched, rule: best ? { type: best.type, path: best.path, line: best.line } : null };
}
