import { defineConfig } from '@playwright/test'

// Test env vars: set TEST_SUPABASE_ANON_KEY and TEST_SUPABASE_SERVICE_KEY
// from `supabase status` output before running tests.

export default defineConfig({
  testDir: './tests',
  // Generous: against `next dev` a test's first request to each route waits for it to compile,
  // and a full run (`--retries=0`) hits dozens of routes cold.
  timeout: 180000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  // One retry absorbs the dev server compiling a route on its first request.
  retries: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3001',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
})
