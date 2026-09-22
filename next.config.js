/** @type {import('next').NextConfig} */
const { PHASE_DEVELOPMENT_SERVER } = require('next/constants')

const nextConfig = {
  reactStrictMode: true,
  // Keep routes warm during cross-page workflows and local integration tests.
  onDemandEntries: { maxInactiveAge: 10 * 60 * 1000, pagesBufferLength: 100 },
  outputFileTracingRoot: __dirname,
  // Transformers.js pulls in onnxruntime-node (a native addon) and its .onnx/.wasm assets; the
  // bundler must leave both alone and require them from node_modules at runtime.
  serverExternalPackages: ['@huggingface/transformers', 'onnxruntime-node'],
  // `src/lib/atproto/validate.ts` reads `lexicons/` from process.cwd() at runtime;
  // the tracer cannot see a directory read, so ship it with every function.
  outputFileTracingIncludes: { '/**': ['./lexicons/**/*'] },
  // A path segment starting with a dot is not a route folder in the app router, so the MCP
  // server's RFC 9728 metadata is served from a normal route and rewritten into place.
  async rewrites() {
    return [{ source: '/.well-known/oauth-protected-resource', destination: '/api/mcp/oauth-protected-resource' }]
  },
}

// Keep production checks from replacing the running development server's chunks.
module.exports = (phase) => ({
  ...nextConfig,
  distDir: phase === PHASE_DEVELOPMENT_SERVER ? '.next-dev' : '.next',
})
