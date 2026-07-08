import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  documentChunks,
  documents,
  ingestionJobs,
  knowledgeBases,
} from "@/db/schema";

export type KnowledgeBaseSummary = {
  id: string;
  name: string;
  description: string | null;
  documentCount: number;
  createdAt: Date;
};

export type DocumentStatus = (typeof documents.$inferSelect)["status"];

export type DocumentSummary = {
  id: string;
  title: string;
  mimeType: string;
  status: DocumentStatus;
  chunkCount: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

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
    documentCount: 0,
    createdAt: row.createdAt,
  };
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

  return rows.map((row) => ({
    ...row,
    lastError:
      row.status === "FAILED"
        ? latestErrorByDocument.get(row.id) ?? null
        : null,
  }));
}
