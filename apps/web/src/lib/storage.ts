import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { env } from "@/env";

/**
 * File storage abstraction for uploaded source documents.
 *
 * The MVP uses a local-disk implementation (deployment-friendly for private,
 * self-hosted installs). An S3-compatible implementation can be slotted in
 * behind the same interface later without touching callers.
 *
 * Path convention: every object is keyed by a relative storage path that
 * carries a workspace-isolation prefix, so one workspace's files can never
 * collide with or reach into another's:
 *
 *     workspaces/<workspaceId>/documents/<documentId>
 *
 * This relative path is what gets written into
 * `documents.source_metadata.storage_path`. The Python ingestion worker reads
 * the file back by joining `FILE_STORAGE_DIR` with that same relative path, so
 * both sides share one contract (see services/ai ingestion).
 */
export interface FileStorage {
  /**
   * Store `bytes` for a document and return the relative storage path to
   * persist in `documents.source_metadata.storage_path`.
   */
  put(workspaceId: string, documentId: string, bytes: Buffer): Promise<string>;
  /** Read a previously stored object back by its relative storage path. */
  get(storagePath: string): Promise<Buffer>;
  /** Delete a stored object. Missing objects are treated as already gone. */
  delete(storagePath: string): Promise<void>;
}

/** Build the workspace-scoped relative storage path for a document. */
export function buildStoragePath(workspaceId: string, documentId: string): string {
  // Use POSIX separators in the stored value so it is portable across OSes and
  // matches the cross-language contract; resolution converts to the local sep.
  return path.posix.join(
    "workspaces",
    encodeSegment(workspaceId),
    "documents",
    encodeSegment(documentId),
  );
}

// Storage keys come from our own UUIDs, but guard defensively so a key can
// never contain a separator or traversal segment.
function encodeSegment(segment: string): string {
  if (!segment || segment.includes("/") || segment.includes("\\") || segment.includes("..")) {
    throw new Error(`Invalid storage path segment: ${segment}`);
  }
  return segment;
}

/**
 * Resolve a relative storage path against the storage root, guarding against
 * path traversal that would escape the root (mirrors the worker-side check).
 */
function resolveWithinRoot(root: string, storagePath: string): string {
  const absoluteRoot = path.resolve(root);
  const resolved = path.resolve(absoluteRoot, storagePath);
  const withSep = absoluteRoot.endsWith(path.sep)
    ? absoluteRoot
    : absoluteRoot + path.sep;
  if (resolved !== absoluteRoot && !resolved.startsWith(withSep)) {
    throw new Error(`Resolved storage path escapes storage root: ${storagePath}`);
  }
  return resolved;
}

class LocalFileStorage implements FileStorage {
  constructor(private readonly root: string) {}

  async put(
    workspaceId: string,
    documentId: string,
    bytes: Buffer,
  ): Promise<string> {
    const storagePath = buildStoragePath(workspaceId, documentId);
    const absolutePath = resolveWithinRoot(this.root, storagePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, bytes);
    return storagePath;
  }

  async get(storagePath: string): Promise<Buffer> {
    const absolutePath = resolveWithinRoot(this.root, storagePath);
    return readFile(absolutePath);
  }

  async delete(storagePath: string): Promise<void> {
    const absolutePath = resolveWithinRoot(this.root, storagePath);
    try {
      await unlink(absolutePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw err;
    }
  }
}

let storageSingleton: FileStorage | null = null;

/** Return the configured file storage (local disk for the MVP). */
export function getFileStorage(): FileStorage {
  if (!storageSingleton) {
    storageSingleton = new LocalFileStorage(env.fileStorageDir);
  }
  return storageSingleton;
}
