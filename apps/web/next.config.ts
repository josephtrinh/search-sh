import type { NextConfig } from "next";
const apiOrigin = `http://127.0.0.1:${process.env.API_PORT ?? "8000"}`;
const allowedDevOrigins = (process.env.WEB_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const nextConfig: NextConfig = {
  allowedDevOrigins,
  transpilePackages: ["@samplehub/contracts"],
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${apiOrigin}/v1/:path*` },
      { source: "/api-docs", destination: `${apiOrigin}/docs` },
      { source: "/api-docs/:path*", destination: `${apiOrigin}/docs/:path*` },
    ];
  },
};
export default nextConfig;
