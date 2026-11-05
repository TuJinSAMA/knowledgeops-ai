import { Link } from "@/i18n/navigation";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { FeedbackReviewForm } from "@/components/feedback/FeedbackReviewForm";
import { hasMinRole } from "@/lib/authz";
import { getFeedback } from "@/lib/feedback";
import { requireUser } from "@/lib/session";
import { getUserWorkspaceBySlug } from "@/lib/workspace";

export const dynamic = "force-dynamic";

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
}: PageProps<"/[locale]/[workspaceSlug]/feedback/[id]">) {
  const { locale, workspaceSlug, id } = await params;
  const t = await getTranslations({ locale, namespace: "feedback" });
  const formatDate = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format;
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
        {t("back")}
      </Link>

      <h1 className="mt-3 text-2xl font-semibold tracking-tight">
        {t("detail")}
      </h1>
      <p className="mt-1 text-xs text-neutral-500">
        {formatDate(feedback.createdAt)} ·{" "}
        <code className="font-mono">{feedback.id}</code>
      </p>

      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label={t("rating")} value={t(`ratingLabels.${feedback.rating}`)} />
        <Field
          label={t("report")}
          value={
            feedback.reportType
              ? t(`reportLabels.${feedback.reportType}`)
              : "—"
          }
        />
        <Field
          label={t("status")}
          value={t(`statusLabels.${feedback.reviewStatus}`)}
        />
        <Field label={t("knowledgeBaseLabel")} value={feedback.knowledgeBaseName} />
      </section>

      <section className="mt-6">
        <h2 className="text-sm font-medium text-neutral-500">{t("question")}</h2>
        <p className="mt-2 whitespace-pre-wrap rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          {feedback.question || feedback.conversationTitle || t("untitled")}
        </p>
      </section>

      <section className="mt-6">
        <h2 className="text-sm font-medium text-neutral-500">{t("answer")}</h2>
        <p className="mt-2 whitespace-pre-wrap rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          {feedback.answer || t("empty")}
        </p>
      </section>

      {feedback.comment && (
        <section className="mt-6">
          <h2 className="text-sm font-medium text-neutral-500">{t("userComment")}</h2>
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
            {t("viewTrace")}
          </Link>
        </section>
      )}

      <section className="mt-10">
        <h2 className="text-lg font-medium">{t("operatorReview")}</h2>
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
              {t("adminOnly")}
            </p>
            {feedback.failureReason && (
              <div className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
                <div className="text-xs uppercase tracking-wide text-neutral-500">
                  {t("failureReason")}
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
