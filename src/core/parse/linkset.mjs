// RFC 9264 Linkset (JSON form) as used by the RFC 9727 API catalog.
// { linkset: [ { anchor, "<rel>": [ { href, type?, title? } ] } ] }

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {any} json
 * @param {string} base  URL to resolve relative hrefs
 * @returns {{ok:boolean, entries:{anchor:string|null, links:Record<string,{href:string,type?:string,title?:string}[]>}[], errors:string[], warnings:string[]}}
 */
export function parseLinkset(json, base) {
  const errors = []; const warnings = []; const entries = [];
  if (!isObj(json) || !Array.isArray(json.linkset)) return { ok: false, entries, errors: ['no "linkset" array'], warnings };
  json.linkset.forEach((e, i) => {
    if (!isObj(e)) { errors.push(`linkset[${i}] is not an object`); return; }
    let anchor = null;
    if (typeof e.anchor !== 'string') errors.push(`linkset[${i}] has no "anchor" (RFC 9264 section 4.2.2)`);
    else { try { anchor = new URL(e.anchor, base).href; } catch { errors.push(`linkset[${i}].anchor "${e.anchor}" is not a URI`); } }
    const links = {};
    for (const [rel, targets] of Object.entries(e)) {
      if (rel === 'anchor') continue;
      if (!Array.isArray(targets)) { errors.push(`linkset[${i}]["${rel}"] must be an array of target objects (RFC 9264)`); continue; }
      links[rel] = [];
      targets.forEach((t, j) => {
        if (!isObj(t) || typeof t.href !== 'string') { errors.push(`linkset[${i}]["${rel}"][${j}] has no "href"`); return; }
        let href = t.href; try { href = new URL(t.href, anchor || base).href; } catch { errors.push(`linkset[${i}]["${rel}"][${j}].href is not a URI`); return; }
        links[rel].push({ href, type: t.type, title: t.title });
      });
    }
    entries.push({ anchor, links });
  });
  if (!entries.length) warnings.push('the linkset array is empty');
  return { ok: errors.length === 0 && entries.length > 0, entries, errors, warnings };
}
