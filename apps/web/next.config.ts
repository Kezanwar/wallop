import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  transpilePackages: ["@studia-nova/db", "@studia-nova/core"],
};

export default nextConfig;
