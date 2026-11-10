import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Docker image (docs/self-hosting.md) runs the traced standalone server.
  output: process.env.OPENRCS_STANDALONE === "1" ? "standalone" : undefined,
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
