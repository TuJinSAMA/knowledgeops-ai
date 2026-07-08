import { describe, expect, it, vi } from "vitest";

// Both @/db and @/env are imported transitively; stub them so the pure MIME
// resolver can be tested without a database connection.
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/env", () => ({ env: { maxUploadBytes: 0, fileStorageDir: "./data/uploads" } }));

import { resolveMimeType, UploadError } from "@/lib/document-upload";

describe("resolveMimeType", () => {
  it("accepts whitelisted declared types", () => {
    expect(resolveMimeType("text/markdown", "a.md")).toBe("text/markdown");
    expect(resolveMimeType("text/plain", "a.txt")).toBe("text/plain");
    expect(resolveMimeType("application/pdf", "a.pdf")).toBe("application/pdf");
  });

  it("strips parameters from the declared type", () => {
    expect(resolveMimeType("text/plain; charset=utf-8", "a.txt")).toBe(
      "text/plain",
    );
  });

  it("falls back to the file extension when the type is empty or generic", () => {
    expect(resolveMimeType("", "notes.md")).toBe("text/markdown");
    expect(resolveMimeType("application/octet-stream", "readme.markdown")).toBe(
      "text/markdown",
    );
    expect(resolveMimeType("", "doc.pdf")).toBe("application/pdf");
  });

  it("rejects unsupported types", () => {
    expect(() => resolveMimeType("image/png", "x.png")).toThrow(UploadError);
    expect(() => resolveMimeType("", "archive.zip")).toThrow(UploadError);
  });
});
