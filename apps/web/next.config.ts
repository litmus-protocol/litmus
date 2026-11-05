import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@defect/shared"],
  reactStrictMode: true,
};

export default nextConfig;
