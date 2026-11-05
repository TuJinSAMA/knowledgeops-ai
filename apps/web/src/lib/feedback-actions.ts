"use server";

import { revalidatePath } from "next/cache";

import type { ActionErrorCode, ActionState } from "./action-errors";
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

  revalidatePath(`/${workspaceSlug}/feedback`);
  revalidatePath(`/${workspaceSlug}/feedback/${feedbackId}`);
  return { ok: true };
}
