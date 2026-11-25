import { and, desc, eq, gte, ne, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  answerFeedback,
  conversations,
  documentChunks,
  documents,
  evaluationRuns,
  knowledgeBases,
  messages,
  ragTraces,
} from "@/db/schema";

/**
 * Workspace-level metrics for the operations dashboard. Every aggregate below is
 * scoped to a single workspace (directly via workspace_id, or transitively via a
 * join to knowledge_bases) so numbers never bleed across tenants.
 */
export type DashboardMetrics = {
  documentCount: number;
  chunkCount: number;
  conversationMessageCount: number;
  answerCount: number;
  avgLatencyMs: number | null;
  totalTokens: number;
  totalCost: number;
  feedback: FeedbackDistribution;
  recentRuns: DashboardRunSummary[];
};

export type FeedbackDistribution = {
  helpful: number;
  notHelpful: number;
  total: number;
};

export type DashboardRunSummary = {
  id: string;
  datasetId: string;
  status: (typeof evaluationRuns.$inferSelect)["status"];
  summaryMetrics: Record<string, unknown> | null;
  createdAt: Date;
};

/**
 * Count documents + chunks in a workspace. Both queries join up to
 * knowledge_bases and filter on workspace_id so they stay tenant-isolated.
 */
export async function getKnowledgeStats(
  workspaceId: string,
): Promise<{ documentCount: number; chunkCount: number }> {
  const [docRow] = await db
    .select({ value: sql<number>`count(${documents.id})`.mapWith(Number) })
    .from(documents)
    .innerJoin(knowledgeBases, eq(documents.knowledgeBaseId, knowledgeBases.id))
    .where(eq(knowledgeBases.workspaceId, workspaceId));

  const [chunkRow] = await db
    .select({ value: sql<number>`count(${documentChunks.id})`.mapWith(Number) })
    .from(documentChunks)
    .innerJoin(documents, eq(documentChunks.documentId, documents.id))
    .innerJoin(knowledgeBases, eq(documents.knowledgeBaseId, knowledgeBases.id))
    .where(eq(knowledgeBases.workspaceId, workspaceId));

  return {
    documentCount: docRow?.value ?? 0,
    chunkCount: chunkRow?.value ?? 0,
  };
}

/**
 * Aggregate trace stats for a workspace: answer count, average end-to-end
 * latency, cumulative token usage and estimated cost. Scoped by workspace_id.
 */
export async function getTraceStats(workspaceId: string): Promise<{
  answerCount: number;
  avgLatencyMs: number | null;
  totalTokens: number;
  totalCost: number;
}> {
  const [row] = await db
    .select({
      answerCount: sql<number>`count(*)`.mapWith(Number),
      avgLatency: sql<string | null>`avg(${ragTraces.latencyMs})`,
      totalTokens: sql<number>`coalesce(sum((${ragTraces.tokenUsage} ->> 'total_tokens')::numeric), 0)`.mapWith(
        Number,
      ),
      totalCost: sql<number>`coalesce(sum(${ragTraces.costEstimate}), 0)`.mapWith(
        Number,
      ),
    })
    .from(ragTraces)
    .where(eq(ragTraces.workspaceId, workspaceId));

  const avgLatencyMs =
    row?.avgLatency != null && row.avgLatency !== ""
      ? Math.round(Number(row.avgLatency))
      : null;

  return {
    answerCount: row?.answerCount ?? 0,
    avgLatencyMs: Number.isNaN(avgLatencyMs as number) ? null : avgLatencyMs,
    totalTokens: row?.totalTokens ?? 0,
    totalCost: row?.totalCost ?? 0,
  };
}

/**
 * Count all chat messages (questions + answers) in a workspace. Joins
 * messages -> conversations so the conversation's workspace_id filter applies.
 */
export async function getMessageCount(workspaceId: string): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)`.mapWith(Number) })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(eq(conversations.workspaceId, workspaceId));
  return row?.value ?? 0;
}

/**
 * Feedback distribution (helpful vs. not helpful) for a workspace, scoped by
 * workspace_id.
 */
export async function getFeedbackDistribution(
  workspaceId: string,
): Promise<FeedbackDistribution> {
  const rows = await db
    .select({
      rating: answerFeedback.rating,
      count: sql<number>`count(*)`.mapWith(Number),
    })
    .from(answerFeedback)
    .where(eq(answerFeedback.workspaceId, workspaceId))
    .groupBy(answerFeedback.rating);

  let helpful = 0;
  let notHelpful = 0;
  for (const row of rows) {
    if (row.rating === "HELPFUL") {
      helpful = row.count;
    } else if (row.rating === "NOT_HELPFUL") {
      notHelpful = row.count;
    }
  }
  return { helpful, notHelpful, total: helpful + notHelpful };
}

/**
 * Most recent evaluation runs in a workspace (for the dashboard overview).
 * Scoped by workspace_id.
 */
export async function getRecentEvaluationRuns(
  workspaceId: string,
  limit = 5,
): Promise<DashboardRunSummary[]> {
  const rows = await db
    .select({
      id: evaluationRuns.id,
      datasetId: evaluationRuns.datasetId,
      status: evaluationRuns.status,
      summaryMetrics: evaluationRuns.summaryMetrics,
      createdAt: evaluationRuns.createdAt,
    })
    .from(evaluationRuns)
    .where(eq(evaluationRuns.workspaceId, workspaceId))
    .orderBy(desc(evaluationRuns.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    datasetId: row.datasetId,
    status: row.status,
    summaryMetrics: row.summaryMetrics ?? null,
    createdAt: row.createdAt,
  }));
}

/**
 * Compose all dashboard metrics for a workspace in parallel. Tenant isolation is
 * guaranteed by each underlying query filtering on workspace_id (directly or via
 * a knowledge_bases join).
 */
export async function getDashboardMetrics(
  workspaceId: string,
): Promise<DashboardMetrics> {
  const [knowledge, traceStats, messageCount, feedback, recentRuns] =
    await Promise.all([
      getKnowledgeStats(workspaceId),
      getTraceStats(workspaceId),
      getMessageCount(workspaceId),
      getFeedbackDistribution(workspaceId),
      getRecentEvaluationRuns(workspaceId),
    ]);

  return {
    documentCount: knowledge.documentCount,
    chunkCount: knowledge.chunkCount,
    conversationMessageCount: messageCount,
    answerCount: traceStats.answerCount,
    avgLatencyMs: traceStats.avgLatencyMs,
    totalTokens: traceStats.totalTokens,
    totalCost: traceStats.totalCost,
    feedback,
    recentRuns,
  };
}

// ------------------------------------------------------------
// Proactive Knowledge Gap Insights (Module 5B)
// ------------------------------------------------------------

export type RawRefusedTraceRow = {
  id: string;
  query: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  createdAt: Date;
};

export type RefusedQueryCluster = {
  normalizedQuery: string;
  sampleQuery: string;
  count: number;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  latestTraceId: string;
  lastSeenAt: Date;
};

export type KnowledgeGapSummary = {
  windowDays: number;
  totalRefusedCount: number;
  unresolvedMissingKnowledgeCount: number;
  topRefusedQueries: RefusedQueryCluster[];
};

/**
 * Normalize a user question into a case/punctuation-insensitive clustering key
 * (preserving CJK characters, ASCII alphanumerics, and single spaces).
 */
export function normalizeGapQueryKey(query: string): string {
  return query
    .trim()
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, " ")
    .trim();
}

/**
 * Group recent refused trace rows (ordered newest-first) by knowledge base and
 * normalized question text, returning the top-N highest-frequency blind spots.
 */
export function clusterRefusedTraces(
  rows: RawRefusedTraceRow[],
  limit = 8,
): RefusedQueryCluster[] {
  const clusters = new Map<string, RefusedQueryCluster>();

  for (const row of rows) {
    const normalized = normalizeGapQueryKey(row.query);
    if (!normalized) {
      continue;
    }
    const key = `${row.knowledgeBaseId}::${normalized}`;
    const existing = clusters.get(key);
    if (existing) {
      existing.count += 1;
      if (row.createdAt.getTime() > existing.lastSeenAt.getTime()) {
        existing.lastSeenAt = row.createdAt;
        existing.sampleQuery = row.query.trim();
        existing.latestTraceId = row.id;
      }
    } else {
      clusters.set(key, {
        normalizedQuery: normalized,
        sampleQuery: row.query.trim(),
        count: 1,
        knowledgeBaseId: row.knowledgeBaseId,
        knowledgeBaseName: row.knowledgeBaseName,
        latestTraceId: row.id,
        lastSeenAt: row.createdAt,
      });
    }
  }

  return Array.from(clusters.values())
    .sort(
      (a, b) =>
        b.count - a.count || b.lastSeenAt.getTime() - a.lastSeenAt.getTime(),
    )
    .slice(0, Math.max(1, limit));
}

/**
 * Surface recent knowledge blind spots in a workspace:
 *   1. Top repeated questions where the RAG assistant refused (`refused = true`)
 *   2. Count of unresolved `MISSING_KNOWLEDGE` user feedback reports
 * Strictly scoped by `workspaceId`.
 */
export async function getKnowledgeGaps(
  workspaceId: string,
  options?: { windowDays?: number; limit?: number },
): Promise<KnowledgeGapSummary> {
  const windowDays = Math.max(1, options?.windowDays ?? 30);
  const limit = Math.max(1, options?.limit ?? 8);
  const since = new Date(Date.now() - windowDays * 86_400_000);

  const [refusedRows, missingFeedbackRows] = await Promise.all([
    db
      .select({
        id: ragTraces.id,
        query: ragTraces.query,
        knowledgeBaseId: knowledgeBases.id,
        knowledgeBaseName: knowledgeBases.name,
        createdAt: ragTraces.createdAt,
      })
      .from(ragTraces)
      .innerJoin(conversations, eq(conversations.id, ragTraces.conversationId))
      .innerJoin(
        knowledgeBases,
        eq(knowledgeBases.id, conversations.knowledgeBaseId),
      )
      .where(
        and(
          eq(ragTraces.workspaceId, workspaceId),
          eq(ragTraces.refused, true),
          gte(ragTraces.createdAt, since),
        ),
      )
      .orderBy(desc(ragTraces.createdAt))
      .limit(500),
    db
      .select({ value: sql<number>`count(*)`.mapWith(Number) })
      .from(answerFeedback)
      .where(
        and(
          eq(answerFeedback.workspaceId, workspaceId),
          eq(answerFeedback.reportType, "MISSING_KNOWLEDGE"),
          ne(answerFeedback.reviewStatus, "RESOLVED"),
        ),
      ),
  ]);

  return {
    windowDays,
    totalRefusedCount: refusedRows.length,
    unresolvedMissingKnowledgeCount: missingFeedbackRows[0]?.value ?? 0,
    topRefusedQueries: clusterRefusedTraces(refusedRows, limit),
  };
}
