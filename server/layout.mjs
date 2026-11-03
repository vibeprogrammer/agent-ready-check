// HTML shell for the server-rendered pages (docs, checks, privacy, errors, fallback report/home).
// One <main>, header/nav/footer landmarks, lang, canonical, meta description, Open Graph, JSON-LD identity,
// and a Markdown alternate. No inline scripts or styles (the CSP allows only 'self').
import { esc } from './markdown.mjs';
import { SITE } from '../src/agent-files/site.mjs';

export function jsonLdData(base, { name, description, path }) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', '@id': `${base}/#website`, name: SITE.name, url: `${base}/`, description: SITE.description, publisher: { '@id': `${base}/#org` } },
      { '@type': 'Organization', '@id': `${base}/#org`, name: SITE.name, url: `${base}/`, sameAs: [SITE.repo] },
      { '@type': 'WebPage', '@id': `${base}${path}#page`, name, description, url: `${base}${path}`, isPartOf: { '@id': `${base}/#website` }, inLanguage: 'en' },
    ],
  };
}

export function jsonLd(base, o) {
  return `<script type="application/ld+json">${JSON.stringify(jsonLdData(base, o)).replace(/</g, '\\u003c')}</script>`;
}

/**
 * @param {object} o
 * @param {string} o.base     origin, no trailing slash
 * @param {string} o.path     page path, for canonical and JSON-LD
 * @param {string} o.title    page title (also the H1)
 * @param {string} o.description  one sentence, shown as the lead paragraph and in meta description
 * @param {string} o.body     inner HTML of <main> after the H1 and lead
 * @param {string} [o.mdPath] Markdown alternate path
 * @param {boolean} [o.noindex]
 */
export function page({ base, path, title, description, body, mdPath, noindex = false }) {
  const full = title === SITE.name ? title : `${title} | ${SITE.name}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(full)}</title>
<meta name="description" content="${esc(description)}">
${noindex ? '<meta name="robots" content="noindex">\n' : ''}<link rel="canonical" href="${esc(base + path)}">
${mdPath ? `<link rel="alternate" type="text/markdown" href="${esc(mdPath)}">\n` : ''}<link rel="stylesheet" href="/assets/pages.css">
<meta property="og:title" content="${esc(full)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(base + path)}">
${jsonLd(base, { name: full, description, path })}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site">
<a class="brand" href="/">${esc(SITE.name)}</a>
<nav aria-label="Main">
<a href="/">Scan</a>
<a href="/docs">API and MCP</a>
<a href="/checks">Checks</a>
<a href="${SITE.repo}">Source</a>
</nav>
</header>
<main id="main">
<h1>${esc(title)}</h1>
<p class="lead">${esc(description)}</p>
${body}
</main>
<footer class="site">
<p>${esc(SITE.name)} ${esc(SITE.version)}, MIT licensed. Based on the book <cite>${esc(SITE.book)}</cite> by ${esc(SITE.author)} and its <a href="${SITE.demos}">demos</a>. <a href="/privacy">Privacy</a>. <a href="/llms.txt">llms.txt</a>.</p>
</footer>
</body>
</html>
`;
}

export const PAGES_CSS = `:root{--fg:#1d2433;--muted:#5b6475;--bg:#fff;--line:#d8dde6;--accent:#0b5cad;--code:#f3f5f8}
@media (prefers-color-scheme:dark){:root{--fg:#e7eaf0;--muted:#a3abb9;--bg:#121620;--line:#2c3342;--accent:#7fb2ff;--code:#1c2230}}
*{box-sizing:border-box}body{margin:0;font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fg);background:var(--bg)}
a{color:var(--accent)}.skip{position:absolute;left:-999px}.skip:focus{left:8px;top:8px;background:var(--bg);padding:6px}
header.site,footer.site,main{max-width:60rem;margin:0 auto;padding:1rem 1.25rem}
header.site{display:flex;flex-wrap:wrap;gap:1rem;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line)}
header.site nav{display:flex;gap:1rem;flex-wrap:wrap}.brand{font-weight:700;text-decoration:none;color:var(--fg)}
footer.site{border-top:1px solid var(--line);color:var(--muted);font-size:.9rem;margin-top:2rem}
.lead{font-size:1.1rem;color:var(--muted)}h1{line-height:1.2}
pre{background:var(--code);padding:.75rem 1rem;overflow:auto;border-radius:6px}code{background:var(--code);padding:0 .2em;border-radius:3px}pre code{padding:0}
table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{border:1px solid var(--line);padding:.4rem .6rem;text-align:left;vertical-align:top}
.status{display:inline-block;min-width:4.5em;font-weight:600}.status.pass{color:#18794e}.status.fail{color:#c22}.status.warn{color:#a35b00}
form.scan{display:flex;gap:.5rem;flex-wrap:wrap;margin:1rem 0}form.scan input{flex:1 1 20rem;padding:.5rem;font:inherit}form.scan button{padding:.5rem 1rem;font:inherit}
`;
