// A small structural linter for JSON Schema objects used as tool input/output schemas (MCP, WebMCP, OpenAPI).
// Not a validator of instances and no Ajv (no eval in Workers): it checks that a schema is well-formed enough
// for an agent to fill it. Rules follow JSON Schema 2020-12 keyword types; the "described" rules are book
// guidance (chapter 10) and labelled as such in messages.

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {any} schema
 * @param {{root?:boolean, requireObject?:boolean, path?:string}} [o]
 * @returns {{errors:string[], warnings:string[], properties:number, described:number}}
 */
export function lintSchema(schema, o = {}) {
  const errors = []; const warnings = []; let properties = 0; let described = 0;
  const path = o.path || 'schema';
  if (schema === true || schema === false) { if (o.requireObject) errors.push(`${path} is a boolean schema, not an object schema`); return { errors, warnings, properties, described }; }
  if (!isObj(schema)) { errors.push(`${path} is not a JSON object`); return { errors, warnings, properties, described }; }
  const walk = (s, p, depth) => {
    if (depth > 12 || !isObj(s)) return;
    if (s.type !== undefined) {
      const ts = [].concat(s.type);
      for (const t of ts) if (!TYPES.has(t)) errors.push(`${p}.type "${t}" is not a JSON Schema type`);
    }
    if (s.properties !== undefined) {
      if (!isObj(s.properties)) errors.push(`${p}.properties must be an object`);
      else for (const [k, v] of Object.entries(s.properties)) {
        if (depth === 0) { properties++; if (isObj(v) && typeof v.description === 'string' && v.description.trim()) described++; }
        if (!isObj(v) && typeof v !== 'boolean') errors.push(`${p}.properties.${k} must be a schema object`);
        else walk(v, `${p}.properties.${k}`, depth + 1);
      }
    }
    if (s.required !== undefined) {
      if (!Array.isArray(s.required) || s.required.some((r) => typeof r !== 'string')) errors.push(`${p}.required must be an array of strings`);
      else if (isObj(s.properties)) for (const r of s.required) if (!(r in s.properties)) errors.push(`${p}.required names "${r}", which is not in properties`);
    }
    if (s.enum !== undefined && (!Array.isArray(s.enum) || !s.enum.length)) errors.push(`${p}.enum must be a non-empty array`);
    if (s.items !== undefined) { if (Array.isArray(s.items)) warnings.push(`${p}.items is an array (draft-07 tuple form); 2020-12 uses prefixItems`); else walk(s.items, `${p}.items`, depth + 1); }
    for (const k of ['anyOf', 'oneOf', 'allOf']) if (s[k] !== undefined) { if (!Array.isArray(s[k])) errors.push(`${p}.${k} must be an array`); else s[k].forEach((x, i) => walk(x, `${p}.${k}[${i}]`, depth + 1)); }
    for (const k of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) if (s[k] !== undefined && typeof s[k] !== 'number') errors.push(`${p}.${k} must be a number`);
  };
  walk(schema, path, 0);
  if (o.requireObject) {
    if (schema.type !== 'object') errors.push(`${path}.type must be "object" (MCP tools/list inputSchema rule)`);
  }
  if (properties > described) warnings.push(`${properties - described} of ${properties} top-level properties have no description (book chapter 10 guidance)`);
  return { errors, warnings, properties, described };
}
