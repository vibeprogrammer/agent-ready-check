// Checks for the discovery layer. Ids and metadata: src/catalog.json. Owner: H2.
import { pass, warn, fail, info, neutral, error } from '../core/result.mjs';
import { apiSignals, mcpSignals, authSignals } from '../core/discover.mjs';

/** GET a well-known JSON file with one shared request shape (so every check reuses the same exchange). */
export const wk = (ctx, path, purpose) => ctx.json(path, { purpose: purpose || `well-known ${path}` });

const MEDIA_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
const ARD_WELL_KNOWN = '/.well-known/ard.json';
const ARD_LEGACY = '/.well-known/ai-catalog.json';

/** A valid ARD entry by isitagentready's published rule (book demo chapters/02): type, displayName and url or data. */
// Cloudflare's live scanner also requires displayName (its message on github.com, 3 Nov 2026: "entry 0 is missing displayName").
const iiaEntryOk = (e) => !!(e && e.type && e.displayName && (e.url || e.data));

/** Locate the ARD manifest in Lighthouse/isitagentready order. { found, source, url, ex, json, legacy, tried:[{source,url,error}] } */
export function ardManifest(ctx) {
  return ctx.memo('discovery:ard', async () => {
    const robots = await ctx.robots();
    const links = await ctx.links();
    const cands = [];
    for (const a of robots.parsed?.agentmaps || []) cands.push({ source: 'robots.txt Agentmap', url: a });
    for (const l of links.filter((x) => x.rel === 'ard')) cands.push({ source: l.source === 'html' ? 'link rel="ard"' : 'Link header rel="ard"', url: l.href });
    cands.push({ source: ARD_WELL_KNOWN, url: ctx.abs(ARD_WELL_KNOWN) });
    cands.push({ source: `${ARD_LEGACY} (legacy)`, url: ctx.abs(ARD_LEGACY), legacy: true });
    const tried = []; const seen = new Set();
    for (const c of cands) {
      let url; try { url = new URL(c.url, ctx.origin).href; } catch { tried.push({ ...c, error: 'not a URL' }); continue; }
      if (seen.has(url)) continue; seen.add(url);
      const r = await wk(ctx, url, 'ard manifest');
      if (r.json && typeof r.json === 'object') return { found: true, ...c, url, ex: r.ex, json: r.json, legacy: !!c.legacy, tried: [...tried, { ...c, url, error: null }] };
      tried.push({ ...c, url, error: r.error, ex: r.ex });
    }
    return { found: false, tried };
  });
}

/** sha256:<hex> of a string's UTF-8 bytes (WebCrypto: Node and Workers). */
export async function sha256Hex(text) {
  const bytes = text instanceof Uint8Array ? text : new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Agent Skills index: { found, path, ex, json, legacy, tried } */
export function skillsIndex(ctx) {
  return ctx.memo('discovery:skills', async () => {
    const tried = [];
    for (const [path, legacy] of [['/.well-known/agent-skills/index.json', false], ['/.well-known/skills/index.json', true]]) {
      const r = await wk(ctx, path, 'agent skills index');
      tried.push(r.ex);
      if (r.json && typeof r.json === 'object') return { found: true, path, ex: r.ex, json: r.json, legacy, tried };
    }
    return { found: false, tried };
  });
}

// Agent Skills name rule (agentskills.io specification): 1-64 characters, lowercase letters, digits and hyphens.
const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export default {
  'discovery.ard': {
    why: 'An ARD manifest lists everything an agent can use on your site (MCP servers, skills, APIs) in one file, found through robots.txt, a link or a well-known path. Lighthouse 13.6 audits it (book chapter 11). ARD is a proposal (v0.91).',
    fix: {
      snippet: 'Agentmap: https://example.com/.well-known/ard.json\n\nLink: </.well-known/ard.json>; rel="ard"',
      prompt: 'Publish an ARD manifest at /.well-known/ard.json with a specVersion and an entries array (identifier urn:air:<domain>:<namespace>:<name>, displayName, IANA media type in "type", and exactly one of url or data), then point to it with an Agentmap: line in robots.txt and a Link header rel="ard" on the homepage.',
    },
    async run(ctx) {
      const a = await ardManifest(ctx);
      const evidence = a.found ? [a.ex] : a.tried.map((t) => t.ex);
      if (!a.found) return fail(`No ARD manifest found (tried ${a.tried.map((t) => t.source).join(', ')}).`, { evidence, compat: { status: 'fail', message: 'no ARD manifest' }, details: { tried: a.tried.map((t) => ({ source: t.source, url: t.url, error: t.error })) } });
      const entries = Array.isArray(a.json.entries) ? a.json.entries : [];
      const okEntries = entries.filter(iiaEntryOk);
      const compatOk = !!a.json.specVersion && okEntries.length > 0;
      const compat = { status: compatOk ? 'pass' : 'fail', message: compatOk ? `ARD manifest via ${a.source} with ${okEntries.length} entr${okEntries.length === 1 ? 'y' : 'ies'}` : 'manifest without specVersion or a valid entry' };
      const details = { source: a.source, url: a.url, entries: entries.length, valid: okEntries.length, legacy: a.legacy };
      if (!compatOk) return fail(`An ARD manifest was found via ${a.source}, but it ${a.json.specVersion ? 'has no valid entry (type plus url or data)' : 'declares no specVersion'}.`, { evidence, compat, details });
      if (a.legacy) return warn(`An ARD-style manifest was found only at the legacy ${ARD_LEGACY} location (${okEntries.length} entr${okEntries.length === 1 ? 'y' : 'ies'}); Lighthouse flags it as legacy. Move it to ${ARD_WELL_KNOWN}.`, { evidence, compat, details });
      return pass(`ARD manifest found via ${a.source} with ${okEntries.length} entr${okEntries.length === 1 ? 'y' : 'ies'}.`, { evidence, compat, details });
    },
  },

  'discovery.ard-valid': {
    why: 'Agents and Lighthouse read every ARD entry; a wrong identifier, a missing media type or both url and data make an entry unusable (book chapter 11).',
    fix: {
      snippet: '{\n  "specVersion": "1.0",\n  "entries": [{\n    "identifier": "urn:air:example.com:mcp:shop",\n    "displayName": "Example shop",\n    "type": "application/mcp-server-card+json",\n    "url": "https://example.com/mcp/server-card"\n  }]\n}',
      prompt: 'Fix every entry in the ARD manifest: identifier urn:air:<your-domain>:<namespace>:<name>, a displayName, an IANA media type in "type", exactly one of url or data. Serve it at /.well-known/ard.json (not the legacy ai-catalog.json).',
    },
    async run(ctx) {
      const a = await ardManifest(ctx);
      if (!a.found) return neutral('No ARD manifest to validate (Lighthouse treats this as not applicable).');
      const j = a.json; const errs = []; const notes = [];
      if (typeof j.specVersion !== 'string' && typeof j.specVersion !== 'number') errs.push('no specVersion');
      if (!Array.isArray(j.entries) || !j.entries.length) errs.push('no entries');
      const host = new URL(a.url).hostname; const base = host.replace(/^www\./, '');
      (Array.isArray(j.entries) ? j.entries : []).slice(0, 100).forEach((e, i) => {
        const id = `entries[${i}]`;
        if (!e || typeof e !== 'object') { errs.push(`${id} is not an object`); return; }
        const m = /^urn:air:([^:]+):[^:]+:.+$/.exec(e.identifier || '');
        if (!m) errs.push(`${id}.identifier "${e.identifier || ''}" is not urn:air:<domain>:<namespace>:<name>`);
        else if (!m[1].replace(/^www\./, '').endsWith(base) && !base.endsWith(m[1].replace(/^www\./, ''))) notes.push(`${id}.identifier names ${m[1]}, not ${host}`);
        if (!e.displayName) errs.push(`${id} has no displayName`);
        if (!MEDIA_TYPE_RE.test(e.type || '')) errs.push(`${id}.type "${e.type || ''}" is not a media type`);
        if (!!e.url === (e.data !== undefined)) errs.push(`${id} must have exactly one of url or data`);
      });
      if (!j.host) notes.push('no host object (optional; isitagentready\'s fix text mentions it)');
      if (a.legacy) notes.push(`served at the legacy ${ARD_LEGACY} location`);
      const details = { source: a.source, entries: j.entries?.length || 0, errors: errs.slice(0, 20), notes };
      if (errs.length) return fail(`The ARD manifest has ${errs.length} problem(s): ${errs.slice(0, 2).join('; ')}.`, { evidence: [a.ex], details });
      if (a.legacy) return warn(`The ARD manifest is valid but served at the legacy ${ARD_LEGACY} location.`, { evidence: [a.ex], details });
      return pass(`The ARD manifest (spec ${j.specVersion}) has ${j.entries.length} valid entr${j.entries.length === 1 ? 'y' : 'ies'}${notes.length ? ` (${notes.join('; ')})` : ''}.`, { evidence: [a.ex], details });
    },
  },

  'discovery.agent-skills': {
    why: 'An Agent Skills index lets agents download ready-made instructions for working with your site. isitagentready counts it toward Level 4 (book chapter 11).',
    fix: {
      snippet: '{\n  "$schema": "https://schemas.agentskills.io/discovery/0.2.0/schema.json",\n  "skills": [{ "name": "place-an-order", "type": "skill-md", "description": "Order from Example shop", "url": "/.well-known/agent-skills/place-an-order/SKILL.md", "digest": "sha256:<hex>" }]\n}',
      prompt: 'Publish /.well-known/agent-skills/index.json (Agent Skills Discovery v0.2.0) with $schema and a skills array; each entry has name, type, description, url and a sha256 digest of the skill file. Serve each SKILL.md at its url.',
    },
    async run(ctx) {
      const s = await skillsIndex(ctx);
      const ok = s.found && Array.isArray(s.json.skills);
      const compat = { status: ok ? 'pass' : 'fail', message: ok ? `Agent Skills index at ${s.path}` : 'no Agent Skills index with a skills array' };
      if (!s.found) return fail('No Agent Skills index at /.well-known/agent-skills/index.json (or the legacy /.well-known/skills/index.json).', { evidence: s.tried, compat });
      if (!ok) return fail(`${s.path} is JSON but has no "skills" array.`, { evidence: [s.ex], compat });
      const n = s.json.skills.length;
      const details = { path: s.path, skills: n, legacy: s.legacy };
      if (!n) return warn(`${s.path} has an empty skills array.`, { evidence: [s.ex], compat, details });
      if (s.legacy) return warn(`An Agent Skills index with ${n} skill(s) is at the legacy ${s.path}; v0.2.0 uses /.well-known/agent-skills/index.json.`, { evidence: [s.ex], compat, details });
      return pass(`An Agent Skills index lists ${n} skill(s).`, { evidence: [s.ex], compat, details });
    },
  },

  'discovery.agent-skills-valid': {
    why: 'The digest lets an agent verify it got the skill the site published, not a tampered copy; missing fields or stale digests make the index untrustworthy (book chapter 11).',
    fix: {
      snippet: 'digest = "sha256:" + sha256(file bytes as served).hex()\n# shell: printf "sha256:%s" "$(curl -s https://example.com/.well-known/agent-skills/x/SKILL.md | sha256sum | cut -d" " -f1)"',
      prompt: 'Give every entry in /.well-known/agent-skills/index.json a name (lowercase, digits, hyphens), type, description, url and digest; regenerate each digest as sha256 of the exact bytes served at the url (build step, not by hand) and add "$schema".',
    },
    async run(ctx) {
      const s = await skillsIndex(ctx);
      if (!s.found || !Array.isArray(s.json.skills) || !s.json.skills.length) return neutral('No Agent Skills entries to validate (see discovery.agent-skills).');
      const errs = []; const notes = []; const limits = []; const evidence = [s.ex]; const results = [];
      if (!s.json.$schema) notes.push('no $schema');
      if (s.legacy) notes.push('legacy index format (v0.2.0 adds type, url and digest per entry)');
      const entries = s.json.skills.slice(0, 50);
      for (const [i, e] of entries.entries()) {
        const id = e?.name || `skills[${i}]`;
        // v0.2.0 entries need all five fields; the legacy index (/.well-known/skills/) only name and description
        for (const k of s.legacy ? ['name', 'description'] : ['name', 'type', 'description', 'url', 'digest']) if (!e?.[k]) errs.push(`${id}: no ${k}`);
        if (e?.name && !SKILL_NAME_RE.test(e.name) || (e?.name || '').length > 64) notes.push(`${id}: name is not lowercase letters, digits and hyphens (max 64)`);
      }
      let checked = 0; let matched = 0;
      for (const e of entries.filter((x) => x?.url && x?.digest).slice(0, 10)) {
        let url; try { url = new URL(e.url, s.ex.finalUrl || ctx.abs(s.path)).href; } catch { errs.push(`${e.name}: url is not a URL`); continue; }
        const ex = await ctx.fetch(url, { accept: 'text/markdown, text/plain, */*;q=0.5', maxBytes: 1_048_576, purpose: 'agent skill file' });
        evidence.push(ex);
        if (!ex.ok) { errs.push(`${e.name}: ${new URL(url).pathname} answers ${ex.error || `HTTP ${ex.status}`}`); continue; }
        if (!ex.raw && !/^(skill-md|md|markdown)$/i.test(e.type || 'skill-md') && !/text|markdown|json|yaml/.test(ex.contentType)) { limits.push(`${e.name}: ${e.type} file, digest not verified`); continue; }
        if (ex.truncated) { limits.push(`${e.name}: file larger than 1 MB, digest not verified`); continue; }
        checked++;
        const want = String(e.digest).replace(/^sha256:/i, '').toLowerCase();
        const got = await sha256Hex(ex.raw || ex.text);
        results.push({ name: e.name, match: want === got });
        if (want === got) matched++; else errs.push(`${e.name}: digest does not match the served file (sha256:${got.slice(0, 12)}...)`);
      }
      const details = { entries: s.json.skills.length, digestsChecked: checked, digestsMatched: matched, results, errors: errs.slice(0, 20), notes, notVerified: limits, limit: 'at most 10 skill files are fetched; digests are computed over the bytes as served (up to 1 MB)' };
      const digestWords = checked ? `${checked} checked digest(s) match the served files` : 'no digest could be checked here';
      const limitWords = limits.length ? ` (${limits.length} not verifiable here, e.g. ${limits[0]})` : '';
      if (errs.length) return fail(`${errs.length} problem(s) in the skills index: ${errs.slice(0, 2).join('; ')}.`, { evidence, details });
      if (notes.length) return warn(`Entries are complete and ${digestWords}${limitWords}, but: ${notes.slice(0, 3).join('; ')}.`, { evidence, details });
      if (!checked) return info(`All ${s.json.skills.length} skill entries are complete; ${digestWords}${limitWords}.`, { evidence, details });
      return pass(`All ${s.json.skills.length} skill entries are complete and ${digestWords}${limitWords}.`, { evidence, details });
    },
  },

  'discovery.a2a-card': {
    why: 'An A2A Agent Card describes an agent your site runs, so other agents can delegate tasks to it. Only relevant if you operate an agent; isitagentready makes it opt-in (book chapter 11).',
    fix: {
      snippet: '{ "name": "Example concierge", "version": "1.0.0", "description": "Answers questions about orders", "supportedInterfaces": [{ "url": "https://example.com/a2a", "protocolBinding": "JSONRPC" }], "skills": [] }',
      prompt: 'If the site operates an A2A agent, serve /.well-known/agent-card.json (A2A 1.0) with name, version, description, supportedInterfaces and skills.',
    },
    async run(ctx) {
      const r = await wk(ctx, '/.well-known/agent-card.json', 'a2a agent card');
      const j = r.json; const ok = !!(j?.name && j?.version && j?.supportedInterfaces);
      const compat = { status: ok ? 'pass' : 'fail', message: ok ? 'A2A Agent Card' : 'no valid A2A Agent Card' };
      if (ok) return pass(`An A2A Agent Card for "${j.name}" ${j.version} is published.`, { evidence: [r.ex], compat, details: { name: j.name, version: j.version } });
      if (j) return fail(`/.well-known/agent-card.json lacks ${['name', 'version', 'supportedInterfaces'].filter((k) => !j[k]).join(', ')}.`, { evidence: [r.ex], compat });
      return fail('No A2A Agent Card at /.well-known/agent-card.json.', { evidence: [r.ex], compat });
    },
  },

  'discovery.dns-aid': {
    why: 'DNS-AID publishes agent endpoints in DNS (SVCB records under _agents), signed with DNSSEC, so agents can find them before any HTTP request. It is an early IETF draft (book chapter 11).',
    fix: {
      snippet: '_index._agents.example.com. 3600 IN SVCB 1 agents.example.com. alpn="h2" port=443',
      prompt: 'Publish ServiceMode SVCB records such as _index._agents.<domain> (or _mcp._agents / _a2a._agents) pointing at your agent endpoints, and sign the zone with DNSSEC. Verify with: curl -s -H "accept: application/dns-json" "https://cloudflare-dns.com/dns-query?name=_index._agents.<domain>&type=SVCB"',
    },
    async run(ctx) {
      const host = ctx.host;
      if (host === 'localhost' || /^[\d.]+$/.test(host) || host.includes(':')) return neutral('DNS-AID needs a public hostname.', { compat: { status: 'unableToCheck', message: 'DNS-AID needs a public hostname' } });
      const queries = [];
      for (const type of ['SVCB', 'HTTPS']) for (const name of [`_index._agents.${host}`, `_a2a._agents.${host}`, `_mcp._agents.${host}`]) queries.push({ name, type });
      const res = await Promise.all(queries.map(async (q) => {
        const ex = await ctx.fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(q.name)}&type=${q.type}`, { headers: { accept: 'application/dns-json' }, accept: 'application/dns-json', purpose: 'dns-aid (DNS over HTTPS)' });
        let j = null; try { j = JSON.parse(ex.text); } catch { /* not JSON */ }
        const service = (j?.Answer || []).filter((a) => (a.type === 64 || a.type === 65) && !/^0\s/.test(String(a.data)));
        return { ...q, ex, ok: ex.ok && !!j, ad: !!j?.AD, service };
      }));
      const evidence = res.map((r) => r.ex);
      // A wildcard (*.example.com) answers every name, _agents labels included. Ask for a random sibling label:
      // if it gets the same records, the "_agents" answers come from the wildcard, not from DNS-AID.
      if (res.some((r) => r.service.length)) {
        const probe = `_zz${Math.random().toString(36).slice(2, 8)}._agents.${host}`;
        const pex = await ctx.fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(probe)}&type=HTTPS`, { headers: { accept: 'application/dns-json' }, accept: 'application/dns-json', purpose: 'dns-aid wildcard probe' });
        let pj = null; try { pj = JSON.parse(pex.text); } catch { /* not JSON */ }
        const wild = (pj?.Answer || []).some((a) => a.type === 64 || a.type === 65);
        if (wild) {
          const details = { wildcard: true, probe, lookups: res.map((r) => ({ name: r.name, type: r.type, records: r.service.length, ad: r.ad })) };
          return fail(`No DNS-AID records: the answers under _agents.${host} come from a wildcard (a random name, ${probe}, gets the same records).`, { evidence: [...evidence, pex], details, compat: { status: 'fail', message: 'no DNSSEC-validated SVCB/HTTPS records under _agents (wildcard only)' } });
        }
      }
      if (res.every((r) => !r.ok)) return error('DNS-over-HTTPS lookups failed, so DNS-AID could not be checked.', { evidence, compat: { status: 'unableToCheck', message: 'DoH lookup failed' } });
      const signed = res.find((r) => r.ad && r.service.length);
      const details = { lookups: res.map((r) => ({ name: r.name, type: r.type, records: r.service.length, ad: r.ad })) };
      if (signed) return pass(`DNSSEC-validated ${signed.type} record(s) found at ${signed.name}.`, { evidence: [signed.ex], details, compat: { status: 'pass', message: `DNSSEC-validated ${signed.type} at ${signed.name}` } });
      const unsigned = res.find((r) => r.service.length);
      if (unsigned) return warn(`${unsigned.type} record(s) exist at ${unsigned.name} but are not DNSSEC-validated (no AD flag), so they do not count.`, { evidence: [unsigned.ex], details, compat: { status: 'fail', message: 'records not DNSSEC-validated' } });
      return fail(`No ServiceMode SVCB/HTTPS records under _agents.${host}.`, { evidence, details, compat: { status: 'fail', message: 'no DNSSEC-validated SVCB/HTTPS records under _agents' } });
    },
  },

  'discovery.poppy': {
    why: 'The Personal Agent Protocol (draft 0.1) lets a site declare which personal agents may act for its users. It is a single early proposal; isitagentready shows it as informational (book chapter 11).',
    fix: {
      snippet: '{ "organization": "Example", "domain": "example.com", "interfaces": { "web": {} } }',
      prompt: 'Only if you adopt the Personal Agent Protocol: serve /.well-known/poppy.json with organization, domain and interfaces (web: {} for website-only); when you declare auth, make the RFC 8414 issuer match and list the domain in poppy_domains.',
    },
    async run(ctx) {
      const r = await wk(ctx, '/.well-known/poppy.json', 'personal agent protocol');
      const j = r.json;
      if (!j) return fail('No /.well-known/poppy.json (informational).', { evidence: [r.ex], compat: { status: 'fail', message: 'no poppy.json' } });
      const hasOrg = !!(j.organization || j.domain);
      const ifaces = j.interfaces && typeof j.interfaces === 'object' ? Object.keys(j.interfaces) : [];
      const problems = [];
      if (!hasOrg) problems.push('no organization/domain');
      if (!ifaces.length) problems.push('no interfaces');
      const declaresAuth = !!(j.auth || j.oauth || ifaces.some((k) => j.interfaces[k]?.auth));
      const evidence = [r.ex];
      if (declaresAuth) {
        const auth = await authSignals(ctx);
        const as = auth.as?.json;
        evidence.push(auth.as?.ex || auth.oauth.ex);
        if (!as?.issuer) problems.push('auth is declared but no RFC 8414 metadata was found');
        else if (!(as.poppy_domains || []).includes(ctx.host)) problems.push(`the authorization server metadata does not list ${ctx.host} in poppy_domains`);
      }
      const ok = !problems.length;
      const compat = { status: ok ? 'pass' : 'fail', message: ok ? 'poppy.json found' : problems.join('; ') };
      if (ok) return pass(`poppy.json declares ${j.organization || j.domain} with interfaces ${ifaces.join(', ')} (informational).`, { evidence, compat, details: { interfaces: ifaces, declaresAuth } });
      return fail(`poppy.json is incomplete: ${problems.join('; ')} (informational).`, { evidence, compat, details: { interfaces: ifaces, declaresAuth } });
    },
  },

  'discovery.soft-404': {
    why: 'Agents probe well-known paths to find capabilities. If unknown paths answer 200 with an HTML page, every probe looks like a hit, agents waste requests and some will parse your homepage as a manifest. RFC 8615 reserves /.well-known/ for real resources (book chapter 11).',
    fix: {
      snippet: '# nginx\nlocation /.well-known/ { try_files $uri =404; }\nerror_page 404 /404.html;',
      prompt: 'Make unknown paths, especially under /.well-known/, answer HTTP 404 (not 200 with the app shell or a redirect to the homepage). For single-page apps, restrict the HTML fallback to real routes.',
    },
    async run(ctx) {
      const s = await ctx.soft404();
      const ps = s.page.status; const ws = s.wellKnown.status;
      const details = { page: { url: s.page.url, status: ps, redirects: s.page.redirects.length }, wellKnown: { url: s.wellKnown.url, status: ws, redirects: s.wellKnown.redirects.length } };
      if (s.page.error && s.wellKnown.error) return error(`The soft-404 probes failed: ${s.page.error}.`, { evidence: [s.page, s.wellKnown], details });
      if (ws === 200) return fail(`A random /.well-known/ path answers HTTP 200${s.wellKnown.redirects.length ? ' after a redirect' : ''} (${s.wellKnown.contentType || 'no content type'}), so every well-known probe looks like a hit.`, { evidence: [s.page, s.wellKnown], details });
      if (ps === 200) return warn(`Unknown pages answer HTTP 200${s.page.redirects.length ? ' after a redirect' : ''} (a soft-404), though /.well-known/ answers ${ws}.`, { evidence: [s.page, s.wellKnown], details });
      if ([404, 410].includes(ps) && [404, 410].includes(ws)) return pass(`Unknown paths answer HTTP ${ps} and unknown well-known paths HTTP ${ws}.`, { evidence: [s.page, s.wellKnown], details });
      return warn(`Unknown paths answer HTTP ${ps} and ${ws} instead of 404, which agents may read as "blocked" rather than "absent".`, { evidence: [s.page, s.wellKnown], details });
    },
  },

  'discovery.wellknown-types': {
    why: 'Agents decide how to parse a file from its Content-Type. A well-known JSON file served as text/html or text/plain may be skipped or misread (book chapter 11).',
    fix: {
      snippet: '# Cloudflare _headers / Netlify\n/.well-known/*.json\n  Content-Type: application/json\n/.well-known/api-catalog\n  Content-Type: application/linkset+json',
      prompt: 'Serve every JSON file under /.well-known/ with a JSON media type (application/json, or the specific +json type such as application/linkset+json for the API catalog) and make sure each one parses as JSON.',
    },
    async run(ctx) {
      const [api, mcp, auth, skills, ard] = await Promise.all([apiSignals(ctx), mcpSignals(ctx), authSignals(ctx), skillsIndex(ctx), ardManifest(ctx)]);
      const extra = await Promise.all(['/.well-known/agent-card.json', '/.well-known/ucp', '/.well-known/acp.json', '/.well-known/gpc.json', '/.well-known/http-message-signatures-directory'].map((p) => wk(ctx, p)));
      const exs = [api.catalog.ex, ...mcp.cards.map((c) => c.ex), auth.prm.ex, auth.oauth.ex, auth.oidc.ex, ...(skills.found ? [skills.ex] : skills.tried), ...(ard.found ? [ard.ex] : []), ...extra.map((e) => e.ex)];
      const found = [...new Map(exs.filter((e) => e && e.ok && new URL(e.finalUrl || e.url).pathname.startsWith('/.well-known/')).map((e) => [e.url, e])).values()];
      const real = found.filter((e) => !/^\s*<(!doctype|html)/i.test(e.text));
      if (!real.length) return neutral('No well-known JSON files were found to check.');
      const wrongType = []; const broken = [];
      for (const e of real) {
        const path = new URL(e.url).pathname;
        let parses = true; try { JSON.parse(e.text); } catch { parses = false; }
        if (!parses) broken.push(path);
        else if (!/(^application\/json|\+json)\b/i.test(e.contentType)) wrongType.push(`${path} (${e.contentType || 'none'})`);
      }
      const details = { checked: real.map((e) => new URL(e.url).pathname), wrongType, broken };
      if (broken.length) return fail(`${broken.length} well-known file(s) answer 200 but are not valid JSON: ${broken.join(', ')}.`, { evidence: real, details });
      if (wrongType.length) return warn(`${wrongType.length} of ${real.length} well-known JSON file(s) have a non-JSON Content-Type: ${wrongType.slice(0, 4).join(', ')}.`, { evidence: real, details });
      return pass(`All ${real.length} well-known JSON file(s) found are served with a JSON media type and parse.`, { evidence: real, details });
    },
  },
};
