import { defineConfig } from '@playwright/test'

// Test env vars: set TEST_SUPABASE_ANON_KEY and TEST_SUPABASE_SERVICE_KEY
// from `supabase status` output before running tests.

export default defineConfig({
  testDir: './tests',
  timeout: 60000,
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
