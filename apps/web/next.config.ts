import path from "node:path";

import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const repoRoot = path.join(__dirname, "..", "..");

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle (.next/standalone) so the Docker
  // runtime image can run `node server.js` without the full node_modules.
  output: "standalone",
  // Trace files from the monorepo root so the standalone output includes the
  // workspace dependencies (web is built from the repo root in Docker).
  outputFileTracingRoot: repoRoot,
  // Pin the workspace root so Turbopack doesn't infer it from an
  // unrelated lockfile elsewhere on the machine.
  turbopack: {
    root: repoRoot,
  },
};

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

export default withNextIntl(nextConfig);
