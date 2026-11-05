import { randomUUID } from "node:crypto";

import { db } from "@/db";
import { documents, ingestionJobs } from "@/db/schema";
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
  | "UPLOAD_FILE_TOO_LARGE";

/**
 * Error carrying an HTTP status and a machine-readable code so the upload
 * route and client UI can translate it cleanly.
 */
export class UploadError extends Error {
  readonly status: 400 | 413;
  readonly code: UploadErrorCode;

  constructor(status: 400 | 413, code: UploadErrorCode, message: string) {
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

export type UploadedDocument = {
  id: string;
  title: string;
  mimeType: AllowedMimeType;
  status: (typeof documents.$inferSelect)["status"];
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

  return { id: documentId, title: filename, mimeType, status: "PENDING" };
}
