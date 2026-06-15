import path from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root so Turbopack doesn't infer it from an
  // unrelated lockfile elsewhere on the machine.
  turbopack: {
    root: path.join(__dirname, "..", ".."),
  },
};

export default nextConfig;
