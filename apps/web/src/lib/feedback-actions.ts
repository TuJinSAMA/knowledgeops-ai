"use server";

import { revalidatePath } from "next/cache";

import {
  type ActionErrorCode,
  type ActionState,
  withLocalePath,
} from "./action-errors";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { AuthzError, requireWorkspaceMemberBySlug } from "./authz";
import {
  COMMENT_MAX,
  FEEDBACK_RATINGS,
  FEEDBACK_REPORT_TYPES,
  FEEDBACK_REVIEW_STATUSES,
  type FeedbackRating,
  type FeedbackRecord,
  type FeedbackReportType,
  type FeedbackReviewStatus,
  getMessageFeedbackContext,
  promoteFeedbackToCase,
  updateFeedbackReview,
  upsertFeedback,
} from "./feedback";

export type SubmitFeedbackInput = {
  workspaceSlug: string;
  messageId: string;
  rating: FeedbackRating;
  reportType?: FeedbackReportType | null;
  comment?: string | null;
};

export type SubmitFeedbackResult = {
  errorCode?: ActionErrorCode;
  errorParams?: Record<string, string | number>;
  feedback?: FeedbackRecord;
};

/**
 * Submit (or update) the current user's feedback on an assistant answer.
 * Requires MEMBER or higher. Tenant isolation is enforced twice: the slug guard
 * resolves the workspace the caller belongs to, and the message is then
 * verified to belong to that same workspace before any write. The answer's
 * trace is linked server-side rather than trusting a client-supplied id.
 */
export async function submitFeedbackAction(
  input: SubmitFeedbackInput,
): Promise<SubmitFeedbackResult> {
  if (!input.messageId) {
    return { errorCode: "FEEDBACK_MESSAGE_REQUIRED" };
  }
  if (!FEEDBACK_RATINGS.includes(input.rating)) {
    return { errorCode: "FEEDBACK_RATING_INVALID" };
  }
  if (
    input.reportType != null &&
    !FEEDBACK_REPORT_TYPES.includes(input.reportType)
  ) {
    return { errorCode: "FEEDBACK_REPORT_TYPE_INVALID" };
  }
  const comment = input.comment?.trim() ? input.comment.trim() : null;
  if (comment && comment.length > COMMENT_MAX) {
    return {
      errorCode: "FEEDBACK_COMMENT_TOO_LONG",
      errorParams: { max: COMMENT_MAX },
    };
  }

  let workspaceId: string;
  let userId: string;
  try {
    const ctx = await requireWorkspaceMemberBySlug(input.workspaceSlug, "MEMBER");
    workspaceId = ctx.workspaceId;
    userId = ctx.user.id;
  } catch (error) {
    if (error instanceof AuthzError) {
      return { errorCode: "AUTHORIZATION_FAILED" };
    }
    throw error;
  }

  // Tenant isolation: the message must live in this workspace.
  const messageCtx = await getMessageFeedbackContext(workspaceId, input.messageId);
  if (!messageCtx) {
    return { errorCode: "FEEDBACK_ANSWER_NOT_FOUND" };
  }

  const feedback = await upsertFeedback({
    workspaceId,
    messageId: input.messageId,
    userId,
    rating: input.rating,
    reportType: input.reportType ?? null,
    comment,
    traceId: messageCtx.traceId,
  });

  return { feedback };
}

export type ReviewActionState = ActionState & { ok?: boolean };

/**
 * Update a feedback item's operator review fields (status + failure reason).
 * Requires ADMIN or higher. Scoped by the slug guard so a reviewer can only
 * touch feedback in a workspace they administer.
 */
export async function updateFeedbackReviewAction(
  workspaceSlug: string,
  feedbackId: string,
  _prev: ReviewActionState,
  formData: FormData,
): Promise<ReviewActionState> {
  const reviewStatus = String(
    formData.get("reviewStatus") ?? "",
  ) as FeedbackReviewStatus;
  if (!FEEDBACK_REVIEW_STATUSES.includes(reviewStatus)) {
    return { errorCode: "FEEDBACK_REVIEW_STATUS_INVALID" };
  }
  const failureReason = String(formData.get("failureReason") ?? "").trim();

  let workspaceId: string;
  try {
    ({ workspaceId } = await requireWorkspaceMemberBySlug(workspaceSlug, "ADMIN"));
  } catch (error) {
    if (error instanceof AuthzError) {
      return { errorCode: "AUTHORIZATION_FAILED" };
    }
    throw error;
  }

  const updated = await updateFeedbackReview(workspaceId, feedbackId, {
    reviewStatus,
    failureReason: failureReason || null,
  });
  if (!updated) {
    return { errorCode: "FEEDBACK_NOT_FOUND" };
  }

  revalidatePath(await withLocalePath(`/${workspaceSlug}/feedback`));
  revalidatePath(
    await withLocalePath(`/${workspaceSlug}/feedback/${feedbackId}`),
  );
  return { ok: true };
}

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

export type PromoteActionState = ActionState & {
  ok?: boolean;
  caseId?: string;
  datasetId?: string;
  datasetName?: string;
};

/**
 * Promote a feedback item into an evaluation regression case inside an existing
 * or inline-created dataset. Requires ADMIN or higher in the workspace.
 */
export async function promoteFeedbackToCaseAction(
  workspaceSlug: string,
  feedbackId: string,
  _prev: PromoteActionState,
  formData: FormData,
): Promise<PromoteActionState> {
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

  const datasetChoice = String(formData.get("datasetId") ?? "").trim();
  const newDatasetName = String(formData.get("newDatasetName") ?? "").trim();
  const question = String(formData.get("question") ?? "").trim();
  const expectedAnswer = String(formData.get("expectedAnswer") ?? "").trim();

  const result = await promoteFeedbackToCase(workspaceId, feedbackId, {
    datasetId: datasetChoice && datasetChoice !== "__new__" ? datasetChoice : null,
    newDatasetName:
      datasetChoice === "__new__" || !datasetChoice
        ? newDatasetName || null
        : null,
    question,
    expectedAnswer: expectedAnswer || null,
    expectedSourceDocuments: parseList(
      formData.get("expectedSourceDocuments"),
    ),
    requiredFacts: parseList(formData.get("requiredFacts")),
    tags: parseList(formData.get("tags")),
    markResolved: formData.get("markResolved") === "on",
  });

  if (!result.ok) {
    return { errorCode: result.reason };
  }

  await recordAudit({
    workspaceId,
    actorId,
    action: AUDIT_ACTIONS.FEEDBACK_PROMOTE_CASE,
    target: { type: "evaluation_case", id: result.caseId },
    metadata: {
      feedback_id: feedbackId,
      dataset_id: result.datasetId,
      name: result.datasetName,
    },
  });

  revalidatePath(await withLocalePath(`/${workspaceSlug}/feedback`));
  revalidatePath(
    await withLocalePath(`/${workspaceSlug}/feedback/${feedbackId}`),
  );
  revalidatePath(await withLocalePath(`/${workspaceSlug}/evaluations`));
  revalidatePath(
    await withLocalePath(
      `/${workspaceSlug}/evaluations/${result.datasetId}`,
    ),
  );

  return {
    ok: true,
    caseId: result.caseId,
    datasetId: result.datasetId,
    datasetName: result.datasetName,
  };
}
