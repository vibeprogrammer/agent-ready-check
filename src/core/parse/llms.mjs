// llms.txt parser (llmstxt.org proposal; v2 modified 10 Aug 2026). Lenient: it reports the structure it finds.
//   # Title            (exactly one H1, first)
//   > summary          (optional blockquote)
//   free text          (optional)
//   ## Section         (H2 sections of "- [name](url): notes" link lists; "## Optional" is skippable)

/**
 * @param {string} text
 * @param {string} [base]  URL the file came from, to resolve relative links
 * @returns {{h1:string|null, h1Count:number, summary:string|null, sections:{title:string,links:{name:string,url:string,notes:string}[]}[], links:{name:string,url:string,section:string|null}[], chars:number, looksHtml:boolean}}
 */
export function parseLlms(text, base) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const out = { h1: null, h1Count: 0, summary: null, sections: [], links: [], chars: src.trim().length, looksHtml: /^\s*<(!doctype|html|head|body)\b/i.test(src) };
  let section = null; let inFence = false;
  for (const raw of src.split(/\r\n|\r|\n/)) {
    const line = raw.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h && h[1].length === 1) { out.h1Count++; if (!out.h1) out.h1 = h[2].trim(); continue; }
    if (h && h[1].length === 2) { section = { title: h[2].trim(), links: [] }; out.sections.push(section); continue; }
    const bq = /^\s*>\s?(.*)$/.exec(line);
    if (bq && !section && out.h1 && out.summary === null) { out.summary = bq[1].trim(); continue; }
    if (bq && !section && out.summary !== null && out.sections.length === 0) { out.summary += ' ' + bq[1].trim(); continue; }
    for (const m of line.matchAll(/\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)(?::\s*(.*))?/g)) {
      let url = m[2];
      try { url = new URL(m[2], base).href; } catch { /* keep as written */ }
      const link = { name: m[1].trim(), url, notes: (m[3] || '').trim() };
      out.links.push({ ...link, section: section ? section.title : null });
      if (section && /^\s*[-*+]\s/.test(line)) section.links.push(link);
    }
  }
  return out;
}
