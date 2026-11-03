import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockSite, html, json, text, status } from '../helpers/mock-site.mjs';
import { asMetadataUrls } from '../../src/checks/identity.mjs';

// Metadata adapted from agent-ready-web-demos (MIT), nordlys-cabins/layers/14-oauth and 15-bot-identity.
const O = 'https://example.com';
const asMeta = { issuer: O, authorization_endpoint: `${O}/oauth/authorize`, token_endpoint: `${O}/oauth/token`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], client_id_metadata_document_supported: true };
const prm = { resource: `${O}/mcp`, authorization_servers: [O], scopes_supported: ['bookings:read'], bearer_methods_supported: ['header'] };
const card = { name: 'com.example/booking', version: '1.0.0', remotes: [{ type: 'streamable-http', url: `${O}/mcp` }] };
const good = () => ({
  '/': html('<h1>x</h1>'),
  '/.well-known/oauth-authorization-server': json(asMeta),
  '/.well-known/oauth-protected-resource': json(prm),
  '/.well-known/oauth-protected-resource/mcp': json(prm),
  '/.well-known/mcp/server-card.json': json(card),
  '/mcp': status(401, { 'www-authenticate': `Bearer resource_metadata="${O}/.well-known/oauth-protected-resource/mcp"` }),
});

test('RFC 8414 well-known URL insertion', () => {
  assert.deepEqual(asMetadataUrls('https://auth.example.com/tenant1'), ['https://auth.example.com/.well-known/oauth-authorization-server/tenant1', 'https://auth.example.com/tenant1/.well-known/openid-configuration']);
});

test('identity.oauth-discovery: Nordlys metadata passes; missing fails; issuer mismatch warns', async () => {
  const r = await mockSite(good()).run('identity.oauth-discovery');
  assert.equal(r.status, 'pass'); assert.equal(r.compat.status, 'pass');
  const f = await mockSite({ '/': html('x') }).run('identity.oauth-discovery');
  assert.equal(f.status, 'fail'); assert.equal(f.compat.status, 'fail');
  const g = good(); g['/.well-known/oauth-authorization-server'] = json({ ...asMeta, issuer: 'https://other.example' });
  assert.equal((await mockSite(g).run('identity.oauth-discovery')).status, 'warn');
});

test('identity.protected-resource finds root and path-suffixed PRM', async () => {
  const r = await mockSite(good()).run('identity.protected-resource');
  assert.equal(r.status, 'pass'); assert.equal(r.compat.status, 'pass'); assert.equal(r.details.documents.length, 2);
  const only = good(); delete only['/.well-known/oauth-protected-resource'];
  const w = await mockSite(only).run('identity.protected-resource');
  assert.equal(w.status, 'warn'); assert.equal(w.compat.status, 'fail');
  assert.equal((await mockSite({ '/.well-known/oauth-protected-resource': json({ resource: O }) }).run('identity.protected-resource')).status, 'fail');
});

test('identity.pkce-s256 reads remote AS metadata named by PRM', async () => {
  assert.equal((await mockSite(good()).run('identity.pkce-s256')).status, 'pass');
  const remote = { '/.well-known/oauth-protected-resource': json({ resource: O, authorization_servers: ['https://auth.example.net'] }), 'https://auth.example.net/.well-known/oauth-authorization-server': json({ issuer: 'https://auth.example.net', code_challenge_methods_supported: ['plain'] }) };
  const r = await mockSite(remote).run('identity.pkce-s256');
  assert.equal(r.status, 'fail'); assert.match(r.message, /auth\.example\.net/);
});

test('identity.client-registration: CIMD passes, DCR-only warns, none fails', async () => {
  assert.equal((await mockSite(good()).run('identity.client-registration')).status, 'pass');
  const d = good(); d['/.well-known/oauth-authorization-server'] = json({ ...asMeta, client_id_metadata_document_supported: undefined, registration_endpoint: `${O}/register` });
  assert.equal((await mockSite(d).run('identity.client-registration')).status, 'warn');
  const n = good(); n['/.well-known/oauth-authorization-server'] = json({ ...asMeta, client_id_metadata_document_supported: false });
  assert.equal((await mockSite(n).run('identity.client-registration')).status, 'fail');
});

test('identity.auth-md needs auth.md, PRM and agent_auth', async () => {
  const g = good(); g['/auth.md'] = text('# Agents\n', { 'content-type': 'text/markdown' }); g['/.well-known/oauth-authorization-server'] = json({ ...asMeta, agent_auth: { register_uri: `${O}/agents/register` } });
  const r = await mockSite(g).run('identity.auth-md');
  assert.equal(r.status, 'pass'); assert.equal(r.compat.status, 'pass');
  const f = await mockSite(good()).run('identity.auth-md');
  assert.equal(f.status, 'fail'); assert.ok(f.details.missing.includes('/auth.md'));
});

test('identity.web-bot-auth: Ed25519 JWKS with the right type passes; wrong type warns; none fails', async () => {
  const dir = { keys: [{ kty: 'OKP', crv: 'Ed25519', x: 'JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs' }] };
  const T = 'application/http-message-signatures-directory+json';
  assert.equal((await mockSite({ '/.well-known/http-message-signatures-directory': json(dir, { 'content-type': T }) }).run('identity.web-bot-auth')).status, 'pass');
  assert.equal((await mockSite({ '/.well-known/http-message-signatures-directory': json(dir) }).run('identity.web-bot-auth')).status, 'warn');
  assert.equal((await mockSite({}).run('identity.web-bot-auth')).compat.status, 'fail');
});
