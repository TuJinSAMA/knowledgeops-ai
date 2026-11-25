"use server";

import { revalidatePath } from "next/cache";

import { type ActionState, withLocalePath } from "./action-errors";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { AuthzError, requireWorkspaceMemberBySlug } from "./authz";
import { promoteTraceToCase } from "./trace";

export type PromoteTraceActionState = ActionState & {
  caseId?: string;
  datasetId?: string;
  datasetName?: string;
};

function parseLinesOrCommas(raw: FormDataEntryValue | null): string[] | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const items = text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : null;
}

/**
 * Promote a RAG trace into a golden/regression evaluation case inside an
 * existing or newly created dataset. Requires ADMIN or higher.
 */
export async function promoteTraceToCaseAction(
  workspaceSlug: string,
  traceId: string,
  _prev: PromoteTraceActionState,
  formData: FormData,
): Promise<PromoteTraceActionState> {
  const question = String(formData.get("question") ?? "").trim();
  if (!question) {
    return { errorCode: "EVALUATION_CASE_QUESTION_REQUIRED" };
  }

  let workspaceId: string;
  let actorId: string;
  try {
    const ctx = await requireWorkspaceMemberBySlug(workspaceSlug, "ADMIN");
    workspaceId = ctx.workspaceId;
    actorId = ctx.user.id;
  } catch (error) {
    if (error instanceof AuthzError) {
      return { errorCode: "AUTHORIZATION_FAILED" };
    }
    throw error;
  }

  const checkedDocs = formData
    .getAll("selectedDocumentIds")
    .map((v) => String(v).trim())
    .filter(Boolean);
  const manualDocs = parseLinesOrCommas(formData.get("expectedSourceDocuments")) ?? [];
  const mergedDocs = [...new Set([...checkedDocs, ...manualDocs])];

  const result = await promoteTraceToCase(workspaceId, traceId, {
    datasetId: String(formData.get("datasetId") ?? "").trim() || null,
    newDatasetName: String(formData.get("newDatasetName") ?? "").trim() || null,
    question,
    expectedAnswer:
      String(formData.get("expectedAnswer") ?? "").trim() || null,
    expectedSourceDocuments: mergedDocs.length > 0 ? mergedDocs : null,
    requiredFactsList: parseLinesOrCommas(formData.get("requiredFacts")),
    tags: parseLinesOrCommas(formData.get("tags")),
  });

  if (!result.ok) {
    return { errorCode: result.reason };
  }

  await recordAudit({
    workspaceId,
    actorId,
    action: AUDIT_ACTIONS.TRACE_PROMOTE_CASE,
    target: { type: "evaluation_case", id: result.caseId },
    metadata: {
      trace_id: traceId,
      dataset_id: result.datasetId,
      case_id: result.caseId,
    },
  });

  const [tracePath, datasetPath] = await Promise.all([
    withLocalePath(`/${workspaceSlug}/traces/${traceId}`),
    withLocalePath(`/${workspaceSlug}/evaluations/${result.datasetId}`),
  ]);
  revalidatePath(tracePath);
  revalidatePath(datasetPath);

  return {
    ok: true,
    caseId: result.caseId,
    datasetId: result.datasetId,
    datasetName: result.datasetName,
  };
}
