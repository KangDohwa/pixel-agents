import { defineConfig } from '@playwright/test';

// Provider browser coverage needs the built standalone server, not an Electron
// download. Every host launched by the fixture has its own HOME and CLI homes.
export default defineConfig({
  testDir: './tests/standalone',
  testMatch: 'providers.spec.ts',
  timeout: 30_000,
  workers: 1,
  retries: 0,
  outputDir: '../test-results/providers',
  reporter: 'list',
  use: { headless: true },
});
