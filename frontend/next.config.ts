import type { NextConfig } from "next";

// The tour: this same UI, built to run in a plain browser on the Hub website against a simulated
// lab (src/tour/). `npm run build:tour` (or IVORYOS_TOUR=1) serves it under /tour/app and exports
// to out-tour/, so the desktop app's out/ is never overwritten by it. The script is detected by
// name rather than an env prefix, which Windows shells do not understand.
const TOUR = process.env.IVORYOS_TOUR === "1" || process.env.npm_lifecycle_event === "build:tour";
const TOUR_BASE = '/tour/app';

const nextConfig: NextConfig = {
  output: 'export',
  trailingSlash: true,
  transpilePackages: ['@ivoryos/shared-ui'],
  // Defined in every build, so the bundler sees `process.env.NEXT_PUBLIC_IVORYOS_TOUR === '1'` as a
  // constant and leaves the tour (src/instrumentation-client.ts) out of every other build.
  env: { NEXT_PUBLIC_IVORYOS_TOUR: TOUR ? '1' : '0', NEXT_PUBLIC_BASE_PATH: TOUR ? TOUR_BASE : '' },
  ...(TOUR ? { basePath: TOUR_BASE, distDir: 'out-tour' } : {}),
};

export default nextConfig;
