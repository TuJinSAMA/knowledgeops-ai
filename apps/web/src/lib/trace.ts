import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { ragTraces } from "@/db/schema";

/**
 * A single retrieved chunk as stored in a trace's `retrieved_chunks` snapshot.
 * Mirrors the AI service retrieval result plus the display snippet captured at
 * answer time (so the debug panel renders without re-querying the AI layer).
 */
export type TraceRetrievedChunk = {
  chunkId: string;
  documentId: string;
  chunkIndex: number | null;
  score: number | null;
  snippet: string;
};

export type TraceTokenUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

export type CreateTraceParams = {
  workspaceId: string;
  conversationId: string;
  messageId?: string | null;
  query: string;
  rewrittenQuery?: string | null;
  retrievalConfig?: Record<string, unknown> | null;
  retrievedChunks?: TraceRetrievedChunk[] | null;
  finalContext?: string | null;
  model?: string | null;
  response?: string | null;
  tokenUsage?: TraceTokenUsage | null;
  costEstimate?: number | null;
  latencyMs?: number | null;
  stageLatencyMs?: Record<string, number> | null;
  error?: string | null;
};

/**
 * Persist one RAG trace. The AI service returns the trace summary on its `done`
 * event; the web layer owns the schema and writes the row here (mvp-plan §5).
 * Always scoped to a workspace for tenant isolation.
 */
export async function createTrace(
  params: CreateTraceParams,
): Promise<{ id: string }> {
  const [row] = await db
    .insert(ragTraces)
    .values({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      messageId: params.messageId ?? null,
      query: params.query,
      rewrittenQuery: params.rewrittenQuery ?? null,
      retrievalConfig: params.retrievalConfig ?? null,
      retrievedChunks: params.retrievedChunks ?? null,
      finalContext: params.finalContext ?? null,
      model: params.model ?? null,
      response: params.response ?? null,
      tokenUsage: params.tokenUsage ?? null,
      // numeric columns are written as strings in drizzle/pg.
      costEstimate:
        params.costEstimate == null ? null : params.costEstimate.toFixed(6),
      latencyMs: params.latencyMs ?? null,
      stageLatencyMs: params.stageLatencyMs ?? null,
      error: params.error ?? null,
    })
    .returning({ id: ragTraces.id });
  return { id: row.id };
}

export type TraceRow = typeof ragTraces.$inferSelect;

/**
 * Fetch a trace by id, scoped to its workspace (tenant isolation). Returns null
 * when it does not exist or belongs to another workspace.
 */
export async function getTrace(
  workspaceId: string,
  traceId: string,
): Promise<TraceRow | null> {
  const [row] = await db
    .select()
    .from(ragTraces)
    .where(and(eq(ragTraces.id, traceId), eq(ragTraces.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

export type TraceListItem = {
  id: string;
  query: string;
  model: string | null;
  costEstimate: string | null;
  latencyMs: number | null;
  error: string | null;
  createdAt: Date;
};

/**
 * List recent traces in a workspace (most recent first), for the debug index.
 * Scoped to the workspace so traces never leak across tenants.
 */
export async function listTraces(
  workspaceId: string,
  limit = 50,
): Promise<TraceListItem[]> {
  return db
    .select({
      id: ragTraces.id,
      query: ragTraces.query,
      model: ragTraces.model,
      costEstimate: ragTraces.costEstimate,
      latencyMs: ragTraces.latencyMs,
      error: ragTraces.error,
      createdAt: ragTraces.createdAt,
    })
    .from(ragTraces)
    .where(eq(ragTraces.workspaceId, workspaceId))
    .orderBy(desc(ragTraces.createdAt))
    .limit(limit);
}
