// End-to-end tests in a real browser against a real, freshly seeded server.
// The server uses its own database and document folder (data/e2e*), never your dev data.
//   npx playwright install chromium   (first time only)
//   npm run test:e2e
const { defineConfig, devices } = require('@playwright/test');

const PORT = Number(process.env.E2E_PORT || 4100);

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1, // tests share one seeded database and run in order
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'coverage/e2e-results.json' }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node scripts/seed.js --reset && node src/server.js',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      NODE_ENV: 'development',
      PORT: String(PORT),
      DATABASE_PATH: 'data/e2e.db',
      DOCUMENT_STORAGE_PATH: 'data/e2e-documents',
      SESSION_SECRET: 'e2e-only-session-secret-0123456789abcdef',
      DISABLE_RATE_LIMIT: 'true',
    },
  },
});
