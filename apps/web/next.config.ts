import path from "node:path";
import type { NextConfig } from "next";

// NEXT_OUTPUT=export builds a fully static site (out/) for Cloudflare Pages. The app is client-side only
// (no route handlers, middleware or server data fetching), so nothing is lost.
const staticExport = process.env.NEXT_OUTPUT === "export";

const nextConfig: NextConfig = {
  transpilePackages: ["@defect/shared"],
  reactStrictMode: true,
  ...(staticExport
    ? {
        output: "export",
        // The image optimizer is a server feature; the static site serves the files as they are.
        images: { unoptimized: true },
      }
    : {
        // `standalone` emits a self-contained server (server.js + only the node_modules it needs) for the Docker image.
        // The tracing root is the monorepo root so the workspace package @defect/shared is included.
        output: "standalone",
        outputFileTracingRoot: path.join(__dirname, "../.."),
      }),
};

export default nextConfig;
