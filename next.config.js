/** @type {import('next').NextConfig} */
const { PHASE_DEVELOPMENT_SERVER } = require('next/constants')

const nextConfig = {
  reactStrictMode: true,
  // Keep routes warm during cross-page workflows and local integration tests.
  onDemandEntries: { maxInactiveAge: 10 * 60 * 1000, pagesBufferLength: 100 },
  outputFileTracingRoot: __dirname,
  // `src/lib/atproto/validate.ts` reads `lexicons/` from process.cwd() at runtime;
  // the tracer cannot see a directory read, so ship it with every function.
  outputFileTracingIncludes: { '/**': ['./lexicons/**/*'] },
}

// Keep production checks from replacing the running development server's chunks.
module.exports = (phase) => ({
  ...nextConfig,
  distDir: phase === PHASE_DEVELOPMENT_SERVER ? '.next-dev' : '.next',
})
