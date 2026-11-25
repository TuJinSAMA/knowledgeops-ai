"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { AUDIT_ACTIONS, recordAudit } from "./audit";
import {
  type ActionErrorCode,
  type ActionState,
  withLocalePath,
} from "./action-errors";
import { AuthzError, requireWorkspaceMemberBySlug } from "./authz";
import {
  createEvaluationCase,
  createEvaluationDataset,
  createEvaluationRun,
  deleteEvaluationCase,
  deleteEvaluationDataset,
  type EvaluationRunConfig,
  getEvaluationDataset,
  getEvaluationRun,
  updateEvaluationCase,
} from "./evaluation";
import {
  getKnowledgeBase,
  updateKnowledgeBaseRagConfig,
} from "./knowledge-base";
import { parseRagConfigFromFormData, sanitizeRagConfig } from "./rag-config";

export type { ActionState } from "./action-errors";

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

function parseCombinedDocumentIds(formData: FormData): string[] | null {
  const checked = formData
    .getAll("selectedDocumentIds")
    .map((v) => String(v).trim())
    .filter(Boolean);
  const manual = parseList(formData.get("expectedSourceDocuments")) ?? [];
  const merged = [...new Set([...checked, ...manual])];
  return merged.length > 0 ? merged : null;
}

async function resolveWorkspaceId(
  workspaceSlug: string,
): Promise<
  { workspaceId: string; actorId: string } | { errorCode: ActionErrorCode }
> {
  try {
    const ctx = await requireWorkspaceMemberBySlug(workspaceSlug, "ADMIN");
    return { workspaceId: ctx.workspaceId, actorId: ctx.user.id };
  } catch (error) {
    if (error instanceof AuthzError) {
      return { errorCode: "AUTHORIZATION_FAILED" };
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
    return { errorCode: "DATASET_NAME_REQUIRED" };
  }
  const description = String(formData.get("description") ?? "").trim();
  const knowledgeBaseId = String(formData.get("knowledgeBaseId") ?? "").trim();

  const resolved = await resolveWorkspaceId(workspaceSlug);
  if ("errorCode" in resolved) {
    return resolved;
  }

  let dataset;
  try {
    dataset = await createEvaluationDataset(resolved.workspaceId, {
      name,
      description: description || null,
      knowledgeBaseId: knowledgeBaseId || null,
    });
  } catch {
    return { errorCode: "EVALUATION_CREATE_FAILED" };
  }

  revalidatePath(await withLocalePath(`/${workspaceSlug}/evaluations`));
  redirect(await withLocalePath(`/${workspaceSlug}/evaluations/${dataset.id}`));
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
  if ("errorCode" in resolved) {
    return resolved;
  }

  const deleted = await deleteEvaluationDataset(resolved.workspaceId, datasetId);
  if (!deleted) {
    return { errorCode: "DATASET_NOT_FOUND" };
  }

  revalidatePath(await withLocalePath(`/${workspaceSlug}/evaluations`));
  redirect(await withLocalePath(`/${workspaceSlug}/evaluations`));
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
    return { errorCode: "EVALUATION_CASE_QUESTION_REQUIRED" };
  }

  const resolved = await resolveWorkspaceId(workspaceSlug);
  if ("errorCode" in resolved) {
    return resolved;
  }

  let created;
  try {
    created = await createEvaluationCase(resolved.workspaceId, datasetId, {
      question,
      expectedAnswer: String(formData.get("expectedAnswer") ?? "").trim() || null,
      expectedSourceDocuments: parseCombinedDocumentIds(formData),
      expectedChunks: parseList(formData.get("expectedChunks")),
      requiredFacts: parseList(formData.get("requiredFacts")),
      tags: parseList(formData.get("tags")),
    });
  } catch {
    return { errorCode: "EVALUATION_CASE_CREATE_FAILED" };
  }
  if (!created) {
    return { errorCode: "DATASET_NOT_FOUND" };
  }

  revalidatePath(
    await withLocalePath(`/${workspaceSlug}/evaluations/${datasetId}`),
  );
  return { ok: true };
}

/**
 * Update an existing evaluation case in-place, preserving its `id` and any
 * linked feedback/trace provenance. Requires ADMIN or higher.
 */
export async function updateEvaluationCaseAction(
  workspaceSlug: string,
  datasetId: string,
  caseId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const question = String(formData.get("question") ?? "").trim();
  if (!question) {
    return { errorCode: "EVALUATION_CASE_QUESTION_REQUIRED" };
  }

  const resolved = await resolveWorkspaceId(workspaceSlug);
  if ("errorCode" in resolved) {
    return resolved;
  }

  let updated;
  try {
    updated = await updateEvaluationCase(
      resolved.workspaceId,
      datasetId,
      caseId,
      {
        question,
        expectedAnswer:
          String(formData.get("expectedAnswer") ?? "").trim() || null,
        expectedSourceDocuments: parseCombinedDocumentIds(formData),
        expectedChunks: parseList(formData.get("expectedChunks")),
        requiredFacts: parseList(formData.get("requiredFacts")),
        tags: parseList(formData.get("tags")),
      },
    );
  } catch {
    return { errorCode: "EVALUATION_CASE_UPDATE_FAILED" };
  }

  if (!updated) {
    return { errorCode: "EVALUATION_CASE_NOT_FOUND" };
  }

  await recordAudit({
    workspaceId: resolved.workspaceId,
    actorId: resolved.actorId,
    action: AUDIT_ACTIONS.EVALUATION_CASE_UPDATE,
    target: { type: "evaluation_case", id: caseId },
    metadata: { dataset_id: datasetId },
  });

  revalidatePath(
    await withLocalePath(`/${workspaceSlug}/evaluations/${datasetId}`),
  );
  return { ok: true };
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
  if ("errorCode" in resolved) {
    return resolved;
  }

  const deleted = await deleteEvaluationCase(
    resolved.workspaceId,
    datasetId,
    caseId,
  );
  if (!deleted) {
    return { errorCode: "EVALUATION_CASE_NOT_FOUND" };
  }

  revalidatePath(
    await withLocalePath(`/${workspaceSlug}/evaluations/${datasetId}`),
  );
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
  const parsed = parseRagConfigFromFormData(formData);
  if ("errorCode" in parsed) {
    return { errorCode: parsed.errorCode };
  }

  const resolved = await resolveWorkspaceId(workspaceSlug);
  if ("errorCode" in resolved) {
    return resolved;
  }

  const config: EvaluationRunConfig = { ...parsed.config };
  const useLlmJudge = String(formData.get("useLlmJudge") ?? "").trim();
  if (useLlmJudge === "on" || useLlmJudge === "true") {
    config.useLlmJudge = true;
  }

  const run = await createEvaluationRun(resolved.workspaceId, datasetId, config);
  if (!run) {
    return { errorCode: "DATASET_NOT_FOUND" };
  }

  await recordAudit({
    workspaceId: resolved.workspaceId,
    actorId: resolved.actorId,
    action: AUDIT_ACTIONS.EVALUATION_RUN_TRIGGER,
    target: { type: "evaluation_run", id: run.id },
    metadata: { dataset_id: datasetId, config },
  });
  revalidatePath(
    await withLocalePath(`/${workspaceSlug}/evaluations/${datasetId}`),
  );
  redirect(
    await withLocalePath(
      `/${workspaceSlug}/evaluations/${datasetId}/runs/${run.id}`,
    ),
  );
}

/**
 * Promote a completed evaluation run's runtime RAG configuration to be the
 * live configuration on the dataset's bound knowledge base. Strips
 * evaluation-only flags (`useLlmJudge`) and records an audit entry.
 */
export async function promoteEvaluationRunConfigAction(
  workspaceSlug: string,
  datasetId: string,
  runId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  void formData;
  const resolved = await resolveWorkspaceId(workspaceSlug);
  if ("errorCode" in resolved) {
    return resolved;
  }

  const [dataset, run] = await Promise.all([
    getEvaluationDataset(resolved.workspaceId, datasetId),
    getEvaluationRun(resolved.workspaceId, runId),
  ]);
  if (!dataset) {
    return { errorCode: "DATASET_NOT_FOUND" };
  }
  if (!run || run.datasetId !== datasetId) {
    return { errorCode: "EVALUATION_RUN_NOT_FOUND" };
  }
  if (!dataset.knowledgeBaseId) {
    return { errorCode: "DATASET_NO_KNOWLEDGE_BASE" };
  }

  const kb = await getKnowledgeBase(
    resolved.workspaceId,
    dataset.knowledgeBaseId,
  );
  if (!kb) {
    return { errorCode: "KNOWLEDGE_BASE_NOT_FOUND" };
  }

  const sanitized = sanitizeRagConfig(run.config);
  const nextConfig = Object.keys(sanitized).length > 0 ? sanitized : null;
  const updated = await updateKnowledgeBaseRagConfig(
    resolved.workspaceId,
    kb.id,
    nextConfig,
  );
  if (!updated) {
    return { errorCode: "KNOWLEDGE_BASE_NOT_FOUND" };
  }

  await recordAudit({
    workspaceId: resolved.workspaceId,
    actorId: resolved.actorId,
    action: AUDIT_ACTIONS.KNOWLEDGE_BASE_UPDATE_CONFIG,
    target: { type: "knowledge_base", id: kb.id },
    metadata: {
      name: kb.name,
      previous_config: kb.ragConfig ?? null,
      next_config: nextConfig,
      source: "evaluation_run",
      dataset_id: dataset.id,
      run_id: run.id,
    },
  });

  const [datasetPath, runPath, comparePath, kbPath] = await Promise.all([
    withLocalePath(`/${workspaceSlug}/evaluations/${datasetId}`),
    withLocalePath(`/${workspaceSlug}/evaluations/${datasetId}/runs/${runId}`),
    withLocalePath(`/${workspaceSlug}/evaluations/${datasetId}/compare`),
    withLocalePath(`/${workspaceSlug}/knowledge-bases/${kb.id}`),
  ]);
  revalidatePath(datasetPath);
  revalidatePath(runPath);
  revalidatePath(comparePath);
  revalidatePath(kbPath);

  return { ok: true };
}
