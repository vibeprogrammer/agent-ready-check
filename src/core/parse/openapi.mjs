// OpenAPI 3.x structural checks (no network, no Ajv): version, info, paths, local $refs, operations.
// Rules from the OpenAPI Specification 3.1/3.2 (required fields: openapi, info.title, info.version; paths or
// webhooks or components). Agent-quality metrics are book chapter 10 guidance.

export const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace', 'query'];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Resolve a local JSON pointer ref (#/components/...) in doc; returns undefined when it does not resolve. */
export function resolveRef(doc, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#')) return undefined;
  let cur = doc;
  for (const raw of ref.slice(1).split('/').slice(1)) {
    const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isObj(cur) && !Array.isArray(cur)) return undefined;
    cur = cur[key];
    if (cur === undefined) return undefined;
  }
  return cur;
}

/** Every operation: [{ method, path, op, params }] with path-level parameters merged. */
export function operations(doc) {
  const out = [];
  if (!isObj(doc?.paths)) return out;
  for (const [path, item0] of Object.entries(doc.paths)) {
    const item = item0?.$ref ? resolveRef(doc, item0.$ref) || {} : item0;
    if (!isObj(item)) continue;
    for (const method of METHODS) {
      const op = item[method];
      if (!isObj(op)) continue;
      const params = [...(item.parameters || []), ...(op.parameters || [])].map((p) => (p?.$ref ? resolveRef(doc, p.$ref) : p)).filter(isObj);
      out.push({ method, path, op, params });
    }
  }
  return out;
}

/**
 * @returns {{version:string|null, major:number|null, errors:string[], warnings:string[], refs:{total:number, external:number, broken:string[]}, operations:number}}
 */
export function validateOpenApi(doc) {
  const errors = []; const warnings = [];
  if (!isObj(doc)) return { version: null, major: null, errors: ['not a JSON/YAML object'], warnings, refs: { total: 0, external: 0, broken: [] }, operations: 0 };
  const version = doc.openapi ? String(doc.openapi) : doc.swagger ? `swagger ${doc.swagger}` : null;
  const major = doc.openapi ? Number(String(doc.openapi).split('.')[0]) : doc.swagger ? 2 : null;
  if (!doc.openapi) errors.push(doc.swagger ? `Swagger ${doc.swagger} (OpenAPI 2.0) is obsolete; agents and tools expect OpenAPI 3.x` : 'no "openapi" version field');
  else if (!/^3\.\d+\.\d+/.test(String(doc.openapi))) errors.push(`"openapi": "${doc.openapi}" is not a 3.x.y version`);
  if (!isObj(doc.info)) errors.push('no "info" object');
  else {
    if (typeof doc.info.title !== 'string' || !doc.info.title.trim()) errors.push('info.title is missing');
    if (doc.info.version === undefined || doc.info.version === '') errors.push('info.version is missing');
    if (!doc.info.description) warnings.push('info.description is missing');
  }
  const hasPaths = isObj(doc.paths); const nOps = operations(doc).length;
  if (!hasPaths && !isObj(doc.webhooks) && !isObj(doc.components)) errors.push('no "paths" (or webhooks/components) object');
  else if (hasPaths && !nOps) warnings.push('"paths" has no operations');
  if (doc.servers !== undefined && !Array.isArray(doc.servers)) errors.push('"servers" must be an array');
  // $ref resolution (local only; external refs are counted, not fetched)
  const broken = []; let total = 0; let external = 0; let visited = 0;
  const walk = (v, depth) => {
    if (depth > 40 || visited > 20000) return;
    visited++;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (!isObj(v)) return;
    if (typeof v.$ref === 'string') {
      total++;
      if (v.$ref.startsWith('#')) { if (resolveRef(doc, v.$ref) === undefined && broken.length < 20) broken.push(v.$ref); }
      else external++;
    }
    for (const [k, x] of Object.entries(v)) if (k !== '$ref') walk(x, depth + 1);
  };
  walk(doc, 0);
  if (broken.length) errors.push(`${broken.length} local $ref(s) do not resolve: ${broken.slice(0, 5).join(', ')}`);
  return { version, major, errors, warnings, refs: { total, external, broken }, operations: nOps };
}
