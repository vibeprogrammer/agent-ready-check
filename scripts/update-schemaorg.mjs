#!/usr/bin/env node
// Rebuild src/data/schemaorg.json from schema.org's published vocabulary (names only, plus each class's
// parents and each property's domains, so checks can tell unknown names from misplaced ones).
//   node scripts/update-schemaorg.mjs
// Source: https://schema.org/version/latest/schemaorg-current-https.jsonld (the "current" release),
// release number and date from https://schema.org/docs/releases.html.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const VOCAB = 'https://schema.org/version/latest/schemaorg-current-https.jsonld';
const RELEASES = 'https://schema.org/docs/releases.html';
const OUT = fileURLToPath(new URL('../src/data/schemaorg.json', import.meta.url));

const name = (id) => String(id || '').replace(/^(schema:|https?:\/\/schema\.org\/)/, '');
const ids = (v) => [].concat(v ?? []).map((x) => name(x?.['@id'] ?? x));

const res = await fetch(VOCAB, { signal: AbortSignal.timeout(60_000) });
if (!res.ok) throw new Error(`${VOCAB}: HTTP ${res.status}`);
const graph = (await res.json())['@graph'];

const classes = {}; const properties = {}; const pending = [];
for (const n of graph) {
  const types = ids(n['@type']);
  const id = name(n['@id']);
  if (!id || id.includes(':')) continue;
  const isPending = ids(n['schema:isPartOf']).some((p) => /pending/.test(p));
  if (types.includes('rdfs:Class')) {
    classes[id] = ids(n['rdfs:subClassOf']).filter((p) => !p.includes(':'));
    if (isPending) pending.push(id);
  } else if (types.includes('rdf:Property')) {
    properties[id] = ids(n['schema:domainIncludes']).filter((p) => !p.includes(':'));
    if (isPending) pending.push(id);
  }
}

let release = null; let releaseDate = null;
try {
  const html = await (await fetch(RELEASES, { signal: AbortSignal.timeout(30_000) })).text();
  // The first row of the release table: <td class="release">30.1<br/>2026-09-16</td>
  const m = /class="release">\s*(\d+(?:\.\d+)?)\s*<br\s*\/?>\s*(\d{4}-\d{2}-\d{2})/.exec(html);
  if (m) { release = m[1]; releaseDate = m[2]; }
} catch { /* the release page is optional; the vocabulary is what counts */ }

const sorted = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
const out = {
  source: VOCAB, release, releaseDate, releaseSource: RELEASES, generated: new Date().toISOString().slice(0, 10),
  counts: { classes: Object.keys(classes).length, properties: Object.keys(properties).length, pending: pending.length },
  classes: sorted(classes), properties: sorted(properties), pending: pending.sort(),
};
const body = JSON.stringify(out);
await writeFile(OUT, body + '\n');
console.log(`schema.org ${release || '(release unknown)'} ${releaseDate || ''}: ${out.counts.classes} classes, ${out.counts.properties} properties -> ${OUT} (${Math.round(body.length / 1024)} KB)`);
