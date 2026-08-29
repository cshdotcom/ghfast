import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* Docker Registry API 要求 /v2/(带尾斜杠)直达路由,禁用 308 规范化重定向 */
  skipTrailingSlashRedirect: true,
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
