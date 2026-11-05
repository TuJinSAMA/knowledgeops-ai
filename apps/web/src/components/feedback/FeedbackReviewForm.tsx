"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";

import {
  type ReviewActionState,
  updateFeedbackReviewAction,
} from "@/lib/feedback-actions";

type ReviewStatus = "NEW" | "PENDING_REVIEW" | "RESOLVED";

/**
 * Operator review controls for a feedback item: set the review status and
 * record a failure-reason classification. Wired to the ADMIN-guarded server
 * action.
 */
export function FeedbackReviewForm({
  workspaceSlug,
  feedbackId,
  currentStatus,
  currentFailureReason,
}: {
  workspaceSlug: string;
  feedbackId: string;
  currentStatus: ReviewStatus;
  currentFailureReason: string | null;
}) {
  const t = useTranslations("feedback");
  const errorT = useTranslations("errors");
  const action = updateFeedbackReviewAction.bind(null, workspaceSlug, feedbackId);
  const [state, formAction, pending] = useActionState<ReviewActionState, FormData>(
    action,
    {},
  );

  return (
    <form action={formAction} className="space-y-3">
      <div className="flex flex-col gap-1">
        <label htmlFor="reviewStatus" className="text-xs text-neutral-500">
          {t("reviewStatus")}
        </label>
        <select
          id="reviewStatus"
          name="reviewStatus"
          defaultValue={currentStatus}
          className="rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm outline-none dark:border-neutral-700"
        >
          {(["NEW", "PENDING_REVIEW", "RESOLVED"] as const).map((status) => (
            <option key={status} value={status}>
              {t(`statusLabels.${status}`)}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="failureReason" className="text-xs text-neutral-500">
          {t("failureReasonClassification")}
        </label>
        <textarea
          id="failureReason"
          name="failureReason"
          defaultValue={currentFailureReason ?? ""}
          rows={3}
          placeholder={t("failureReasonPlaceholder")}
          className="resize-none rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm outline-none dark:border-neutral-700"
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60 dark:bg-white dark:text-neutral-900"
        >
          {pending ? t("saving") : t("saveReview")}
        </button>
        {state.ok && (
          <span className="text-xs text-emerald-600 dark:text-emerald-400">
            {t("saved")}
          </span>
        )}
        {state.errorCode && (
          <span className="text-xs text-red-600 dark:text-red-400">
            {errorT(state.errorCode, state.errorParams)}
          </span>
        )}
      </div>
    </form>
  );
}
