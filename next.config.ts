import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // PGlite ships a WASM bundle. Keep it external to the server bundle so the
  // .wasm/.data files resolve from node_modules at runtime instead of being
  // inlined by the bundler.
  serverExternalPackages: ['@electric-sql/pglite'],
  // The migrator reads the .sql files from disk at runtime. Nothing imports
  // them, so tracing cannot infer the dependency and a deployed function would
  // come up with an empty database — which looks like a data problem and is
  // actually a packaging one.
  outputFileTracingIncludes: {
    '/**': ['./lib/db/migrations/**/*.sql', './lib/db/migrations/meta/_journal.json'],
  },
  typedRoutes: false,
  experimental: {
    // Server Actions carry the forecast lock and ingestion-confirm flows.
    serverActions: { bodySizeLimit: '8mb' },
  },
};

export default nextConfig;
