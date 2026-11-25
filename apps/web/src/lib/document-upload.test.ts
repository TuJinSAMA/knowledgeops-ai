import { beforeEach, describe, expect, it, vi } from "vitest";

const storagePutMock = vi.fn();
const storageDeleteMock = vi.fn();
vi.mock("./storage", () => ({
  getFileStorage: () => ({
    put: (...args: unknown[]) => storagePutMock(...args),
    delete: (...args: unknown[]) => storageDeleteMock(...args),
  }),
}));

type DbState = {
  foundDoc: {
    id: string;
    title: string;
    status: "PENDING" | "PROCESSING" | "INGESTED" | "FAILED";
    sourceMetadata: Record<string, unknown> | null;
  } | null;
  deletedRows: Array<{ id: string }>;
  updatedSets: Array<Record<string, unknown>>;
  insertedJobs: Array<Record<string, unknown>>;
};

const dbState: DbState = {
  foundDoc: null,
  deletedRows: [],
  updatedSets: [],
  insertedJobs: [],
};

vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: async () => (dbState.foundDoc ? [dbState.foundDoc] : []),
          }),
        }),
      }),
    }),
    delete: () => ({
      where: () => ({
        returning: async () => dbState.deletedRows,
      }),
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        insert: () => ({
          values: async (val: Record<string, unknown>) => {
            dbState.insertedJobs.push(val);
          },
        }),
        update: () => ({
          set: (val: Record<string, unknown>) => {
            dbState.updatedSets.push(val);
            return {
              where: async () => undefined,
            };
          },
        }),
      };
      return fn(tx);
    },
  },
}));

vi.mock("@/env", () => ({
  env: { maxUploadBytes: 0, fileStorageDir: "./data/uploads" },
}));

import {
  deleteDocument,
  ingestUploadedFile,
  replaceDocumentFile,
  resolveMimeType,
  retryDocumentIngestion,
} from "@/lib/document-upload";

beforeEach(() => {
  vi.clearAllMocks();
  dbState.foundDoc = null;
  dbState.deletedRows = [{ id: "doc-1" }];
  dbState.updatedSets = [];
  dbState.insertedJobs = [];
  storagePutMock.mockResolvedValue("workspaces/ws-1/documents/doc-1");
  storageDeleteMock.mockResolvedValue(undefined);
});

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

describe("deleteDocument", () => {
  it("deletes a scoped document and cleans up stored bytes", async () => {
    dbState.foundDoc = {
      id: "doc-1",
      title: "policy.md",
      status: "INGESTED",
      sourceMetadata: { storage_path: "workspaces/ws-1/documents/doc-1" },
    };

    const res = await deleteDocument({
      workspaceId: "ws-1",
      knowledgeBaseId: "kb-1",
      documentId: "doc-1",
    });

    expect(res).toEqual({ id: "doc-1", title: "policy.md" });
    expect(storageDeleteMock).toHaveBeenCalledWith(
      "workspaces/ws-1/documents/doc-1",
    );
  });

  it("rejects deletion with 404 when document is absent or in another tenant", async () => {
    dbState.foundDoc = null;
    await expect(
      deleteDocument({
        workspaceId: "ws-1",
        knowledgeBaseId: "kb-1",
        documentId: "doc-other",
      }),
    ).rejects.toMatchObject({ status: 404, code: "DOCUMENT_NOT_FOUND" });
  });

  it("rejects deletion with 409 when document is PROCESSING", async () => {
    dbState.foundDoc = {
      id: "doc-1",
      title: "policy.md",
      status: "PROCESSING",
      sourceMetadata: null,
    };
    await expect(
      deleteDocument({
        workspaceId: "ws-1",
        knowledgeBaseId: "kb-1",
        documentId: "doc-1",
      }),
    ).rejects.toMatchObject({ status: 409, code: "DOCUMENT_BUSY_PROCESSING" });
    expect(storageDeleteMock).not.toHaveBeenCalled();
  });
});

describe("replaceDocumentFile", () => {
  it("keeps documentId, increments version, resets status to PENDING, and enqueues INGEST_DOCUMENT", async () => {
    dbState.foundDoc = {
      id: "doc-1",
      title: "policy-v1.md",
      status: "INGESTED",
      sourceMetadata: {
        storage_path: "workspaces/ws-1/documents/doc-1",
        version: 1,
      },
    };

    const file = new File(["# Updated refund policy\n14 days."], "policy.md", {
      type: "text/markdown",
    });
    const res = await replaceDocumentFile({
      workspaceId: "ws-1",
      knowledgeBaseId: "kb-1",
      documentId: "doc-1",
      file,
    });

    expect(res).toEqual({
      id: "doc-1",
      title: "policy.md",
      mimeType: "text/markdown",
      status: "PENDING",
      version: 2,
    });
    expect(storagePutMock).toHaveBeenCalledWith(
      "ws-1",
      "doc-1",
      expect.any(Buffer),
    );
    expect(dbState.updatedSets[0]).toMatchObject({
      title: "policy.md",
      status: "PENDING",
      sourceMetadata: expect.objectContaining({ version: 2 }),
    });
    expect(dbState.insertedJobs[0]).toMatchObject({
      jobType: "INGEST_DOCUMENT",
      documentId: "doc-1",
      payload: { document_id: "doc-1" },
    });
  });
});

describe("retryDocumentIngestion", () => {
  it("re-enqueues a FAILED document and flips status back to PENDING", async () => {
    dbState.foundDoc = {
      id: "doc-1",
      title: "broken.pdf",
      status: "FAILED",
      sourceMetadata: null,
    };

    const res = await retryDocumentIngestion({
      workspaceId: "ws-1",
      knowledgeBaseId: "kb-1",
      documentId: "doc-1",
    });

    expect(res).toEqual({
      id: "doc-1",
      title: "broken.pdf",
      status: "PENDING",
    });
    expect(dbState.updatedSets[0]).toMatchObject({ status: "PENDING" });
    expect(dbState.insertedJobs).toHaveLength(1);
  });

  it("rejects retry on an already INGESTED document with DOCUMENT_RETRY_NOT_ALLOWED", async () => {
    dbState.foundDoc = {
      id: "doc-1",
      title: "ok.md",
      status: "INGESTED",
      sourceMetadata: null,
    };

    await expect(
      retryDocumentIngestion({
        workspaceId: "ws-1",
        knowledgeBaseId: "kb-1",
        documentId: "doc-1",
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "DOCUMENT_RETRY_NOT_ALLOWED",
    });
    expect(dbState.insertedJobs).toHaveLength(0);
  });
});
