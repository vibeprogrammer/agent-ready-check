// E2E (H4): the real Node server on a free port: agent files, API, a real self-scan, compression and the HTML report.
import { test, expect } from '@playwright/test';
import { startServer } from './api-server.helper.mjs';

let srv;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => { srv = await startServer(); });
test.afterAll(() => srv?.stop());

test('home page: Link headers, Markdown negotiation and gzip', async ({ request }) => {
  const r = await request.get(`${srv.base}/`, { headers: { accept: 'text/html', 'accept-encoding': 'gzip' } });
  expect(r.status()).toBe(200);
  expect(r.headers()['link']).toContain('rel="api-catalog"');
  expect(r.headers()['content-encoding']).toBe('gzip');
  const md = await request.get(`${srv.base}/`, { headers: { accept: 'text/markdown' } });
  expect(md.headers()['content-type']).toContain('text/markdown');
  expect(md.headers()['vary']).toContain('Accept');
});

test('agent files answer with the right types', async ({ request }) => {
  for (const [path, type] of [['/robots.txt', 'text/plain'], ['/llms.txt', 'text/plain'], ['/sitemap.xml', 'application/xml'], ['/openapi.json', 'application/openapi+json'], ['/.well-known/api-catalog', 'application/linkset+json'], ['/.well-known/mcp/server-card.json', 'application/json'], ['/.well-known/agent-skills/index.json', 'application/json'], ['/.well-known/ard.json', 'application/json']]) {
    const r = await request.get(`${srv.base}${path}`);
    expect(r.status(), path).toBe(200);
    expect(r.headers()['content-type'], path).toContain(type);
  }
});

test('a real scan of the service itself through POST /api/scan', async ({ request }) => {
  test.setTimeout(120_000);
  const r = await request.post(`${srv.base}/api/scan`, { data: { url: `${srv.base}/` }, timeout: 110_000 });
  expect(r.status()).toBe(200);
  const report = await r.json();
  expect(report.id).toMatch(/^[a-z0-9]{12}$/);
  expect(report.checks.length).toBeGreaterThan(100);
  const level = report.compat.isitagentready.level;
  // The service publishes everything Level 4 needs (Level 5 needs Web Bot Auth or OAuth metadata).
  test.info().annotations.push({ type: 'self-scan', description: `score ${report.score}, isitagentready-compatible level ${level}` });
  expect(level).toBeGreaterThanOrEqual(4);
  const md = await request.get(`${srv.base}/r/${report.id}`, { headers: { accept: 'text/markdown' } });
  expect(md.headers()['content-type']).toContain('text/markdown');
  const badge = await request.get(`${srv.base}/badge/127.0.0.1:${srv.port}.svg`);
  expect(await badge.text()).toContain(String(report.score));
});

test('the HTML report page renders in Chromium', async ({ page }) => {
  await page.goto(`${srv.base}/scan?url=${encodeURIComponent(`${srv.base}/docs`)}`, { timeout: 110_000 });
  await expect(page.locator('main h1')).toBeVisible();
  await expect(page).toHaveTitle(/Agent-Ready Check/);
});

test('errors are problem+json', async ({ request }) => {
  const r = await request.post(`${srv.base}/api/scan`, { data: {} });
  expect(r.status()).toBe(400);
  expect(r.headers()['content-type']).toContain('application/problem+json');
});
