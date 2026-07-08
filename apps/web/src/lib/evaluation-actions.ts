"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { AuthzError, requireWorkspaceMemberBySlug } from "./authz";
import {
  createEvaluationCase,
  createEvaluationDataset,
  createEvaluationRun,
  deleteEvaluationCase,
  deleteEvaluationDataset,
  type EvaluationRunConfig,
} from "./evaluation";

export type ActionState = { error?: string };

// Parse a textarea of newline/comma-separated entries into a trimmed string[]
// (or null when empty). Used for jsonb list fields on a case.
function parseList(raw: FormDataEntryValue | null): string[] | null {
  const text = String(raw ?? "").trim();
  if (!text) {
    return null;
  }
  const items = text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : null;
}

function parsePositiveInt(
  raw: FormDataEntryValue | null,
): number | undefined {
  const text = String(raw ?? "").trim();
  if (!text) {
    return undefined;
  }
  const parsed = Number.parseInt(text, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

async function resolveWorkspaceId(
  workspaceSlug: string,
): Promise<{ workspaceId: string; actorId: string } | { error: string }> {
  try {
    const ctx = await requireWorkspaceMemberBySlug(workspaceSlug, "ADMIN");
    return { workspaceId: ctx.workspaceId, actorId: ctx.user.id };
  } catch (error) {
    if (error instanceof AuthzError) {
      return { error: error.message };
    }
    throw error;
  }
}

/**
 * Create an evaluation dataset and navigate into it. Requires ADMIN or higher
 * (write operation); membership/role enforced via the slug guard so tenant
 * isolation holds.
 */
export async function createEvaluationDatasetAction(
  workspaceSlug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    return { error: "Dataset name is required" };
  }
  const description = String(formData.get("description") ?? "").trim();
  const knowledgeBaseId = String(formData.get("knowledgeBaseId") ?? "").trim();

  const resolved = await resolveWorkspaceId(workspaceSlug);
  if ("error" in resolved) {
    return resolved;
  }

  let dataset;
  try {
    dataset = await createEvaluationDataset(resolved.workspaceId, {
      name,
      description: description || null,
      knowledgeBaseId: knowledgeBaseId || null,
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to create" };
  }

  revalidatePath(`/${workspaceSlug}/evaluations`);
  redirect(`/${workspaceSlug}/evaluations/${dataset.id}`);
}

/**
 * Delete an evaluation dataset (cascades to its cases, runs and results).
 * Requires ADMIN or higher. Redirects to the list on success.
 */
export async function deleteEvaluationDatasetAction(
  workspaceSlug: string,
  datasetId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  void formData;
  const resolved = await resolveWorkspaceId(workspaceSlug);
  if ("error" in resolved) {
    return resolved;
  }

  const deleted = await deleteEvaluationDataset(resolved.workspaceId, datasetId);
  if (!deleted) {
    return { error: "Dataset not found" };
  }

  revalidatePath(`/${workspaceSlug}/evaluations`);
  redirect(`/${workspaceSlug}/evaluations`);
}

/**
 * Add a case to a dataset. Requires ADMIN or higher. Tenant isolation is
 * enforced twice: the slug guard resolves the workspace, and the dataset is
 * then verified to belong to that workspace before any write.
 */
export async function createEvaluationCaseAction(
  workspaceSlug: string,
  datasetId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const question = String(formData.get("question") ?? "").trim();
  if (!question) {
    return { error: "Question is required" };
  }

  const resolved = await resolveWorkspaceId(workspaceSlug);
  if ("error" in resolved) {
    return resolved;
  }

  let created;
  try {
    created = await createEvaluationCase(resolved.workspaceId, datasetId, {
      question,
      expectedAnswer: String(formData.get("expectedAnswer") ?? "").trim() || null,
      expectedSourceDocuments: parseList(formData.get("expectedSourceDocuments")),
      expectedChunks: parseList(formData.get("expectedChunks")),
      requiredFacts: parseList(formData.get("requiredFacts")),
      tags: parseList(formData.get("tags")),
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to add case" };
  }
  if (!created) {
    return { error: "Dataset not found" };
  }

  revalidatePath(`/${workspaceSlug}/evaluations/${datasetId}`);
  return {};
}

/**
 * Delete a case from a dataset. Requires ADMIN or higher; both dataset and case
 * are verified to belong to the resolved workspace.
 */
export async function deleteEvaluationCaseAction(
  workspaceSlug: string,
  datasetId: string,
  caseId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  void formData;
  const resolved = await resolveWorkspaceId(workspaceSlug);
  if ("error" in resolved) {
    return resolved;
  }

  const deleted = await deleteEvaluationCase(
    resolved.workspaceId,
    datasetId,
    caseId,
  );
  if (!deleted) {
    return { error: "Case not found" };
  }

  revalidatePath(`/${workspaceSlug}/evaluations/${datasetId}`);
  return {};
}

/**
 * Trigger a batch evaluation run for a dataset under a given RAG config: creates
 * a PENDING evaluation_runs row and enqueues a RUN_EVALUATION job for the worker
 * (see createEvaluationRun for the payload contract). Requires ADMIN or higher.
 * Redirects to the new run's detail page on success.
 */
export async function triggerEvaluationRunAction(
  workspaceSlug: string,
  datasetId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const resolved = await resolveWorkspaceId(workspaceSlug);
  if ("error" in resolved) {
    return resolved;
  }

  const config: EvaluationRunConfig = {};
  const chunkSize = parsePositiveInt(formData.get("chunkSize"));
  if (chunkSize !== undefined) {
    config.chunkSize = chunkSize;
  }
  const topK = parsePositiveInt(formData.get("topK"));
  if (topK !== undefined) {
    config.topK = topK;
  }
  const embeddingModel = String(formData.get("embeddingModel") ?? "").trim();
  if (embeddingModel) {
    config.embeddingModel = embeddingModel;
  }
  const reranker = String(formData.get("reranker") ?? "").trim();
  if (reranker) {
    config.reranker = reranker;
  }
  const promptVersion = String(formData.get("promptVersion") ?? "").trim();
  if (promptVersion) {
    config.promptVersion = promptVersion;
  }

  const run = await createEvaluationRun(resolved.workspaceId, datasetId, config);
  if (!run) {
    return { error: "Dataset not found" };
  }

  await recordAudit({
    workspaceId: resolved.workspaceId,
    actorId: resolved.actorId,
    action: AUDIT_ACTIONS.EVALUATION_RUN_TRIGGER,
    target: { type: "evaluation_run", id: run.id },
    metadata: { dataset_id: datasetId, config },
  });
  revalidatePath(`/${workspaceSlug}/evaluations/${datasetId}`);
  redirect(`/${workspaceSlug}/evaluations/${datasetId}/runs/${run.id}`);
}
