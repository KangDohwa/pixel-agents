import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/standalone',
  testMatch: 'appearance.spec.ts',
  timeout: 60_000,
  workers: 1,
  retries: 0,
  outputDir: '../test-results/appearance',
  reporter: 'list',
  use: { headless: true, viewport: { width: 1100, height: 1000 } },
});
