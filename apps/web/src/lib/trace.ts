import {
  and,
  desc,
  eq,
  gte,
  ilike,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";

import { db } from "@/db";
import {
  conversations,
  evaluationCases,
  evaluationDatasets,
  knowledgeBases,
  ragTraces,
} from "@/db/schema";
import { getDocumentTitles } from "./conversation";

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
  vectorScore?: number | null;
  keywordScore?: number | null;
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
  refused?: boolean;
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
      refused: Boolean(params.refused),
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

export type TraceDetail = {
  trace: TraceRow;
  knowledgeBaseId: string | null;
  knowledgeBaseName: string | null;
  promotedDatasetId: string | null;
  promotedDatasetName: string | null;
  documentTitles: Map<string, string>;
};

/**
 * Fetch a trace along with its owning knowledge base (via `conversations`) and
 * resolved titles for any retrieved source documents so the Trace Detail page
 * can render human-readable titles and deep-links to the Chunk Inspector.
 */
export async function getTraceDetail(
  workspaceId: string,
  traceId: string,
): Promise<TraceDetail | null> {
  const [row] = await db
    .select({
      trace: ragTraces,
      knowledgeBaseId: conversations.knowledgeBaseId,
      knowledgeBaseName: knowledgeBases.name,
      promotedDatasetId: evaluationDatasets.id,
      promotedDatasetName: evaluationDatasets.name,
    })
    .from(ragTraces)
    .leftJoin(conversations, eq(conversations.id, ragTraces.conversationId))
    .leftJoin(
      knowledgeBases,
      eq(knowledgeBases.id, conversations.knowledgeBaseId),
    )
    .leftJoin(
      evaluationCases,
      eq(ragTraces.promotedCaseId, evaluationCases.id),
    )
    .leftJoin(
      evaluationDatasets,
      eq(evaluationCases.datasetId, evaluationDatasets.id),
    )
    .where(and(eq(ragTraces.id, traceId), eq(ragTraces.workspaceId, workspaceId)))
    .limit(1);

  if (!row) {
    return null;
  }

  const chunks = (row.trace.retrievedChunks ?? []) as TraceRetrievedChunk[];
  const docIds = chunks
    .map((c) => c.documentId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const documentTitles = await getDocumentTitles(workspaceId, docIds);

  return {
    trace: row.trace,
    knowledgeBaseId: row.knowledgeBaseId ?? null,
    knowledgeBaseName: row.knowledgeBaseName ?? null,
    promotedDatasetId: row.promotedDatasetId ?? null,
    promotedDatasetName: row.promotedDatasetName ?? null,
    documentTitles,
  };
}

export type PromoteTraceToCaseParams = {
  datasetId?: string | null;
  newDatasetName?: string | null;
  question: string;
  expectedAnswer?: string | null;
  expectedSourceDocuments?: string[] | null;
  requiredFacts?: string | null;
  tags?: string[] | null;
};

export type PromoteTraceToCaseResult =
  | { ok: true; caseId: string; datasetId: string; datasetName: string }
  | {
      ok: false;
      reason:
        | "TRACE_NOT_FOUND"
        | "TRACE_ALREADY_PROMOTED"
        | "DATASET_NOT_FOUND"
        | "DATASET_NAME_REQUIRED"
        | "EVALUATION_CASE_QUESTION_REQUIRED";
    };

/**
 * Promote a live RAG trace into an evaluation case inside an existing or newly
 * created dataset in the same workspace, linking `rag_traces.promoted_case_id`
 * in a single transaction.
 */
export async function promoteTraceToCase(
  workspaceId: string,
  traceId: string,
  params: PromoteTraceToCaseParams & { requiredFactsList?: string[] | null },
): Promise<PromoteTraceToCaseResult> {
  const question = params.question?.trim() ?? "";
  if (!question) {
    return { ok: false, reason: "EVALUATION_CASE_QUESTION_REQUIRED" };
  }

  return db.transaction(async (tx) => {
    const [tr] = await tx
      .select({
        id: ragTraces.id,
        knowledgeBaseId: conversations.knowledgeBaseId,
        promotedCaseId: ragTraces.promotedCaseId,
      })
      .from(ragTraces)
      .leftJoin(conversations, eq(conversations.id, ragTraces.conversationId))
      .where(
        and(eq(ragTraces.id, traceId), eq(ragTraces.workspaceId, workspaceId)),
      )
      .limit(1);

    if (!tr) {
      return { ok: false, reason: "TRACE_NOT_FOUND" };
    }
    if (tr.promotedCaseId) {
      return { ok: false, reason: "TRACE_ALREADY_PROMOTED" };
    }

    let targetDatasetId: string;
    let targetDatasetName: string;

    if (params.datasetId && params.datasetId !== "__new__") {
      const [ds] = await tx
        .select({
          id: evaluationDatasets.id,
          name: evaluationDatasets.name,
        })
        .from(evaluationDatasets)
        .where(
          and(
            eq(evaluationDatasets.id, params.datasetId),
            eq(evaluationDatasets.workspaceId, workspaceId),
          ),
        )
        .limit(1);

      if (!ds) {
        return { ok: false, reason: "DATASET_NOT_FOUND" };
      }
      targetDatasetId = ds.id;
      targetDatasetName = ds.name;
    } else {
      const newName = params.newDatasetName?.trim() ?? "";
      if (!newName) {
        return { ok: false, reason: "DATASET_NAME_REQUIRED" };
      }
      const [createdDs] = await tx
        .insert(evaluationDatasets)
        .values({
          workspaceId,
          knowledgeBaseId: tr.knowledgeBaseId ?? null,
          name: newName,
          description: null,
        })
        .returning({
          id: evaluationDatasets.id,
          name: evaluationDatasets.name,
        });
      targetDatasetId = createdDs.id;
      targetDatasetName = createdDs.name;
    }

    const [createdCase] = await tx
      .insert(evaluationCases)
      .values({
        datasetId: targetDatasetId,
        question,
        expectedAnswer: params.expectedAnswer?.trim() || null,
        expectedSourceDocuments:
          params.expectedSourceDocuments &&
          params.expectedSourceDocuments.length > 0
            ? params.expectedSourceDocuments
            : null,
        expectedChunks: null,
        requiredFacts:
          params.requiredFactsList && params.requiredFactsList.length > 0
            ? params.requiredFactsList
            : null,
        tags: params.tags && params.tags.length > 0 ? params.tags : null,
      })
      .returning({ id: evaluationCases.id });

    await tx
      .update(evaluationDatasets)
      .set({ updatedAt: new Date() })
      .where(eq(evaluationDatasets.id, targetDatasetId));

    await tx
      .update(ragTraces)
      .set({ promotedCaseId: createdCase.id })
      .where(
        and(eq(ragTraces.id, traceId), eq(ragTraces.workspaceId, workspaceId)),
      );

    return {
      ok: true,
      caseId: createdCase.id,
      datasetId: targetDatasetId,
      datasetName: targetDatasetName,
    };
  });
}

export type TraceStatusFilter = "ALL" | "OK" | "REFUSED" | "ERROR";
export const TRACE_STATUS_FILTERS: readonly TraceStatusFilter[] = [
  "ALL",
  "OK",
  "REFUSED",
  "ERROR",
];

export type TraceListFilters = {
  knowledgeBaseId?: string | null;
  status?: TraceStatusFilter | null;
  minLatencyMs?: number | null;
  query?: string | null;
  limit?: number;
  offset?: number;
};

export type TraceListItem = {
  id: string;
  query: string;
  rewrittenQuery: string | null;
  knowledgeBaseId: string | null;
  knowledgeBaseName: string | null;
  model: string | null;
  refused: boolean;
  costEstimate: string | null;
  latencyMs: number | null;
  error: string | null;
  createdAt: Date;
};

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * List traces in a workspace with multi-dimensional filtering (knowledge base,
 * outcome status, minimum latency, query substring) and pagination. Strictly
 * scoped by `workspaceId` so traces never leak across tenants.
 */
export async function listTracesFiltered(
  workspaceId: string,
  filters: TraceListFilters = {},
): Promise<{ items: TraceListItem[]; total: number }> {
  const conditions = [eq(ragTraces.workspaceId, workspaceId)];

  if (filters.knowledgeBaseId) {
    conditions.push(eq(conversations.knowledgeBaseId, filters.knowledgeBaseId));
  }

  if (filters.status === "ERROR") {
    conditions.push(isNotNull(ragTraces.error));
  } else if (filters.status === "REFUSED") {
    conditions.push(isNull(ragTraces.error));
    conditions.push(eq(ragTraces.refused, true));
  } else if (filters.status === "OK") {
    conditions.push(isNull(ragTraces.error));
    conditions.push(eq(ragTraces.refused, false));
  }

  if (
    typeof filters.minLatencyMs === "number" &&
    Number.isFinite(filters.minLatencyMs) &&
    filters.minLatencyMs > 0
  ) {
    conditions.push(gte(ragTraces.latencyMs, Math.floor(filters.minLatencyMs)));
  }

  const trimmedQuery = filters.query?.trim();
  if (trimmedQuery) {
    const pattern = `%${escapeLikePattern(trimmedQuery)}%`;
    const qCond = or(
      ilike(ragTraces.query, pattern),
      ilike(ragTraces.rewrittenQuery, pattern),
    );
    if (qCond) {
      conditions.push(qCond);
    }
  }

  const limit = Math.min(Math.max(filters.limit ?? 30, 1), 100);
  const offset = Math.max(filters.offset ?? 0, 0);
  const whereClause = and(...conditions);

  const [countRows, rows] = await Promise.all([
    db
      .select({ value: sql<number>`count(*)`.mapWith(Number) })
      .from(ragTraces)
      .leftJoin(conversations, eq(conversations.id, ragTraces.conversationId))
      .where(whereClause),
    db
      .select({
        id: ragTraces.id,
        query: ragTraces.query,
        rewrittenQuery: ragTraces.rewrittenQuery,
        knowledgeBaseId: conversations.knowledgeBaseId,
        knowledgeBaseName: knowledgeBases.name,
        model: ragTraces.model,
        refused: ragTraces.refused,
        costEstimate: ragTraces.costEstimate,
        latencyMs: ragTraces.latencyMs,
        error: ragTraces.error,
        createdAt: ragTraces.createdAt,
      })
      .from(ragTraces)
      .leftJoin(conversations, eq(conversations.id, ragTraces.conversationId))
      .leftJoin(
        knowledgeBases,
        eq(knowledgeBases.id, conversations.knowledgeBaseId),
      )
      .where(whereClause)
      .orderBy(desc(ragTraces.createdAt))
      .limit(limit)
      .offset(offset),
  ]);

  return {
    items: rows.map((r) => ({
      ...r,
      knowledgeBaseId: r.knowledgeBaseId ?? null,
      knowledgeBaseName: r.knowledgeBaseId ? r.knowledgeBaseName ?? null : null,
    })),
    total: countRows[0]?.value ?? 0,
  };
}

/**
 * List recent traces in a workspace (most recent first), for backward-compatible
 * callers. Scoped to the workspace so traces never leak across tenants.
 */
export async function listTraces(
  workspaceId: string,
  limit = 50,
): Promise<TraceListItem[]> {
  const { items } = await listTracesFiltered(workspaceId, { limit, offset: 0 });
  return items;
}
