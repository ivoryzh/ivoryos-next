import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'export',
  trailingSlash: true,
  transpilePackages: ['@ivoryos/shared-ui'],
};

export default nextConfig;
