import { describe, expect, it, vi } from "vitest";

// Both @/db and @/env are imported transitively; stub them so the pure MIME
// resolver can be tested without a database connection.
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/env", () => ({ env: { maxUploadBytes: 0, fileStorageDir: "./data/uploads" } }));

import { ingestUploadedFile, resolveMimeType, UploadError } from "@/lib/document-upload";

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

  it("rejects unsupported types with UPLOAD_UNSUPPORTED_TYPE code", () => {
    expect(() => resolveMimeType("image/png", "x.png")).toThrow(
      expect.objectContaining({ code: "UPLOAD_UNSUPPORTED_TYPE" }),
    );
    expect(() => resolveMimeType("", "archive.zip")).toThrow(
      expect.objectContaining({ code: "UPLOAD_UNSUPPORTED_TYPE" }),
    );
  });

  it("rejects empty files with UPLOAD_FILE_EMPTY code", async () => {
    const emptyFile = new File([], "empty.md", { type: "text/markdown" });
    await expect(
      ingestUploadedFile({
        workspaceId: "ws-1",
        knowledgeBaseId: "kb-1",
        file: emptyFile,
      }),
    ).rejects.toMatchObject({
      name: "UploadError",
      code: "UPLOAD_FILE_EMPTY",
    });
  });

  it("rejects oversized files with UPLOAD_FILE_TOO_LARGE code", async () => {
    const { env } = await import("@/env");
    env.maxUploadBytes = 4;
    try {
      const bigFile = new File(["12345678"], "big.md", {
        type: "text/markdown",
      });
      await expect(
        ingestUploadedFile({
          workspaceId: "ws-1",
          knowledgeBaseId: "kb-1",
          file: bigFile,
        }),
      ).rejects.toMatchObject({
        name: "UploadError",
        code: "UPLOAD_FILE_TOO_LARGE",
      });
    } finally {
      env.maxUploadBytes = 0;
    }
  });
});
