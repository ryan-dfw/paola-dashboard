import { defineConfig, devices } from '@playwright/test';

const PORT = 5180;

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  globalSetup: './tests/e2e/global-setup.ts',
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  },
  webServer: [
    {
      command: 'npx firebase emulators:start --only auth --project demo-paola',
      url: 'http://127.0.0.1:9099',
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: 'npx tsx tests/e2e/server.ts',
      url: `http://localhost:${PORT}/`,
      reuseExistingServer: true,
      timeout: 60_000,
      env: { PORT: String(PORT), FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' },
    },
  ],
  projects: [
    { name: 'iphone', use: { ...devices['iPhone 15'], browserName: 'chromium' } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
});
