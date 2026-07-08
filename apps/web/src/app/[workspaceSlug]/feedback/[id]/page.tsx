import Link from "next/link";
import { notFound } from "next/navigation";

import { FeedbackReviewForm } from "@/components/feedback/FeedbackReviewForm";
import { hasMinRole } from "@/lib/authz";
import { getFeedback } from "@/lib/feedback";
import { requireUser } from "@/lib/session";
import { getUserWorkspaceBySlug } from "@/lib/workspace";

export const dynamic = "force-dynamic";

const RATING_LABEL: Record<string, string> = {
  HELPFUL: "Helpful",
  NOT_HELPFUL: "Not helpful",
};

const REPORT_LABEL: Record<string, string> = {
  WRONG_ANSWER: "Wrong answer",
  MISSING_KNOWLEDGE: "Missing knowledge",
  OTHER: "Other",
};

const STATUS_LABEL: Record<string, string> = {
  NEW: "New",
  PENDING_REVIEW: "Pending review",
  RESOLVED: "Resolved",
};

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-800">
      <div className="text-xs uppercase tracking-wide text-neutral-500">
        {label}
      </div>
      <div className="mt-1 text-sm font-medium">{value}</div>
    </div>
  );
}

export default async function FeedbackDetailPage({
  params,
}: PageProps<"/[workspaceSlug]/feedback/[id]">) {
  const { workspaceSlug, id } = await params;
  const user = await requireUser(`/${workspaceSlug}/feedback/${id}`);
  const workspace = await getUserWorkspaceBySlug(user.id, workspaceSlug);
  if (!workspace) {
    notFound();
  }

  const feedback = await getFeedback(workspace.id, id);
  if (!feedback) {
    notFound();
  }

  const canReview = hasMinRole(workspace.role, "ADMIN");

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <Link
        href={`/${workspaceSlug}/feedback`}
        className="text-sm text-neutral-500 underline-offset-4 hover:underline"
      >
        ← All feedback
      </Link>

      <h1 className="mt-3 text-2xl font-semibold tracking-tight">
        Feedback detail
      </h1>
      <p className="mt-1 text-xs text-neutral-500">
        {feedback.createdAt.toISOString().replace("T", " ").slice(0, 19)} ·{" "}
        <code className="font-mono">{feedback.id}</code>
      </p>

      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Rating" value={RATING_LABEL[feedback.rating] ?? feedback.rating} />
        <Field
          label="Report"
          value={
            feedback.reportType
              ? REPORT_LABEL[feedback.reportType] ?? feedback.reportType
              : "—"
          }
        />
        <Field
          label="Status"
          value={STATUS_LABEL[feedback.reviewStatus] ?? feedback.reviewStatus}
        />
        <Field label="Knowledge base" value={feedback.knowledgeBaseName} />
      </section>

      <section className="mt-6">
        <h2 className="text-sm font-medium text-neutral-500">Question</h2>
        <p className="mt-2 whitespace-pre-wrap rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          {feedback.conversationTitle || "(untitled)"}
        </p>
      </section>

      <section className="mt-6">
        <h2 className="text-sm font-medium text-neutral-500">Answer</h2>
        <p className="mt-2 whitespace-pre-wrap rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          {feedback.answer || "(empty)"}
        </p>
      </section>

      {feedback.comment && (
        <section className="mt-6">
          <h2 className="text-sm font-medium text-neutral-500">User comment</h2>
          <p className="mt-2 whitespace-pre-wrap rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
            {feedback.comment}
          </p>
        </section>
      )}

      {feedback.traceId && (
        <section className="mt-6">
          <Link
            href={`/${workspaceSlug}/traces/${feedback.traceId}`}
            className="inline-block rounded-md border border-neutral-300 px-3 py-1.5 text-sm underline-offset-4 hover:underline dark:border-neutral-700"
          >
            View answer trace →
          </Link>
        </section>
      )}

      <section className="mt-10">
        <h2 className="text-lg font-medium">Operator review</h2>
        {canReview ? (
          <div className="mt-3 max-w-lg">
            <FeedbackReviewForm
              workspaceSlug={workspaceSlug}
              feedbackId={feedback.id}
              currentStatus={feedback.reviewStatus}
              currentFailureReason={feedback.failureReason}
            />
          </div>
        ) : (
          <div className="mt-3 space-y-2">
            <p className="text-sm text-neutral-500">
              Only workspace admins can update the review status.
            </p>
            {feedback.failureReason && (
              <div className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
                <div className="text-xs uppercase tracking-wide text-neutral-500">
                  Failure reason
                </div>
                <p className="mt-1 whitespace-pre-wrap">
                  {feedback.failureReason}
                </p>
              </div>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
