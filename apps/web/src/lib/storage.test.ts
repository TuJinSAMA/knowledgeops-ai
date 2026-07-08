import { describe, expect, it, vi } from "vitest";

// env imports dotenv and derives DATABASE_URL from POSTGRES_*; stub it so the
// pure path helpers can be imported without a configured database.
vi.mock("@/env", () => ({ env: { fileStorageDir: "./data/uploads" } }));

import { buildStoragePath } from "@/lib/storage";

describe("buildStoragePath", () => {
  it("includes a workspace-isolation prefix", () => {
    expect(buildStoragePath("ws-1", "doc-1")).toBe(
      "workspaces/ws-1/documents/doc-1",
    );
  });

  it("rejects segments that could escape the workspace prefix", () => {
    expect(() => buildStoragePath("../etc", "doc-1")).toThrow();
    expect(() => buildStoragePath("ws-1", "../../secret")).toThrow();
    expect(() => buildStoragePath("ws/1", "doc-1")).toThrow();
    expect(() => buildStoragePath("", "doc-1")).toThrow();
  });
});
