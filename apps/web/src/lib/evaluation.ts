import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  answerFeedback,
  evaluationCases,
  evaluationDatasets,
  evaluationResults,
  evaluationRuns,
  ingestionJobs,
  knowledgeBases,
} from "@/db/schema";

export type EvaluationRunStatus =
  (typeof evaluationRuns.$inferSelect)["status"];

export const EVALUATION_RUN_STATUSES: EvaluationRunStatus[] = [
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "FAILED",
];

// ------------------------------------------------------------
// Datasets
// ------------------------------------------------------------

export type EvaluationDatasetSummary = {
  id: string;
  name: string;
  description: string | null;
  knowledgeBaseId: string | null;
  knowledgeBaseName: string | null;
  caseCount: number;
  runCount: number;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * List evaluation datasets in a workspace with case/run counts. Scoped by
 * `workspaceId`; callers must have passed the workspace guard first.
 */
export async function listEvaluationDatasets(
  workspaceId: string,
): Promise<EvaluationDatasetSummary[]> {
  const rows = await db
    .select({
      id: evaluationDatasets.id,
      name: evaluationDatasets.name,
      description: evaluationDatasets.description,
      knowledgeBaseId: evaluationDatasets.knowledgeBaseId,
      knowledgeBaseName: knowledgeBases.name,
      createdAt: evaluationDatasets.createdAt,
      updatedAt: evaluationDatasets.updatedAt,
      caseCount: sql<number>`count(distinct ${evaluationCases.id})`.mapWith(
        Number,
      ),
      runCount: sql<number>`count(distinct ${evaluationRuns.id})`.mapWith(
        Number,
      ),
    })
    .from(evaluationDatasets)
    .leftJoin(
      knowledgeBases,
      eq(knowledgeBases.id, evaluationDatasets.knowledgeBaseId),
    )
    .leftJoin(
      evaluationCases,
      eq(evaluationCases.datasetId, evaluationDatasets.id),
    )
    .leftJoin(evaluationRuns, eq(evaluationRuns.datasetId, evaluationDatasets.id))
    .where(eq(evaluationDatasets.workspaceId, workspaceId))
    .groupBy(evaluationDatasets.id, knowledgeBases.name)
    .orderBy(desc(evaluationDatasets.createdAt));

  return rows.map((row) => ({
    ...row,
    knowledgeBaseName: row.knowledgeBaseId ? row.knowledgeBaseName : null,
  }));
}

/**
 * Fetch one dataset by id, scoped to its workspace. Returns null when it does
 * not exist or belongs to another workspace (tenant isolation).
 */
export async function getEvaluationDataset(
  workspaceId: string,
  datasetId: string,
): Promise<EvaluationDatasetSummary | null> {
  const [row] = await db
    .select({
      id: evaluationDatasets.id,
      name: evaluationDatasets.name,
      description: evaluationDatasets.description,
      knowledgeBaseId: evaluationDatasets.knowledgeBaseId,
      knowledgeBaseName: knowledgeBases.name,
      createdAt: evaluationDatasets.createdAt,
      updatedAt: evaluationDatasets.updatedAt,
      caseCount: sql<number>`count(distinct ${evaluationCases.id})`.mapWith(
        Number,
      ),
      runCount: sql<number>`count(distinct ${evaluationRuns.id})`.mapWith(
        Number,
      ),
    })
    .from(evaluationDatasets)
    .leftJoin(
      knowledgeBases,
      eq(knowledgeBases.id, evaluationDatasets.knowledgeBaseId),
    )
    .leftJoin(
      evaluationCases,
      eq(evaluationCases.datasetId, evaluationDatasets.id),
    )
    .leftJoin(evaluationRuns, eq(evaluationRuns.datasetId, evaluationDatasets.id))
    .where(
      and(
        eq(evaluationDatasets.id, datasetId),
        eq(evaluationDatasets.workspaceId, workspaceId),
      ),
    )
    .groupBy(evaluationDatasets.id, knowledgeBases.name)
    .limit(1);

  if (!row) {
    return null;
  }
  return {
    ...row,
    knowledgeBaseName: row.knowledgeBaseId ? row.knowledgeBaseName : null,
  };
}

export type CreateEvaluationDatasetParams = {
  name: string;
  description?: string | null;
  knowledgeBaseId?: string | null;
};

/**
 * Create an evaluation dataset in a workspace. When a knowledge base is given
 * it is verified to belong to the same workspace (so a dataset can never point
 * at another tenant's KB). Caller handles authorization.
 */
export async function createEvaluationDataset(
  workspaceId: string,
  params: CreateEvaluationDatasetParams,
): Promise<EvaluationDatasetSummary> {
  const name = params.name.trim();
  if (!name) {
    throw new Error("Dataset name cannot be empty");
  }
  const description = params.description?.trim() || null;

  let knowledgeBaseId: string | null = null;
  if (params.knowledgeBaseId) {
    const [kb] = await db
      .select({ id: knowledgeBases.id, name: knowledgeBases.name })
      .from(knowledgeBases)
      .where(
        and(
          eq(knowledgeBases.id, params.knowledgeBaseId),
          eq(knowledgeBases.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!kb) {
      throw new Error("Knowledge base not found in this workspace");
    }
    knowledgeBaseId = kb.id;
  }

  const [row] = await db
    .insert(evaluationDatasets)
    .values({ workspaceId, name, description, knowledgeBaseId })
    .returning();

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    knowledgeBaseId: row.knowledgeBaseId,
    knowledgeBaseName: null,
    caseCount: 0,
    runCount: 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Delete a dataset (cascades to its cases, runs and results). Scoped by
 * `workspaceId`. Returns true when a row was deleted.
 */
export async function deleteEvaluationDataset(
  workspaceId: string,
  datasetId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(evaluationDatasets)
    .where(
      and(
        eq(evaluationDatasets.id, datasetId),
        eq(evaluationDatasets.workspaceId, workspaceId),
      ),
    )
    .returning({ id: evaluationDatasets.id });
  return deleted.length > 0;
}

// ------------------------------------------------------------
// Cases
// ------------------------------------------------------------

export type EvaluationCaseRecord = {
  id: string;
  datasetId: string;
  question: string;
  expectedAnswer: string | null;
  expectedSourceDocuments: string[] | null;
  expectedChunks: string[] | null;
  requiredFacts: string[] | null;
  tags: string[] | null;
  sourceFeedbackId?: string | null;
  createdAt: Date;
};

/**
 * List cases for a dataset, scoped to the workspace via the dataset. Returns an
 * empty array when the dataset does not exist in this workspace.
 */
export async function listEvaluationCases(
  workspaceId: string,
  datasetId: string,
): Promise<EvaluationCaseRecord[]> {
  const dataset = await getEvaluationDataset(workspaceId, datasetId);
  if (!dataset) {
    return [];
  }
  const rows = await db
    .select({
      id: evaluationCases.id,
      datasetId: evaluationCases.datasetId,
      question: evaluationCases.question,
      expectedAnswer: evaluationCases.expectedAnswer,
      expectedSourceDocuments: evaluationCases.expectedSourceDocuments,
      expectedChunks: evaluationCases.expectedChunks,
      requiredFacts: evaluationCases.requiredFacts,
      tags: evaluationCases.tags,
      sourceFeedbackId: answerFeedback.id,
      createdAt: evaluationCases.createdAt,
    })
    .from(evaluationCases)
    .leftJoin(
      answerFeedback,
      eq(answerFeedback.promotedCaseId, evaluationCases.id),
    )
    .where(eq(evaluationCases.datasetId, datasetId))
    .orderBy(evaluationCases.createdAt);

  return rows.map((row) => ({
    ...row,
    sourceFeedbackId: row.sourceFeedbackId ?? null,
  }));
}

export type CreateEvaluationCaseParams = {
  question: string;
  expectedAnswer?: string | null;
  expectedSourceDocuments?: string[] | null;
  expectedChunks?: string[] | null;
  requiredFacts?: string[] | null;
  tags?: string[] | null;
};

/**
 * Add a case to a dataset. Verifies the dataset belongs to `workspaceId` first
 * (tenant isolation). Returns null when the dataset is absent in this workspace.
 */
export async function createEvaluationCase(
  workspaceId: string,
  datasetId: string,
  params: CreateEvaluationCaseParams,
): Promise<EvaluationCaseRecord | null> {
  const dataset = await getEvaluationDataset(workspaceId, datasetId);
  if (!dataset) {
    return null;
  }
  const question = params.question.trim();
  if (!question) {
    throw new Error("Question cannot be empty");
  }

  const [row] = await db
    .insert(evaluationCases)
    .values({
      datasetId,
      question,
      expectedAnswer: params.expectedAnswer?.trim() || null,
      expectedSourceDocuments: params.expectedSourceDocuments ?? null,
      expectedChunks: params.expectedChunks ?? null,
      requiredFacts: params.requiredFacts ?? null,
      tags: params.tags ?? null,
    })
    .returning();

  // Touch the dataset's updated_at so the list reflects recent edits.
  await db
    .update(evaluationDatasets)
    .set({ updatedAt: new Date() })
    .where(eq(evaluationDatasets.id, datasetId));

  return row;
}

/**
 * Delete a case from a dataset, verifying both belong to `workspaceId`. Returns
 * true when a row was deleted.
 */
export async function deleteEvaluationCase(
  workspaceId: string,
  datasetId: string,
  caseId: string,
): Promise<boolean> {
  const dataset = await getEvaluationDataset(workspaceId, datasetId);
  if (!dataset) {
    return false;
  }
  const deleted = await db
    .delete(evaluationCases)
    .where(
      and(
        eq(evaluationCases.id, caseId),
        eq(evaluationCases.datasetId, datasetId),
      ),
    )
    .returning({ id: evaluationCases.id });
  return deleted.length > 0;
}

// ------------------------------------------------------------
// Runs + the RUN_EVALUATION enqueue contract
// ------------------------------------------------------------

export type EvaluationRunConfig = {
  // Common RAG knobs compared across runs. All optional; the worker applies
  // sensible defaults when absent.
  chunkSize?: number;
  topK?: number;
  retrievalMode?: "hybrid" | "vector" | "keyword";
  queryRewrite?: boolean;
  embeddingModel?: string;
  reranker?: string;
  promptVersion?: string;
  useLlmJudge?: boolean;
  [key: string]: unknown;
};

export type EvaluationRunSummary = {
  id: string;
  datasetId: string;
  status: EvaluationRunStatus;
  config: EvaluationRunConfig | null;
  summaryMetrics: Record<string, unknown> | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
};

/**
 * Create a PENDING evaluation run for a dataset and enqueue a RUN_EVALUATION job
 * for the Python worker (T7.3). Both writes happen in one transaction so a run
 * is never left without its job (or vice versa).
 *
 * Enqueue contract (mvp-plan §3.2): a row is inserted into `ingestion_jobs` with
 *   job_type = 'RUN_EVALUATION'
 *   payload  = { evaluation_run_id: <evaluation_runs.id> }
 * document_id stays null (evaluation jobs are not document-scoped). The worker
 * loads the run by id, reads its dataset_id + config + workspace_id, evaluates
 * every case (reusing the single RAG core), writes evaluation_results and fills
 * evaluation_runs.summary_metrics / status / started_at / finished_at.
 *
 * Verifies the dataset belongs to `workspaceId` first. Returns null when the
 * dataset is absent in this workspace (tenant isolation).
 */
export async function createEvaluationRun(
  workspaceId: string,
  datasetId: string,
  config: EvaluationRunConfig,
): Promise<EvaluationRunSummary | null> {
  const dataset = await getEvaluationDataset(workspaceId, datasetId);
  if (!dataset) {
    return null;
  }

  return db.transaction(async (tx) => {
    const [run] = await tx
      .insert(evaluationRuns)
      .values({
        workspaceId,
        datasetId,
        config,
        status: "PENDING",
      })
      .returning();

    await tx.insert(ingestionJobs).values({
      jobType: "RUN_EVALUATION",
      payload: { evaluation_run_id: run.id },
    });

    return {
      id: run.id,
      datasetId: run.datasetId,
      status: run.status,
      config: (run.config as EvaluationRunConfig | null) ?? null,
      summaryMetrics: run.summaryMetrics ?? null,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      createdAt: run.createdAt,
    };
  });
}

/**
 * List runs in a workspace (most recent first), optionally filtered to one
 * dataset. Scoped by `workspaceId`.
 */
export async function listEvaluationRuns(
  workspaceId: string,
  datasetId?: string | null,
): Promise<EvaluationRunSummary[]> {
  const conditions = [eq(evaluationRuns.workspaceId, workspaceId)];
  if (datasetId) {
    conditions.push(eq(evaluationRuns.datasetId, datasetId));
  }
  const rows = await db
    .select()
    .from(evaluationRuns)
    .where(and(...conditions))
    .orderBy(desc(evaluationRuns.createdAt));

  return rows.map((run) => ({
    id: run.id,
    datasetId: run.datasetId,
    status: run.status,
    config: (run.config as EvaluationRunConfig | null) ?? null,
    summaryMetrics: run.summaryMetrics ?? null,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    createdAt: run.createdAt,
  }));
}

/**
 * Fetch one run by id, scoped to its workspace. Returns null when absent or in
 * another workspace.
 */
export async function getEvaluationRun(
  workspaceId: string,
  runId: string,
): Promise<EvaluationRunSummary | null> {
  const [run] = await db
    .select()
    .from(evaluationRuns)
    .where(
      and(
        eq(evaluationRuns.id, runId),
        eq(evaluationRuns.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (!run) {
    return null;
  }
  return {
    id: run.id,
    datasetId: run.datasetId,
    status: run.status,
    config: (run.config as EvaluationRunConfig | null) ?? null,
    summaryMetrics: run.summaryMetrics ?? null,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    createdAt: run.createdAt,
  };
}

export type EvaluationResultRecord = {
  id: string;
  runId: string;
  caseId: string;
  question: string;
  retrievalHit: string | null;
  citationAccuracy: string | null;
  correctness: string | null;
  groundedness: string | null;
  latencyMs: number | null;
  costEstimate: string | null;
  raw: Record<string, unknown> | null;
  createdAt: Date;
};

/**
 * List per-case results for a run, joined to the case question. Scoped to the
 * workspace via the run; returns an empty array when the run is absent here.
 */
export async function listEvaluationResults(
  workspaceId: string,
  runId: string,
): Promise<EvaluationResultRecord[]> {
  const run = await getEvaluationRun(workspaceId, runId);
  if (!run) {
    return [];
  }
  return db
    .select({
      id: evaluationResults.id,
      runId: evaluationResults.runId,
      caseId: evaluationResults.caseId,
      question: evaluationCases.question,
      retrievalHit: evaluationResults.retrievalHit,
      citationAccuracy: evaluationResults.citationAccuracy,
      correctness: evaluationResults.correctness,
      groundedness: evaluationResults.groundedness,
      latencyMs: evaluationResults.latencyMs,
      costEstimate: evaluationResults.costEstimate,
      raw: evaluationResults.raw,
      createdAt: evaluationResults.createdAt,
    })
    .from(evaluationResults)
    .innerJoin(evaluationCases, eq(evaluationResults.caseId, evaluationCases.id))
    .where(eq(evaluationResults.runId, runId))
    .orderBy(evaluationResults.createdAt);
}
