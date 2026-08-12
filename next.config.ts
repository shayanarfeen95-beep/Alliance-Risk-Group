import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // PGlite ships a WASM bundle. Keep it external to the server bundle so the
  // .wasm/.data files resolve from node_modules at runtime instead of being
  // inlined by the bundler.
  serverExternalPackages: ['@electric-sql/pglite'],
  typedRoutes: false,
  experimental: {
    // Server Actions carry the forecast lock and ingestion-confirm flows.
    serverActions: { bodySizeLimit: '8mb' },
  },
};

export default nextConfig;
