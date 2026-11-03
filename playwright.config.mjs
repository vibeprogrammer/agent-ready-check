// Playwright config: e2e specs in test/e2e (each spec starts the servers it needs on free ports and stops them).
// Chromium runs with WebMCPTesting so document.modelContext exists. Locally, CHROMIUM_PATH points at an existing
// Chromium; in CI `npx playwright install --with-deps chromium` provides it.
import { defineConfig, devices } from '@playwright/test';

const executablePath = process.env.CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: 'test/e2e',
  testMatch: /.*\.spec\.mjs$/,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  outputDir: 'test-results',
  use: {
    ...devices['Desktop Chrome'],
    headless: true,
    trace: 'retain-on-failure',
    launchOptions: { executablePath, args: ['--enable-features=WebMCPTesting', '--no-sandbox'] },
  },
  projects: [{ name: 'chromium' }],
});
