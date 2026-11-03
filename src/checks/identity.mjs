// Checks for the identity layer (OAuth for agents, bot identity). Ids and metadata: src/catalog.json. Owner: H2.
import { pass, warn, fail, neutral } from '../core/result.mjs';
import { authSignals, mcpSignals } from '../core/discover.mjs';
import { wk } from './discovery.mjs';

const WBA_PATH = '/.well-known/http-message-signatures-directory';
const WBA_TYPE = 'application/http-message-signatures-directory+json';

/** RFC 8414 section 3.1: insert the well-known segment between host and issuer path. */
export function asMetadataUrls(issuer) {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/$/, '');
  return [`${u.origin}/.well-known/oauth-authorization-server${path}`, `${u.origin}${path}/.well-known/openid-configuration`];
}

/** Every PRM document we can find: root, path-suffixed for the MCP endpoint (RFC 9728 section 3.1), and the 401 challenge's resource_metadata. */
export function prmDocs(ctx) {
  return ctx.memo('identity:prm', async () => {
    const auth = await authSignals(ctx);
    const mcp = await mcpSignals(ctx);
    const docs = [{ source: '/.well-known/oauth-protected-resource', ...auth.prm }];
    const urls = new Set([auth.prm.ex.url]);
    const fromChallenge = /resource_metadata\s*=\s*"?([^",\s]+)"?/i.exec(auth.mcpChallenge || '')?.[1];
    const suffixed = mcp.hasMcp && mcp.endpoint && new URL(mcp.endpoint).origin === ctx.origin && new URL(mcp.endpoint).pathname !== '/' ? ctx.abs(`/.well-known/oauth-protected-resource${new URL(mcp.endpoint).pathname.replace(/\/$/, '')}`) : null;
    for (const [source, url] of [['MCP 401 resource_metadata', fromChallenge], ['path-suffixed for the MCP endpoint', suffixed]]) {
      if (!url) continue;
      let abs; try { abs = new URL(url, ctx.origin).href; } catch { continue; }
      if (urls.has(abs)) continue; urls.add(abs);
      docs.push({ source, ...(await wk(ctx, abs, 'oauth protected resource')) });
    }
    return docs;
  });
}

/** Authorization server metadata: local, else from the PRM's first authorization server (up to 2 requests there). */
export function asMetadata(ctx) {
  return ctx.memo('identity:as', async () => {
    const auth = await authSignals(ctx);
    if (auth.as?.json) return { json: auth.as.json, ex: auth.as.ex, url: auth.as.ex.url, source: auth.as.path, remote: false };
    const prm = (await prmDocs(ctx)).find((d) => Array.isArray(d.json?.authorization_servers) && d.json.authorization_servers.length);
    if (!prm) return null;
    const issuer = prm.json.authorization_servers[0];
    let urls; try { urls = asMetadataUrls(issuer); } catch { return null; }
    const tried = [];
    for (const url of urls) {
      const r = await wk(ctx, url, 'authorization server metadata (from PRM)');
      tried.push(r.ex);
      if (r.json?.issuer) return { json: r.json, ex: r.ex, url, source: `authorization server ${issuer} (named in PRM)`, remote: new URL(url).origin !== ctx.origin, tried };
    }
    return { json: null, ex: tried[tried.length - 1], url: urls[0], source: `authorization server ${issuer} (named in PRM)`, remote: true, tried, issuer };
  });
}

export default {
  'identity.oauth-discovery': {
    why: 'Agents that act for a signed-in person need to find your authorization server automatically. RFC 8414 / OpenID Connect discovery metadata is where they look (book chapter 14).',
    fix: {
      snippet: '{\n  "issuer": "https://example.com",\n  "authorization_endpoint": "https://example.com/oauth/authorize",\n  "token_endpoint": "https://example.com/oauth/token",\n  "response_types_supported": ["code"],\n  "grant_types_supported": ["authorization_code", "refresh_token"],\n  "code_challenge_methods_supported": ["S256"]\n}',
      prompt: 'Serve RFC 8414 authorization server metadata at /.well-known/oauth-authorization-server with issuer (exactly the origin it is served from), authorization_endpoint, token_endpoint, response_types_supported, grant_types_supported and code_challenge_methods_supported ["S256"].',
    },
    async run(ctx) {
      const auth = await authSignals(ctx);
      const as = auth.as;
      const compat = as?.json?.issuer ? { status: 'pass', message: `OAuth metadata, issuer ${as.json.issuer}` } : { status: 'fail', message: 'no OAuth/OIDC discovery metadata' };
      if (!as?.json) {
        const remote = await asMetadata(ctx);
        if (remote?.json) return pass(`No local metadata, but the protected resource names ${remote.source} with valid metadata (issuer ${remote.json.issuer}).`, { evidence: [auth.oauth.ex, auth.oidc.ex, remote.ex], compat, details: { issuer: remote.json.issuer, remote: true } });
        return fail('No OAuth or OpenID Connect discovery metadata at /.well-known/oauth-authorization-server or /.well-known/openid-configuration.', { evidence: [auth.oauth.ex, auth.oidc.ex], compat });
      }
      const j = as.json; const problems = [];
      for (const k of ['authorization_endpoint', 'token_endpoint', 'response_types_supported']) if (!j[k]) problems.push(`no ${k}`);
      if (!j.grant_types_supported) problems.push('no grant_types_supported (RFC 8414 default is authorization_code and implicit)');
      let issuerOk = true; try { issuerOk = new URL(j.issuer).origin === new URL(as.ex.finalUrl || as.ex.url).origin; } catch { issuerOk = false; }
      if (!issuerOk) problems.push(`issuer ${j.issuer} does not match the origin serving the metadata`);
      const details = { path: as.path, issuer: j.issuer, problems };
      if (!j.authorization_endpoint && !j.token_endpoint) return fail(`Metadata at ${as.path} has no endpoints.`, { evidence: [as.ex], compat, details });
      if (problems.length) return warn(`Authorization server metadata at ${as.path} (issuer ${j.issuer}) has gaps: ${problems.join('; ')}.`, { evidence: [as.ex], compat, details });
      return pass(`Authorization server metadata at ${as.path} names issuer ${j.issuer} and its endpoints.`, { evidence: [as.ex], compat, details });
    },
  },

  'identity.protected-resource': {
    why: 'Protected Resource Metadata (RFC 9728) tells an agent which authorization server issues tokens for your API or MCP server, so it can start OAuth without being configured by hand (book chapter 14).',
    fix: {
      snippet: '{\n  "resource": "https://example.com/mcp",\n  "authorization_servers": ["https://example.com"],\n  "scopes_supported": ["bookings:read", "bookings:write"],\n  "bearer_methods_supported": ["header"]\n}',
      prompt: 'Serve RFC 9728 Protected Resource Metadata at /.well-known/oauth-protected-resource and, for an MCP endpoint at /mcp, at /.well-known/oauth-protected-resource/mcp, with resource (the exact resource URL), authorization_servers and scopes_supported. Reference it from the 401 WWW-Authenticate header as resource_metadata.',
    },
    async run(ctx) {
      const docs = await prmDocs(ctx);
      const root = docs[0];
      const compatOk = !!(root.json?.resource && Array.isArray(root.json?.authorization_servers));
      const compat = { status: compatOk ? 'pass' : 'fail', message: compatOk ? `protected resource ${root.json.resource}` : 'no OAuth Protected Resource Metadata' };
      const good = docs.filter((d) => d.json?.resource && Array.isArray(d.json.authorization_servers) && d.json.authorization_servers.length);
      const evidence = docs.map((d) => d.ex);
      if (!good.length) {
        const partial = docs.find((d) => d.json);
        if (partial) return fail(`Protected Resource Metadata at ${new URL(partial.ex.url).pathname} lacks ${partial.json.resource ? 'authorization_servers' : 'resource'}.`, { evidence, compat });
        return fail(`No Protected Resource Metadata found (tried ${docs.map((d) => new URL(d.ex.url).pathname).join(', ')}).`, { evidence, compat });
      }
      const notes = [];
      for (const d of good) {
        const expected = d.source === '/.well-known/oauth-protected-resource' ? null : (await mcpSignals(ctx)).endpoint;
        if (expected && d.json.resource.replace(/\/$/, '') !== expected.replace(/\/$/, '')) notes.push(`${new URL(d.ex.url).pathname} says resource ${d.json.resource}, but the endpoint is ${expected} (RFC 9728 section 3.3 wants them identical)`);
      }
      if (!good.includes(root) && !root.json) notes.push('not served at the root /.well-known/oauth-protected-resource (isitagentready reads only that path)');
      const details = { documents: good.map((d) => ({ source: d.source, url: d.ex.url, resource: d.json.resource, authorization_servers: d.json.authorization_servers })), notes };
      if (notes.length) return warn(`Protected Resource Metadata found (${good.map((d) => d.source).join(', ')}), but: ${notes.join('; ')}.`, { evidence, compat, details });
      return pass(`Protected Resource Metadata for ${good[0].json.resource} names ${good[0].json.authorization_servers.join(', ')} (${good.map((d) => d.source).join(', ')}).`, { evidence, compat, details });
    },
  },

  'identity.pkce-s256': {
    why: 'Agents are public clients: PKCE with S256 is what stops a stolen authorization code from being used. OAuth 2.1 and the MCP authorization spec require it (book chapter 14).',
    fix: { snippet: '"code_challenge_methods_supported": ["S256"]', prompt: 'Enable PKCE with the S256 method on the authorization server (reject plain), and advertise it as code_challenge_methods_supported: ["S256"] in its metadata.' },
    async run(ctx) {
      const as = await asMetadata(ctx);
      if (!as?.json) return neutral(`No authorization server metadata to read${as?.issuer ? ` (tried ${as.issuer})` : ''}.`, { evidence: as?.tried || [] });
      const m = as.json.code_challenge_methods_supported;
      const details = { source: as.source, code_challenge_methods_supported: m ?? null };
      if (Array.isArray(m) && m.includes('S256')) return pass(`${as.source} supports PKCE S256${m.includes('plain') ? ' (it also accepts plain, which OAuth 2.1 discourages)' : ''}.`, { evidence: [as.ex], details });
      if (Array.isArray(m)) return fail(`${as.source} advertises PKCE methods ${m.join(', ')} but not S256.`, { evidence: [as.ex], details });
      return fail(`${as.source} does not advertise code_challenge_methods_supported, so MCP clients must refuse it (the MCP authorization spec requires S256).`, { evidence: [as.ex], details });
    },
  },

  'identity.client-registration': {
    why: 'An agent you have never met must be able to get a client id. MCP 2026-07-28 prefers Client ID Metadata Documents (the client id is a URL to its metadata) over Dynamic Client Registration (book chapter 14).',
    fix: { snippet: '"client_id_metadata_document_supported": true', prompt: 'Support OAuth Client ID Metadata Documents on the authorization server (accept an https URL as client_id and fetch its metadata) and advertise client_id_metadata_document_supported: true. Keep registration_endpoint only for older clients.' },
    async run(ctx) {
      const as = await asMetadata(ctx);
      if (!as?.json) return neutral('No authorization server metadata to read.', { evidence: as?.tried || [] });
      const cimd = as.json.client_id_metadata_document_supported === true; const dcr = !!as.json.registration_endpoint;
      const details = { client_id_metadata_document_supported: as.json.client_id_metadata_document_supported ?? null, registration_endpoint: as.json.registration_endpoint || null };
      if (cimd) return pass(`${as.source} accepts Client ID Metadata Documents${dcr ? ' (and keeps Dynamic Client Registration for older clients)' : ''}.`, { evidence: [as.ex], details });
      if (dcr) return warn(`${as.source} offers only Dynamic Client Registration; MCP 2026-07-28 prefers Client ID Metadata Documents.`, { evidence: [as.ex], details });
      return fail(`${as.source} offers no way for a new agent client to register (no CIMD support, no registration_endpoint).`, { evidence: [as.ex], details });
    },
  },

  'identity.auth-md': {
    why: 'auth.md (a WorkOS proposal) explains in plain language how agents authenticate and pairs it with an agent_auth block in the authorization server metadata. isitagentready counts it as a Level 5 auth option (book chapter 14).',
    fix: {
      snippet: '"agent_auth": { "register_uri": "https://example.com/agents/register", "identity_types": ["..."], "credential_types": ["..."] }',
      prompt: 'Serve /auth.md describing how agents register and authenticate, publish Protected Resource Metadata, and add an agent_auth block (register_uri, supported identity/assertion and credential types) to the authorization server metadata, following github.com/workos/auth.md.',
    },
    async run(ctx) {
      const md = await ctx.fetch('/auth.md', { accept: 'text/markdown, text/plain;q=0.9, */*;q=0.5', maxBytes: 262_144, purpose: 'auth.md' });
      const mdOk = md.ok && !/html/.test(md.contentType) && !/^\s*<(!doctype|html)/i.test(md.text);
      const prm = (await prmDocs(ctx)).find((d) => d.json?.resource);
      const as = await asMetadata(ctx);
      const agentAuth = as?.json?.agent_auth;
      const missing = [!mdOk && '/auth.md', !prm && 'Protected Resource Metadata', !agentAuth && 'agent_auth in authorization server metadata'].filter(Boolean);
      const compatOk = mdOk && !!(await authSignals(ctx)).prm.json?.resource && !!(await authSignals(ctx)).as?.json?.agent_auth;
      const compat = { status: compatOk ? 'pass' : 'fail', message: compatOk ? '/auth.md with agent_auth metadata' : 'no /auth.md setup' };
      const evidence = [md, prm?.ex, as?.ex];
      if (!missing.length) return pass('/auth.md, Protected Resource Metadata and an agent_auth block are all in place.', { evidence, compat, details: { agent_auth: Object.keys(agentAuth) } });
      return fail(`The auth.md setup is incomplete: missing ${missing.join(', ')}.`, { evidence, compat, details: { missing } });
    },
  },

  'identity.web-bot-auth': {
    why: 'If your site sends its own bots or agents to other sites, a Web Bot Auth key directory lets those sites verify your signed requests. Most sites only receive bots, so isitagentready treats it as informational (book chapter 15).',
    fix: {
      snippet: 'GET /.well-known/http-message-signatures-directory\nContent-Type: application/http-message-signatures-directory+json\n\n{ "keys": [{ "kty": "OKP", "crv": "Ed25519", "x": "<base64url public key>" }] }',
      prompt: 'Only if your service sends signed bot/agent requests: publish your Ed25519 public keys as a JWKS at /.well-known/http-message-signatures-directory with Content-Type application/http-message-signatures-directory+json, and sign the directory response itself (draft-ietf-webbotauth-httpsig-protocol).',
    },
    async run(ctx) {
      const r = await wk(ctx, WBA_PATH, 'web bot auth directory');
      const keys = Array.isArray(r.json?.keys) ? r.json.keys : null;
      const compat = { status: keys ? 'pass' : 'fail', message: keys ? 'key directory with a JWKS' : 'no key directory (informational)' };
      if (!keys) return fail(`No Web Bot Auth key directory at ${WBA_PATH} (only needed if you send bots).`, { evidence: [r.ex], compat });
      const ed = keys.filter((k) => k?.kty === 'OKP' && k?.crv === 'Ed25519' && typeof k.x === 'string');
      const notes = [];
      if (!ed.length) notes.push('no Ed25519 (OKP) key');
      if (!r.ex.contentType.startsWith(WBA_TYPE)) notes.push(`served as ${r.ex.contentType || 'no content type'}, not ${WBA_TYPE}`);
      const signed = !!r.ex.headers.signature;
      const details = { keys: keys.length, ed25519: ed.length, signed, notes };
      if (notes.length) return warn(`A key directory with ${keys.length} key(s) exists, but: ${notes.join('; ')}.`, { evidence: [r.ex], compat, details });
      return pass(`A Web Bot Auth directory publishes ${ed.length} Ed25519 key(s)${signed ? ' and is itself signed' : ' (the directory response itself is not signed; the draft recommends signing it)'}.`, { evidence: [r.ex], compat, details });
    },
  },
};
