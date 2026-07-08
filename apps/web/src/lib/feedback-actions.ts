"use server";

import { revalidatePath } from "next/cache";

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
  error?: string;
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
    return { error: "Missing message" };
  }
  if (!FEEDBACK_RATINGS.includes(input.rating)) {
    return { error: "Invalid rating" };
  }
  if (
    input.reportType != null &&
    !FEEDBACK_REPORT_TYPES.includes(input.reportType)
  ) {
    return { error: "Invalid report type" };
  }
  const comment = input.comment?.trim() ? input.comment.trim() : null;
  if (comment && comment.length > COMMENT_MAX) {
    return { error: `Comment must be ${COMMENT_MAX} characters or fewer` };
  }

  let workspaceId: string;
  let userId: string;
  try {
    const ctx = await requireWorkspaceMemberBySlug(input.workspaceSlug, "MEMBER");
    workspaceId = ctx.workspaceId;
    userId = ctx.user.id;
  } catch (error) {
    if (error instanceof AuthzError) {
      return { error: error.message };
    }
    throw error;
  }

  // Tenant isolation: the message must live in this workspace.
  const messageCtx = await getMessageFeedbackContext(workspaceId, input.messageId);
  if (!messageCtx) {
    return { error: "Answer not found" };
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

export type ReviewActionState = { error?: string; ok?: boolean };

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
    return { error: "Invalid review status" };
  }
  const failureReason = String(formData.get("failureReason") ?? "").trim();

  let workspaceId: string;
  try {
    ({ workspaceId } = await requireWorkspaceMemberBySlug(workspaceSlug, "ADMIN"));
  } catch (error) {
    if (error instanceof AuthzError) {
      return { error: error.message };
    }
    throw error;
  }

  const updated = await updateFeedbackReview(workspaceId, feedbackId, {
    reviewStatus,
    failureReason: failureReason || null,
  });
  if (!updated) {
    return { error: "Feedback not found" };
  }

  revalidatePath(`/${workspaceSlug}/feedback`);
  revalidatePath(`/${workspaceSlug}/feedback/${feedbackId}`);
  return { ok: true };
}
