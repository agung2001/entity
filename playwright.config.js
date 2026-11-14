import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

/**
 * Chat UAT — Playwright.
 *
 * The suite runs the renderer against the Vite dev server with a throwaway
 * ENTITY_HOME. `tests/support/e2e-server.mjs` seeds that profile and starts the
 * server; no real account, workspace, SSH config or MCP secret is involved.
 *
 *   npm run test:smoke       the release-blocking subset (real opencode + pi)
 *   npm run test:regression  the deterministic full coverage
 *   npm run test:e2e         both, in directory order
 *   npm run test:unit        the migrated node:test unit suite
 */
const HERE = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.E2E_PORT || 5199)
const BASE = `http://127.0.0.1:${PORT}`
const ENTITY_HOME = path.join(HERE, '.tmp', 'e2e-profile')

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [
    ['list'],
    ['html', { outputFolder: path.join(HERE, '.tmp', 'playwright-report'), open: 'never' }],
  ],
  outputDir: path.join(HERE, '.tmp', 'test-results'),
  use: {
    baseURL: BASE,
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: 'node tests/support/e2e-server.mjs',
    url: BASE,
    timeout: 120_000,
    reuseExistingServer: process.env.E2E_REUSE === '1',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      ENTITY_HOME,
      E2E_PORT: String(PORT),
    },
  },
})
