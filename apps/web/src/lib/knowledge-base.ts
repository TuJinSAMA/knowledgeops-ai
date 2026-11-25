import { and, asc, desc, eq, ilike, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  documentChunks,
  documents,
  ingestionJobs,
  type KnowledgeBaseRagConfig,
  knowledgeBases,
} from "@/db/schema";

export type KnowledgeBaseSummary = {
  id: string;
  name: string;
  description: string | null;
  ragConfig: KnowledgeBaseRagConfig | null;
  documentCount: number;
  createdAt: Date;
};

export type DocumentStatus = (typeof documents.$inferSelect)["status"];

export type DocumentSummary = {
  id: string;
  title: string;
  mimeType: string;
  status: DocumentStatus;
  version: number;
  byteSize: number | null;
  chunkCount: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type DocumentDetail = DocumentSummary & {
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  totalTokens: number;
};

export type DocumentChunkItem = {
  id: string;
  chunkIndex: number;
  content: string;
  tokenCount: number | null;
  createdAt: Date;
};

export type ParsedChunkHeader = {
  document?: string;
  section?: string;
};

function extractVersionAndSize(
  meta: Record<string, unknown> | null | undefined,
): { version: number; byteSize: number | null } {
  const rawVersion = meta?.version;
  const version =
    typeof rawVersion === "number" && Number.isInteger(rawVersion) && rawVersion >= 1
      ? rawVersion
      : 1;
  const rawSize = meta?.byte_size;
  const byteSize =
    typeof rawSize === "number" && Number.isFinite(rawSize) && rawSize >= 0
      ? rawSize
      : null;
  return { version, byteSize };
}

/**
 * Split a contextual chunk header (`[Document: ... | Section: ...]\n...`)
 * prepended by `services/ai/app/rag/chunking.py` from the body text for display.
 */
export function parseChunkContextHeader(content: string): {
  header: ParsedChunkHeader | null;
  body: string;
} {
  if (!content.startsWith("[")) {
    return { header: null, body: content };
  }
  const newlineIdx = content.indexOf("\n");
  const firstLine = newlineIdx >= 0 ? content.slice(0, newlineIdx) : content;
  if (!firstLine.endsWith("]")) {
    return { header: null, body: content };
  }
  const inner = firstLine.slice(1, -1);
  const parts = inner.split("|").map((p) => p.trim());
  const header: ParsedChunkHeader = {};
  for (const part of parts) {
    if (part.startsWith("Document:")) {
      const val = part.slice("Document:".length).trim();
      if (val) header.document = val;
    } else if (part.startsWith("Section:")) {
      const val = part.slice("Section:".length).trim();
      if (val) header.section = val;
    }
  }
  if (!header.document && !header.section) {
    return { header: null, body: content };
  }
  const body = newlineIdx >= 0 ? content.slice(newlineIdx + 1) : "";
  return { header, body };
}

/**
 * List knowledge bases in a workspace with their document counts. Every query
 * is scoped by `workspaceId`; callers must have already passed the workspace
 * membership guard so tenant isolation holds.
 */
export async function listKnowledgeBases(
  workspaceId: string,
): Promise<KnowledgeBaseSummary[]> {
  const rows = await db
    .select({
      id: knowledgeBases.id,
      name: knowledgeBases.name,
      description: knowledgeBases.description,
      ragConfig: knowledgeBases.ragConfig,
      createdAt: knowledgeBases.createdAt,
      documentCount: sql<number>`count(${documents.id})`.mapWith(Number),
    })
    .from(knowledgeBases)
    .leftJoin(documents, eq(documents.knowledgeBaseId, knowledgeBases.id))
    .where(eq(knowledgeBases.workspaceId, workspaceId))
    .groupBy(knowledgeBases.id)
    .orderBy(knowledgeBases.createdAt);

  return rows;
}

/**
 * Fetch a single knowledge base by id, scoped to its workspace. Returns null
 * when it does not exist or belongs to another workspace (tenant isolation).
 */
export async function getKnowledgeBase(
  workspaceId: string,
  knowledgeBaseId: string,
): Promise<KnowledgeBaseSummary | null> {
  const [row] = await db
    .select({
      id: knowledgeBases.id,
      name: knowledgeBases.name,
      description: knowledgeBases.description,
      ragConfig: knowledgeBases.ragConfig,
      createdAt: knowledgeBases.createdAt,
      documentCount: sql<number>`count(${documents.id})`.mapWith(Number),
    })
    .from(knowledgeBases)
    .leftJoin(documents, eq(documents.knowledgeBaseId, knowledgeBases.id))
    .where(
      and(
        eq(knowledgeBases.id, knowledgeBaseId),
        eq(knowledgeBases.workspaceId, workspaceId),
      ),
    )
    .groupBy(knowledgeBases.id)
    .limit(1);

  return row ?? null;
}

/** Create a knowledge base in a workspace. Caller handles authorization. */
export async function createKnowledgeBase(
  workspaceId: string,
  name: string,
  description?: string | null,
): Promise<KnowledgeBaseSummary> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error("Knowledge base name cannot be empty");
  }
  const trimmedDescription = description?.trim() || null;

  const [row] = await db
    .insert(knowledgeBases)
    .values({
      workspaceId,
      name: trimmedName,
      description: trimmedDescription,
    })
    .returning();

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    ragConfig: row.ragConfig ?? null,
    documentCount: 0,
    createdAt: row.createdAt,
  };
}

/**
 * Update the live RAG configuration of a knowledge base, scoped to its
 * workspace. Passing `null` or `{}` resets the knowledge base back to AI
 * service defaults. Returns true when the row existed in this workspace.
 */
export async function updateKnowledgeBaseRagConfig(
  workspaceId: string,
  knowledgeBaseId: string,
  ragConfig: KnowledgeBaseRagConfig | null,
): Promise<boolean> {
  const normalized =
    ragConfig && Object.keys(ragConfig).length > 0 ? ragConfig : null;
  const updated = await db
    .update(knowledgeBases)
    .set({
      ragConfig: normalized,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(knowledgeBases.id, knowledgeBaseId),
        eq(knowledgeBases.workspaceId, workspaceId),
      ),
    )
    .returning({ id: knowledgeBases.id });

  return updated.length > 0;
}

/**
 * Delete a knowledge base (and, via ON DELETE CASCADE, its documents and
 * chunks). Scoped by `workspaceId` so a caller can never delete another
 * tenant's knowledge base. Returns true when a row was deleted.
 */
export async function deleteKnowledgeBase(
  workspaceId: string,
  knowledgeBaseId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(knowledgeBases)
    .where(
      and(
        eq(knowledgeBases.id, knowledgeBaseId),
        eq(knowledgeBases.workspaceId, workspaceId),
      ),
    )
    .returning({ id: knowledgeBases.id });

  return deleted.length > 0;
}

/**
 * List documents in a knowledge base with per-document chunk counts and the
 * latest ingestion job error (if any). Scoped by `workspaceId` + knowledge
 * base id so it cannot read across tenants.
 */
export async function listDocuments(
  workspaceId: string,
  knowledgeBaseId: string,
): Promise<DocumentSummary[]> {
  // Confirm the knowledge base belongs to this workspace before reading its
  // documents (defense in depth even though callers pass the guard first).
  const kb = await getKnowledgeBase(workspaceId, knowledgeBaseId);
  if (!kb) {
    return [];
  }

  const rows = await db
    .select({
      id: documents.id,
      title: documents.title,
      mimeType: documents.mimeType,
      status: documents.status,
      sourceMetadata: documents.sourceMetadata,
      createdAt: documents.createdAt,
      updatedAt: documents.updatedAt,
      chunkCount: sql<number>`count(${documentChunks.id})`.mapWith(Number),
    })
    .from(documents)
    .leftJoin(documentChunks, eq(documentChunks.documentId, documents.id))
    .where(eq(documents.knowledgeBaseId, knowledgeBaseId))
    .groupBy(documents.id)
    .orderBy(documents.createdAt);

  if (rows.length === 0) {
    return [];
  }

  // Pull the latest ingestion job error per document so failed documents can
  // surface a reason in the UI (documents has no last_error column; the job
  // queue carries it).
  const errorRows = await db
    .select({
      documentId: ingestionJobs.documentId,
      lastError: ingestionJobs.lastError,
      createdAt: ingestionJobs.createdAt,
    })
    .from(ingestionJobs)
    .where(eq(ingestionJobs.jobType, "INGEST_DOCUMENT"));

  const latestErrorByDocument = new Map<string, string | null>();
  const latestAtByDocument = new Map<string, number>();
  for (const row of errorRows) {
    if (!row.documentId) {
      continue;
    }
    const at = row.createdAt.getTime();
    if (at >= (latestAtByDocument.get(row.documentId) ?? -Infinity)) {
      latestAtByDocument.set(row.documentId, at);
      latestErrorByDocument.set(row.documentId, row.lastError);
    }
  }

  return rows.map(({ sourceMetadata, ...row }) => {
    const { version, byteSize } = extractVersionAndSize(sourceMetadata);
    return {
      ...row,
      version,
      byteSize,
      lastError:
        row.status === "FAILED"
          ? latestErrorByDocument.get(row.id) ?? null
          : null,
    };
  });
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Fetch one document's metadata and chunk/token aggregates, strictly scoped to
 * `(workspaceId, knowledgeBaseId, documentId)`. Returns null when absent or in
 * another workspace/knowledge base.
 */
export async function getDocumentDetail(
  workspaceId: string,
  knowledgeBaseId: string,
  documentId: string,
): Promise<DocumentDetail | null> {
  const [row] = await db
    .select({
      id: documents.id,
      knowledgeBaseId: knowledgeBases.id,
      knowledgeBaseName: knowledgeBases.name,
      title: documents.title,
      mimeType: documents.mimeType,
      status: documents.status,
      sourceMetadata: documents.sourceMetadata,
      createdAt: documents.createdAt,
      updatedAt: documents.updatedAt,
      chunkCount: sql<number>`count(${documentChunks.id})`.mapWith(Number),
      totalTokens: sql<number>`coalesce(sum(${documentChunks.tokenCount}), 0)`.mapWith(
        Number,
      ),
    })
    .from(documents)
    .innerJoin(
      knowledgeBases,
      eq(documents.knowledgeBaseId, knowledgeBases.id),
    )
    .leftJoin(documentChunks, eq(documentChunks.documentId, documents.id))
    .where(
      and(
        eq(documents.id, documentId),
        eq(documents.knowledgeBaseId, knowledgeBaseId),
        eq(knowledgeBases.workspaceId, workspaceId),
      ),
    )
    .groupBy(documents.id, knowledgeBases.id, knowledgeBases.name)
    .limit(1);

  if (!row) {
    return null;
  }

  let lastError: string | null = null;
  if (row.status === "FAILED") {
    const [latestJob] = await db
      .select({ lastError: ingestionJobs.lastError })
      .from(ingestionJobs)
      .where(
        and(
          eq(ingestionJobs.documentId, documentId),
          eq(ingestionJobs.jobType, "INGEST_DOCUMENT"),
        ),
      )
      .orderBy(desc(ingestionJobs.createdAt))
      .limit(1);
    lastError = latestJob?.lastError ?? null;
  }

  const { sourceMetadata, ...rest } = row;
  const { version, byteSize } = extractVersionAndSize(sourceMetadata);
  return {
    ...rest,
    version,
    byteSize,
    lastError,
  };
}

/**
 * List chunks for one document (omitting the 1536-dim embedding vector),
 * scoped to `(workspaceId, knowledgeBaseId, documentId)`. Supports optional
 * case-insensitive substring search via `options.query`.
 */
export async function listDocumentChunks(
  workspaceId: string,
  knowledgeBaseId: string,
  documentId: string,
  options?: { query?: string | null },
): Promise<DocumentChunkItem[]> {
  const conditions = [
    eq(documentChunks.documentId, documentId),
    eq(documents.knowledgeBaseId, knowledgeBaseId),
    eq(knowledgeBases.workspaceId, workspaceId),
  ];
  const trimmedQuery = options?.query?.trim();
  if (trimmedQuery) {
    conditions.push(
      ilike(documentChunks.content, `%${escapeLikePattern(trimmedQuery)}%`),
    );
  }

  return db
    .select({
      id: documentChunks.id,
      chunkIndex: documentChunks.chunkIndex,
      content: documentChunks.content,
      tokenCount: documentChunks.tokenCount,
      createdAt: documentChunks.createdAt,
    })
    .from(documentChunks)
    .innerJoin(documents, eq(documentChunks.documentId, documents.id))
    .innerJoin(
      knowledgeBases,
      eq(documents.knowledgeBaseId, knowledgeBases.id),
    )
    .where(and(...conditions))
    .orderBy(asc(documentChunks.chunkIndex));
}
