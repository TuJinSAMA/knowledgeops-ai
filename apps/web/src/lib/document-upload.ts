import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { documents, ingestionJobs, knowledgeBases } from "@/db/schema";
import { env } from "@/env";
import { getFileStorage } from "./storage";

// Accepted source document MIME types (see plan T2.3). Markdown and plain text
// are ingested directly; PDF is parsed by the Python loader.
export const ALLOWED_MIME_TYPES = [
  "text/markdown",
  "text/plain",
  "application/pdf",
] as const;

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

// Map of file extensions to canonical MIME types, used to recover the type
// when the browser sends an empty or generic value (common for .md files).
const EXTENSION_MIME: Record<string, AllowedMimeType> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  text: "text/plain",
  pdf: "application/pdf",
};

export type UploadErrorCode =
  | "UPLOAD_FILE_MISSING"
  | "UPLOAD_UNSUPPORTED_TYPE"
  | "UPLOAD_FILE_EMPTY"
  | "UPLOAD_FILE_TOO_LARGE"
  | "DOCUMENT_NOT_FOUND"
  | "DOCUMENT_BUSY_PROCESSING"
  | "DOCUMENT_RETRY_NOT_ALLOWED";

/**
 * Error carrying an HTTP status and a machine-readable code so the upload
 * routes and client UI can translate it cleanly.
 */
export class UploadError extends Error {
  readonly status: 400 | 404 | 409 | 413;
  readonly code: UploadErrorCode;

  constructor(
    status: 400 | 404 | 409 | 413,
    code: UploadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "UploadError";
    this.status = status;
    this.code = code;
  }
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

/**
 * Resolve the effective MIME type from the browser-provided type, falling back
 * to the file extension. Throws {@link UploadError} (400) when the result is
 * not in the whitelist.
 */
export function resolveMimeType(
  declaredType: string,
  filename: string,
): AllowedMimeType {
  const declared = declaredType.split(";")[0]?.trim().toLowerCase() ?? "";
  if ((ALLOWED_MIME_TYPES as readonly string[]).includes(declared)) {
    return declared as AllowedMimeType;
  }
  const fromExt = EXTENSION_MIME[extensionOf(filename)];
  if (fromExt) {
    return fromExt;
  }
  throw new UploadError(
    400,
    "UPLOAD_UNSUPPORTED_TYPE",
    `Unsupported file type. Allowed: ${ALLOWED_MIME_TYPES.join(", ")}`,
  );
}

async function validateAndReadFile(file: File): Promise<{
  filename: string;
  mimeType: AllowedMimeType;
  bytes: Buffer;
}> {
  const filename = file.name || "untitled";
  const mimeType = resolveMimeType(file.type, filename);

  if (file.size === 0) {
    throw new UploadError(400, "UPLOAD_FILE_EMPTY", "File is empty");
  }
  if (env.maxUploadBytes > 0 && file.size > env.maxUploadBytes) {
    throw new UploadError(
      413,
      "UPLOAD_FILE_TOO_LARGE",
      `File exceeds the maximum upload size of ${env.maxUploadBytes} bytes`,
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  // Re-check after reading in case Content-Length under-reported the size.
  if (env.maxUploadBytes > 0 && bytes.byteLength > env.maxUploadBytes) {
    throw new UploadError(
      413,
      "UPLOAD_FILE_TOO_LARGE",
      `File exceeds the maximum upload size of ${env.maxUploadBytes} bytes`,
    );
  }

  return { filename, mimeType, bytes };
}

async function findScopedDocument(params: {
  workspaceId: string;
  knowledgeBaseId: string;
  documentId: string;
}) {
  const [doc] = await db
    .select({
      id: documents.id,
      title: documents.title,
      status: documents.status,
      sourceMetadata: documents.sourceMetadata,
    })
    .from(documents)
    .innerJoin(
      knowledgeBases,
      eq(documents.knowledgeBaseId, knowledgeBases.id),
    )
    .where(
      and(
        eq(documents.id, params.documentId),
        eq(documents.knowledgeBaseId, params.knowledgeBaseId),
        eq(knowledgeBases.workspaceId, params.workspaceId),
      ),
    )
    .limit(1);

  return doc ?? null;
}

export type UploadedDocument = {
  id: string;
  title: string;
  mimeType: AllowedMimeType;
  status: (typeof documents.$inferSelect)["status"];
  version: number;
};

/**
 * Validate, store, and register an uploaded document:
 *   1. validate MIME + size
 *   2. write the original bytes via the file storage abstraction
 *   3. insert a `documents` row (status PENDING, source_metadata.storage_path)
 *   4. enqueue an INGEST_DOCUMENT job for the Python worker
 *
 * The caller must have already verified workspace membership/role and that the
 * knowledge base belongs to `workspaceId` (tenant isolation).
 */
export async function ingestUploadedFile(params: {
  workspaceId: string;
  knowledgeBaseId: string;
  file: File;
}): Promise<UploadedDocument> {
  const { workspaceId, knowledgeBaseId, file } = params;
  const { filename, mimeType, bytes } = await validateAndReadFile(file);

  // Generate the id up front so the file is stored before the row exists; if
  // the DB insert fails we clean the orphaned file up.
  const documentId = randomUUID();
  const storage = getFileStorage();
  const storagePath = await storage.put(workspaceId, documentId, bytes);

  try {
    await db.transaction(async (tx) => {
      await tx.insert(documents).values({
        id: documentId,
        knowledgeBaseId,
        title: filename,
        mimeType,
        status: "PENDING",
        sourceMetadata: {
          storage_path: storagePath,
          original_filename: filename,
          byte_size: bytes.byteLength,
          version: 1,
        },
      });

      await tx.insert(ingestionJobs).values({
        jobType: "INGEST_DOCUMENT",
        documentId,
        payload: { document_id: documentId },
      });
    });
  } catch (err) {
    await storage.delete(storagePath).catch(() => {});
    throw err;
  }

  return {
    id: documentId,
    title: filename,
    mimeType,
    status: "PENDING",
    version: 1,
  };
}

/**
 * Replace an existing document's file in-place, preserving `documentId` so
 * historical citations and evaluation `expectedSourceDocuments` stay intact.
 * Atomically bumps `source_metadata.version`, marks the document `PENDING`,
 * and enqueues a new `INGEST_DOCUMENT` job (the Python worker's
 * `_replace_chunks` swaps out the old chunks in a single DB transaction).
 */
export async function replaceDocumentFile(params: {
  workspaceId: string;
  knowledgeBaseId: string;
  documentId: string;
  file: File;
}): Promise<UploadedDocument> {
  const { workspaceId, knowledgeBaseId, documentId, file } = params;
  const { filename, mimeType, bytes } = await validateAndReadFile(file);

  const existing = await findScopedDocument({
    workspaceId,
    knowledgeBaseId,
    documentId,
  });
  if (!existing) {
    throw new UploadError(404, "DOCUMENT_NOT_FOUND", "Document not found");
  }
  if (existing.status === "PROCESSING") {
    throw new UploadError(
      409,
      "DOCUMENT_BUSY_PROCESSING",
      "Document is currently being ingested",
    );
  }

  const prevMeta = (existing.sourceMetadata ?? {}) as Record<string, unknown>;
  const prevVersion =
    typeof prevMeta.version === "number" &&
    Number.isInteger(prevMeta.version) &&
    prevMeta.version >= 1
      ? prevMeta.version
      : 1;
  const nextVersion = prevVersion + 1;

  const storage = getFileStorage();
  const storagePath = await storage.put(workspaceId, documentId, bytes);

  await db.transaction(async (tx) => {
    await tx
      .update(documents)
      .set({
        title: filename,
        mimeType,
        status: "PENDING",
        updatedAt: new Date(),
        sourceMetadata: {
          ...prevMeta,
          storage_path: storagePath,
          original_filename: filename,
          byte_size: bytes.byteLength,
          version: nextVersion,
        },
      })
      .where(
        and(
          eq(documents.id, documentId),
          eq(documents.knowledgeBaseId, knowledgeBaseId),
        ),
      );

    await tx.insert(ingestionJobs).values({
      jobType: "INGEST_DOCUMENT",
      documentId,
      payload: { document_id: documentId },
    });
  });

  return {
    id: documentId,
    title: filename,
    mimeType,
    status: "PENDING",
    version: nextVersion,
  };
}

/**
 * Delete a single document (cascades to `document_chunks` and
 * `ingestion_jobs`) and remove its stored file on a best-effort basis.
 */
export async function deleteDocument(params: {
  workspaceId: string;
  knowledgeBaseId: string;
  documentId: string;
}): Promise<{ id: string; title: string }> {
  const { workspaceId, knowledgeBaseId, documentId } = params;
  const existing = await findScopedDocument({
    workspaceId,
    knowledgeBaseId,
    documentId,
  });
  if (!existing) {
    throw new UploadError(404, "DOCUMENT_NOT_FOUND", "Document not found");
  }
  if (existing.status === "PROCESSING") {
    throw new UploadError(
      409,
      "DOCUMENT_BUSY_PROCESSING",
      "Document is currently being ingested",
    );
  }

  const deleted = await db
    .delete(documents)
    .where(
      and(
        eq(documents.id, documentId),
        eq(documents.knowledgeBaseId, knowledgeBaseId),
      ),
    )
    .returning({ id: documents.id });
  if (deleted.length === 0) {
    throw new UploadError(404, "DOCUMENT_NOT_FOUND", "Document not found");
  }

  const storagePath = (existing.sourceMetadata as { storage_path?: unknown } | null)
    ?.storage_path;
  if (typeof storagePath === "string" && storagePath.length > 0) {
    await getFileStorage()
      .delete(storagePath)
      .catch(() => {});
  }

  return { id: existing.id, title: existing.title };
}

/**
 * Re-enqueue ingestion for a `FAILED` document without re-uploading its bytes.
 */
export async function retryDocumentIngestion(params: {
  workspaceId: string;
  knowledgeBaseId: string;
  documentId: string;
}): Promise<{ id: string; title: string; status: "PENDING" }> {
  const { workspaceId, knowledgeBaseId, documentId } = params;
  const existing = await findScopedDocument({
    workspaceId,
    knowledgeBaseId,
    documentId,
  });
  if (!existing) {
    throw new UploadError(404, "DOCUMENT_NOT_FOUND", "Document not found");
  }
  if (existing.status === "PROCESSING") {
    throw new UploadError(
      409,
      "DOCUMENT_BUSY_PROCESSING",
      "Document is currently being ingested",
    );
  }
  if (existing.status !== "FAILED") {
    throw new UploadError(
      400,
      "DOCUMENT_RETRY_NOT_ALLOWED",
      "Only failed documents can be retried",
    );
  }

  await db.transaction(async (tx) => {
    await tx
      .update(documents)
      .set({ status: "PENDING", updatedAt: new Date() })
      .where(
        and(
          eq(documents.id, documentId),
          eq(documents.knowledgeBaseId, knowledgeBaseId),
        ),
      );

    await tx.insert(ingestionJobs).values({
      jobType: "INGEST_DOCUMENT",
      documentId,
      payload: { document_id: documentId },
    });
  });

  return { id: existing.id, title: existing.title, status: "PENDING" };
}
