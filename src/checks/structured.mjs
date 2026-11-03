// Checks for the structured-data layer: JSON-LD presence, syntax, schema.org vocabulary and parity with the page.
// Ids and metadata: src/catalog.json. Vocabulary: src/data/schemaorg.json (scripts/update-schemaorg.mjs).
// Ideas adapted from agent-ready-web-demos (MIT, Maxim Salnikov): nordlys-cabins/layers/05-structured-data and
// chapters/18-testing-agent-readiness/scripts/structured-data.mjs.
import { pass, warn, fail, info, neutral } from '../core/result.mjs';
import { parseDocument } from '../core/html.mjs';
import { flattenNodes, typesOf } from '../core/context.mjs';
import vocab from '../data/schemaorg.json' with { type: 'json' };

const SCHEMA = vocab.release ? `schema.org ${vocab.release} (${vocab.releaseDate})` : 'schema.org (current release)';

/** Is class `t` the class `ancestor` or one of its subclasses? */
const isACache = new Map();
export function isA(t, ancestor) {
  const key = `${t}>${ancestor}`;
  if (isACache.has(key)) return isACache.get(key);
  let r = false; const seen = new Set(); const stack = [t];
  while (stack.length) { const c = stack.pop(); if (c === ancestor) { r = true; break; } if (seen.has(c)) continue; seen.add(c); stack.push(...(vocab.classes[c] || [])); }
  isACache.set(key, r);
  return r;
}

const isSchemaContext = (c) => {
  if (!c) return false;
  if (typeof c === 'string') return /^https?:\/\/schema\.org\/?$/i.test(c.trim());
  if (Array.isArray(c)) return c.some(isSchemaContext);
  if (typeof c === 'object') return isSchemaContext(c['@vocab']);
  return false;
};
/** Only schema.org type names (bare or full schema.org IRIs); other vocabularies are skipped. */
const schemaTypes = (node) => [].concat(node?.['@type'] || []).map(String).filter((t) => !/^[a-z][\w+.-]*:/i.test(t) || /^https?:\/\/schema\.org\//i.test(t)).map((t) => t.replace(/^https?:\/\/schema\.org\//i, ''));
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKC').replace(/[\u2018\u2019\u201c\u201d"'`]/g, '').replace(/&amp;/g, '&').replace(/[^\p{L}\p{N}&]+/gu, ' ').trim();
const firstStr = (v) => { const x = [].concat(v ?? [])[0]; return typeof x === 'string' || typeof x === 'number' ? String(x) : (x && typeof x === 'object' && typeof x['@value'] === 'string' ? x['@value'] : null); };

async function blocks(ctx) {
  if (!(await ctx.isHtml())) return null;
  return ctx.jsonld();
}
const notHtml = async (ctx) => { const h = await ctx.home(); return neutral(`The page is not HTML (${h.error || `HTTP ${h.status}`}), so there is no structured data to read.`, { evidence: [h] }); };
const allNodes = (bs) => bs.flatMap((b) => b.nodes);

/** Fields that carry the meaning of the main types (book chapter 5; schema.org and Google's structured-data docs). */
export const KEY_FIELDS = [
  { type: 'Offer', fields: [['price', 'priceSpecification'], ['priceCurrency', 'priceSpecification']] },
  { type: 'AggregateOffer', fields: [['lowPrice', 'price'], ['priceCurrency']] },
  { type: 'Product', fields: [['name'], ['offers', 'aggregateRating', 'review']] },
  { type: 'LodgingBusiness', fields: [['name'], ['address'], ['url']] },
  { type: 'Event', fields: [['name'], ['startDate'], ['location', 'eventAttendanceMode']] },
  { type: 'Article', fields: [['headline', 'name'], ['datePublished'], ['author']] },
  { type: 'FAQPage', fields: [['mainEntity']] },
  { type: 'Organization', fields: [['name'], ['url']] },
  { type: 'WebSite', fields: [['name'], ['url']] },
];

export default {
  'structured.jsonld-present': {
    why: 'JSON-LD gives agents the facts of the page (what it is, prices, dates, who runs it) as data instead of prose to guess from (book chapter 5).',
    fix: { snippet: '<script type="application/ld+json">\n{\n  "@context": "https://schema.org",\n  "@type": "LodgingBusiness",\n  "name": "Fjellro cabin",\n  "url": "https://example.com/cabins/fjellro"\n}\n</script>', prompt: 'Add a <script type="application/ld+json"> block to the page\'s server HTML describing its main entity with schema.org (for example Organization and WebSite on the homepage, Product/Offer on product pages), generated from the same data that renders the visible page.' },
    async run(ctx) {
      const bs = await blocks(ctx); if (!bs) return notHtml(ctx);
      const home = await ctx.home();
      if (bs.length) {
        const types = [...new Set(allNodes(bs).flatMap(typesOf))];
        return pass(`${bs.length} JSON-LD block(s)${types.length ? ` with ${types.slice(0, 6).join(', ')}` : ''}.`, { evidence: [home], details: { blocks: bs.length, types } });
      }
      const doc = await ctx.dom();
      const micro = doc.querySelectorAll('[itemscope][itemtype]').length; const rdfa = doc.querySelectorAll('[typeof][vocab], [typeof][property]').length;
      if (micro || rdfa) return warn(`No JSON-LD, but the page uses ${micro ? `microdata (${micro} items)` : `RDFa (${rdfa} items)`}; JSON-LD is easier for agents to read and keep in sync.`, { evidence: [home], details: { microdata: micro, rdfa } });
      return fail('The page has no JSON-LD structured data (and no microdata or RDFa).', { evidence: [home] });
    },
  },

  'structured.jsonld-syntax': {
    why: 'One stray comma makes the whole JSON-LD block unreadable; agents and search engines then drop all of it silently (book chapter 5).',
    fix: { snippet: '// generate JSON-LD with JSON.stringify, never by string concatenation\nconst ld = JSON.stringify(data).replace(/</g, "\\\\u003c");\nhtml += `<script type="application/ld+json">${ld}</script>`;', prompt: 'Generate every JSON-LD block with a JSON serializer (JSON.stringify or the framework\'s equivalent) instead of templates or string concatenation, escape "<" as \\u003c, and add a unit test that JSON.parse succeeds on each block.' },
    async run(ctx) {
      const bs = await blocks(ctx); if (!bs) return notHtml(ctx);
      const home = await ctx.home();
      if (!bs.length) return neutral('No JSON-LD blocks to parse.', { evidence: [home] });
      const bad = bs.filter((b) => b.error);
      const details = { blocks: bs.length, errors: bad.map((b) => ({ index: b.index, error: b.error, excerpt: b.raw.trim().slice(0, 200) })) };
      if (bad.length) return fail(`${bad.length} of ${bs.length} JSON-LD block(s) do not parse (block ${bad[0].index + 1}: ${bad[0].error}).`, { evidence: [home], details });
      return pass(`All ${bs.length} JSON-LD block(s) parse as JSON.`, { evidence: [home], details });
    },
  },

  'structured.jsonld-context': {
    why: 'Without "@context": "https://schema.org" the types and properties mean nothing to a JSON-LD processor; "Product" is just a string (book chapter 5).',
    fix: { snippet: '{ "@context": "https://schema.org", "@type": "Organization", "name": "Nordlys Cabins" }', prompt: 'Set "@context": "https://schema.org" on the top-level object of every JSON-LD block (or once on the object that holds "@graph").' },
    async run(ctx) {
      const bs = await blocks(ctx); if (!bs) return notHtml(ctx);
      const home = await ctx.home();
      const parsed = bs.filter((b) => b.data != null);
      if (!parsed.length) return neutral('No parseable JSON-LD blocks.', { evidence: [home] });
      const tops = parsed.flatMap((b) => (Array.isArray(b.data) ? b.data : [b.data]).map((d) => ({ block: b.index, ctx: d && typeof d === 'object' ? d['@context'] : undefined })));
      const ok = tops.filter((t) => isSchemaContext(t.ctx));
      const http = ok.filter((t) => JSON.stringify(t.ctx).includes('http://schema.org'));
      const details = { topLevel: tops.length, schemaContext: ok.length, contexts: [...new Set(tops.map((t) => JSON.stringify(t.ctx ?? null)))].slice(0, 5) };
      if (!ok.length) return fail(`None of ${tops.length} top-level JSON-LD object(s) declares the schema.org @context.`, { evidence: [home], details });
      if (ok.length < tops.length) return warn(`${tops.length - ok.length} of ${tops.length} top-level JSON-LD object(s) lack the schema.org @context.`, { evidence: [home], details });
      return pass(`All ${tops.length} top-level JSON-LD object(s) use the schema.org context${http.length ? ' (http:// works; https:// is preferred)' : ''}.`, { evidence: [home], details });
    },
  },

  'structured.schema-types': {
    why: 'A misspelled or invented @type ("Cabin", "Hotell") is ignored by every consumer; the data is there but says nothing (book chapter 5).',
    fix: { snippet: '"@type": "LodgingBusiness"   // not "Cabin"; see https://schema.org/LodgingBusiness', prompt: 'Replace every JSON-LD @type that is not a schema.org class with the closest real one (look it up on schema.org; for example LodgingBusiness, Product, Event), keeping the exact capitalisation.' },
    async run(ctx) {
      const bs = await blocks(ctx); if (!bs) return notHtml(ctx);
      const home = await ctx.home();
      const nodes = allNodes(bs);
      const types = nodes.flatMap(schemaTypes);
      if (!types.length) return neutral('No schema.org @type values to check.', { evidence: [home] });
      const uniq = [...new Set(types)];
      const unknown = uniq.filter((t) => !vocab.classes[t]);
      const pending = uniq.filter((t) => vocab.pending.includes(t));
      const details = { vocabulary: SCHEMA, types: uniq, unknown, pending, suggestions: Object.fromEntries(unknown.map((u) => [u, suggest(u, Object.keys(vocab.classes))]).filter(([, s]) => s)) };
      if (unknown.length) return (unknown.length * 2 > uniq.length ? fail : warn)(`${unknown.length} of ${uniq.length} @type value(s) are not schema.org classes: ${unknown.slice(0, 4).join(', ')}.`, { evidence: [home], details });
      return pass(`All ${uniq.length} @type value(s) exist in ${SCHEMA}${pending.length ? `; ${pending.join(', ')} ${pending.length === 1 ? 'is' : 'are'} still in the pending area` : ''}.`, { evidence: [home], details });
    },
  },

  'structured.schema-properties': {
    why: 'Properties that schema.org does not define ("pricePerNight", "image_url") are dropped by consumers, so the fact they carry never reaches an agent (book chapter 5).',
    fix: { snippet: '"offers": { "@type": "Offer", "price": "2400", "priceCurrency": "NOK" }   // not "pricePerNight"', prompt: 'Rename every JSON-LD property that schema.org does not define to the matching schema.org property (check the type\'s page on schema.org), or move site-specific data out of the schema.org block.' },
    async run(ctx) {
      const bs = await blocks(ctx); if (!bs) return notHtml(ctx);
      const home = await ctx.home();
      const nodes = allNodes(bs).filter((n) => schemaTypes(n).length);
      if (!nodes.length) return neutral('No schema.org nodes to check.', { evidence: [home] });
      const used = new Map(); const misplaced = new Set();
      for (const n of nodes) {
        const types = schemaTypes(n).filter((t) => vocab.classes[t]);
        for (const k of Object.keys(n)) {
          if (k.startsWith('@') || /^[a-z][\w+.-]*:/i.test(k)) continue;
          used.set(k, (used.get(k) || 0) + 1);
          const dom = vocab.properties[k];
          if (dom && dom.length && types.length && !types.some((t) => dom.some((d) => isA(t, d)))) misplaced.add(`${types[0]}.${k}`);
        }
      }
      const props = [...used.keys()];
      const unknown = props.filter((p) => !vocab.properties[p]);
      const details = { vocabulary: SCHEMA, properties: props.length, unknown, suggestions: Object.fromEntries(unknown.map((u) => [u, suggest(u, Object.keys(vocab.properties))]).filter(([, s]) => s)), outsideDomain: [...misplaced].slice(0, 20), note: 'outsideDomain lists properties schema.org does not list for that type; schema.org treats domains as advice, so they are not scored.' };
      if (unknown.length) return warn(`${unknown.length} of ${props.length} propert${props.length === 1 ? 'y is' : 'ies are'} not defined by schema.org: ${unknown.slice(0, 5).join(', ')}.`, { evidence: [home], details });
      return pass(`All ${props.length} propert${props.length === 1 ? 'y' : 'ies'} used exist in ${SCHEMA}${misplaced.size ? ` (${misplaced.size} used outside their listed types)` : ''}.`, { evidence: [home], details });
    },
  },

  'structured.key-properties': {
    why: 'An Offer without a price, an Event without a date or a business without an address is structured data that cannot answer the question an agent came with (book chapter 5).',
    fix: { snippet: '{\n  "@type": "Offer",\n  "price": "2400",\n  "priceCurrency": "NOK",\n  "availability": "https://schema.org/InStock"\n}', prompt: 'Fill the meaning-carrying fields of each main JSON-LD node: name and url for Organization/WebSite; name and offers for Product; price and priceCurrency for Offer; name, address and url for LodgingBusiness; name, startDate and location for Event; headline, datePublished and author for Article. Use the same values the page shows.' },
    async run(ctx) {
      const bs = await blocks(ctx); if (!bs) return notHtml(ctx);
      const home = await ctx.home();
      const rows = [];
      for (const n of allNodes(bs)) {
        const types = schemaTypes(n).filter((t) => vocab.classes[t]);
        const spec = KEY_FIELDS.find((s) => types.some((t) => isA(t, s.type)));
        if (!spec) continue;
        const missing = spec.fields.filter((alts) => !alts.some((f) => n[f] != null && n[f] !== '')).map((alts) => alts.join(' or '));
        rows.push({ type: types[0], as: spec.type, name: firstStr(n.name) || firstStr(n.headline) || null, missing });
      }
      if (!rows.length) return neutral('None of the main schema.org types (Organization, WebSite, Product, Offer, LodgingBusiness, Event, Article, FAQPage) is on the page.', { evidence: [home] });
      const incomplete = rows.filter((r) => r.missing.length);
      const details = { nodes: rows };
      if (!incomplete.length) return pass(`${rows.length} main node(s) (${[...new Set(rows.map((r) => r.type))].join(', ')}) carry their key properties.`, { evidence: [home], details });
      const first = incomplete[0];
      return (incomplete.length * 2 > rows.length ? fail : warn)(`${incomplete.length} of ${rows.length} main node(s) miss key properties, e.g. ${first.type}${first.name ? ` "${first.name}"` : ''} lacks ${first.missing.join(', ')}.`, { evidence: [home], details });
    },
  },

  'structured.visible-parity': {
    why: 'Structured data that disagrees with the page (an old price, a different name) misleads agents and is against search engines\' guidelines. The JSON-LD should say what the page says (book chapter 5).',
    fix: { snippet: '// render the JSON-LD and the visible HTML from the same object\nconst cabin = await db.cabin(slug);\nhtml(`<h1>${cabin.name}</h1><p>${cabin.price} NOK</p>`);\njsonld({ "@type": "Product", name: cabin.name, offers: { price: cabin.price, priceCurrency: "NOK" } });', prompt: 'Generate the JSON-LD and the visible HTML from the same data object so names, headlines, descriptions and prices cannot drift. Remove JSON-LD values that the page does not show.' },
    async run(ctx) {
      const bs = await blocks(ctx); if (!bs) return notHtml(ctx);
      const home = await ctx.home();
      const bd = await ctx.browserData();
      const serverText = await ctx.text();
      const textSrc = bd?.ok && bd.renderedText && bd.renderedText.length > serverText.length ? bd.renderedText : serverText;
      const hay = norm(textSrc);
      const hayDigits = textSrc.replace(/[\s,.\u00a0\u202f'’]/g, '');
      const values = [];
      for (const n of allNodes(bs)) {
        const types = schemaTypes(n);
        if (types.some((t) => isA(t, 'WebSite') || t === 'BreadcrumbList' || isA(t, 'ImageObject'))) continue;
        for (const f of ['name', 'headline', 'description']) {
          const v = firstStr(n[f]);
          if (!v || /^https?:\/\//.test(v) || norm(v).length < 3) continue;
          values.push({ type: types[0] || '?', field: f, value: v.slice(0, 120), found: f === 'description' ? descFound(v, hay) : hay.includes(norm(v)) });
        }
        for (const f of ['price', 'lowPrice']) {
          const v = firstStr(n[f]);
          if (v == null || !/\d/.test(v)) continue;
          const digits = String(v).replace(/[.,]0+$/, '').replace(/[^\d]/g, '');
          if (!digits || digits === '0') continue;
          values.push({ type: types[0] || '?', field: f, value: String(v), found: hayDigits.includes(digits) });
        }
      }
      if (!values.length) return neutral('No name, headline, description or price values in the JSON-LD to compare.', { evidence: [home] });
      const found = values.filter((v) => v.found).length;
      const pct = Math.round((100 * found) / values.length);
      const missing = values.filter((v) => !v.found);
      const details = { compared: values.length, found, percent: pct, against: textSrc === serverText ? 'server HTML text' : 'rendered text (browser)', values: values.slice(0, 30), heuristic: 'Matching is normalised substring search (descriptions: 60% of their longer words); the 80% pass and 50% fail lines are checker heuristics.' };
      const msg = `${found} of ${values.length} JSON-LD value(s) (${pct}%) appear in the visible text`;
      if (pct >= 80) return pass(`${msg}.`, { evidence: [home], details });
      return (pct >= 50 ? warn : fail)(`${msg}; e.g. ${missing[0].type}.${missing[0].field} "${missing[0].value.slice(0, 60)}" is not on the page.`, { evidence: [home], details });
    },
  },

  'structured.identity': {
    why: 'An Organization (or WebSite) node with name, url, logo and sameAs links tells agents who runs the site and ties it to its other profiles, so they can trust and cite it (book chapter 5).',
    fix: { snippet: '{\n  "@context": "https://schema.org",\n  "@type": "Organization",\n  "name": "Nordlys Cabins",\n  "url": "https://example.com/",\n  "logo": "https://example.com/logo.png",\n  "sameAs": ["https://www.linkedin.com/company/example"]\n}', prompt: 'Add an Organization (or the more specific LocalBusiness subtype) and a WebSite JSON-LD node to the homepage with name, url, logo and sameAs links to the official profiles.' },
    async run(ctx) {
      let bs = await blocks(ctx); if (!bs) return notHtml(ctx);
      const ev = [await ctx.home()];
      const atRoot = ctx.url.pathname === '/' && !ctx.url.search;
      if (!atRoot) {
        const root = await ctx.root(); ev.push(root);
        if (root.ok && /html/.test(root.contentType)) {
          const doc = parseDocument(root.text);
          const extra = [...doc.querySelectorAll('script[type="application/ld+json"]')].map((s) => { try { return { nodes: flattenNodes(JSON.parse(s.textContent)) }; } catch { return { nodes: [] }; } });
          bs = [...bs, ...extra];
        }
      }
      const nodes = allNodes(bs);
      const org = nodes.filter((n) => schemaTypes(n).some((t) => isA(t, 'Organization') || t === 'Person'));
      const site = nodes.filter((n) => schemaTypes(n).some((t) => isA(t, 'WebSite')));
      const complete = [...org, ...site].filter((n) => n.name && n.url);
      const o = org.find((n) => n.name && n.url) || org[0];
      const details = { organization: org.length ? { type: schemaTypes(o)[0], name: firstStr(o.name), url: firstStr(o.url), logo: !!o.logo, sameAs: [].concat(o.sameAs || []).length } : null, website: site.length > 0 };
      if (!org.length && !site.length) return fail(`${atRoot ? 'The homepage' : 'Neither this page nor the homepage'} has no Organization or WebSite node.`, { evidence: ev, details });
      if (!complete.length) return warn(`An ${org.length ? 'Organization' : 'WebSite'} node is present but lacks name or url.`, { evidence: ev, details });
      const extras = o ? [o.logo && 'logo', [].concat(o.sameAs || []).length && `${[].concat(o.sameAs).length} sameAs link(s)`].filter(Boolean) : [];
      return pass(`The site identifies itself: ${complete.map((n) => `${schemaTypes(n)[0]} "${firstStr(n.name)}"`).slice(0, 2).join(' and ')}${extras.length ? ` with ${extras.join(' and ')}` : ''}.`, { evidence: ev, details });
    },
  },

  'structured.canonical': {
    why: 'The canonical URL tells agents which address is the real one, so they cite and deduplicate one URL instead of five tracking variants (book chapter 5).',
    fix: { snippet: '<link rel="canonical" href="https://example.com/cabins/fjellro">', prompt: 'Add <link rel="canonical" href="..."> with the absolute, preferred URL of each page (same host and scheme the site redirects to) to the page head template.' },
    async run(ctx) {
      if (!(await ctx.isHtml())) return notHtml(ctx);
      const home = await ctx.home();
      const doc = await ctx.dom();
      const raw = [...doc.querySelectorAll('link[rel][href]')].filter((l) => l.getAttribute('rel').toLowerCase().split(/\s+/).includes('canonical')).map((l) => l.getAttribute('href'));
      const all = (await ctx.links()).filter((l) => l.rel === 'canonical');
      if (!all.length) return fail('No rel=canonical link (HTML or Link header).', { evidence: [home] });
      const hrefs = [...new Set(all.map((l) => l.href))];
      const details = { canonical: hrefs, raw, finalUrl: home.finalUrl };
      if (hrefs.length > 1) return warn(`${hrefs.length} different canonical URLs are declared: ${hrefs.slice(0, 2).join(', ')}.`, { evidence: [home], details });
      const c = hrefs[0];
      let cu; try { cu = new URL(c); } catch { return warn(`The canonical URL "${c}" is not a valid URL.`, { evidence: [home], details }); }
      if (raw.some((r) => r && !/^https?:\/\//i.test(r))) return warn(`The canonical link is relative ("${raw[0]}"); use an absolute URL.`, { evidence: [home], details });
      const same = (a, b) => { try { const x = new URL(a); const y = new URL(b); return x.protocol === y.protocol && x.host === y.host && x.pathname.replace(/\/+$/, '') === y.pathname.replace(/\/+$/, '') && x.search === y.search; } catch { return false; } };
      if (same(c, home.finalUrl)) return pass(`Canonical URL matches the page: ${c}.`, { evidence: [home], details });
      if (cu.hostname.replace(/^www\./, '') !== ctx.host.replace(/^www\./, '')) return warn(`The canonical URL points to another site: ${c}.`, { evidence: [home], details });
      const probe = await ctx.fetch(c, { method: 'HEAD', purpose: 'canonical target' });
      details.target = { status: probe.status, finalUrl: probe.finalUrl };
      if (probe.status && probe.status < 400 && same(probe.finalUrl, home.finalUrl)) return pass(`Canonical URL ${c} redirects to this page.`, { evidence: [home, probe], details });
      if (probe.status && probe.status >= 400 && probe.status !== 405) return fail(`The canonical URL ${c} answers HTTP ${probe.status}.`, { evidence: [home, probe], details });
      return warn(`The canonical URL (${c}) differs from the page URL (${home.finalUrl}); fine for a duplicate, wrong for the main page.`, { evidence: [home, probe], details });
    },
  },

  'structured.meta-description': {
    why: 'The meta description and Open Graph title/description are the summary agents and link previews show. Without them they write their own, usually from the cookie banner (book chapter 5).',
    fix: { snippet: '<meta name="description" content="Two-bedroom cabin with sauna, sleeps 6, two hours from Oslo.">\n<meta property="og:title" content="Fjellro cabin | Nordlys Cabins">\n<meta property="og:description" content="Two-bedroom cabin with sauna, sleeps 6.">', prompt: 'Add a page-specific <meta name="description">, <meta property="og:title"> and <meta property="og:description"> to every page head, generated from the page\'s own content.' },
    async run(ctx) {
      if (!(await ctx.isHtml())) return notHtml(ctx);
      const home = await ctx.home();
      const doc = await ctx.dom();
      const meta = (sel) => (doc.querySelector(sel)?.getAttribute('content') || '').trim();
      const desc = [...doc.querySelectorAll('meta[name][content]')].find((m) => m.getAttribute('name').toLowerCase() === 'description');
      const v = { description: (desc?.getAttribute('content') || '').trim(), 'og:title': meta('meta[property="og:title"]'), 'og:description': meta('meta[property="og:description"]') };
      const missing = Object.keys(v).filter((k) => !v[k]);
      const details = { ...v, 'og:image': meta('meta[property="og:image"]') || null };
      if (!missing.length) return pass(`Meta description and Open Graph title/description are set ("${v.description.slice(0, 80)}").`, { evidence: [home], details });
      if (missing.length === 3) return fail('No meta description, og:title or og:description.', { evidence: [home], details });
      return warn(`Missing: ${missing.join(', ')}.`, { evidence: [home], details });
    },
  },
};

/** Is most of a description on the page? 60% of its words of 4+ letters (checker heuristic). */
function descFound(v, hay) {
  const n = norm(v);
  if (hay.includes(n.slice(0, 60))) return true;
  const words = [...new Set(n.split(' ').filter((w) => w.length >= 4))];
  if (!words.length) return hay.includes(n);
  return words.filter((w) => hay.includes(w)).length / words.length >= 0.6;
}

/** A close schema.org name for a typo (case-insensitive match or edit distance <= 2). */
function suggest(name, names) {
  const l = name.toLowerCase();
  const ci = names.find((n) => n.toLowerCase() === l); if (ci) return ci;
  let best = null; let bd = 3;
  for (const n of names) { if (Math.abs(n.length - name.length) > 2) continue; const d = lev(l, n.toLowerCase(), bd); if (d < bd) { bd = d; best = n; } }
  return best;
}
function lev(a, b, max) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let rowMin = i;
    for (let j = 1; j <= b.length; j++) { cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); rowMin = Math.min(rowMin, cur[j]); }
    if (rowMin >= max) return max;
    prev = cur;
  }
  return prev[b.length];
}
void info;
