import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ['10.0.0.85'],
  transpilePackages: ['@ivoryos/shared-ui'],
};

export default nextConfig;
