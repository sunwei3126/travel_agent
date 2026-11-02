import type { NextConfig } from "next";

const apiUrl = process.env.API_URL ?? "http://127.0.0.1:4000";

const nextConfig: NextConfig = {
  // The CopilotKit runtime streams SSE through the /backend rewrite; gzip
  // buffering would hold the whole run until it ends.
  compress: false,
  transpilePackages: ["@pi-demo/shared"],
  async rewrites() {
    return [{ source: "/backend/:path*", destination: `${apiUrl}/:path*` }];
  },
};

export default nextConfig;
