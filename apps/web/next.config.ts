import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  transpilePackages: ["@wallop/db", "@wallop/core"],
};

export default nextConfig;
