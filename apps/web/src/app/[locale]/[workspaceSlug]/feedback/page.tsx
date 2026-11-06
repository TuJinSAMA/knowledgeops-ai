import { Link } from "@/i18n/navigation";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import {
  FEEDBACK_REVIEW_STATUSES,
  type FeedbackReviewStatus,
  getFeedbackReviewCounts,
  listFeedback,
} from "@/lib/feedback";
import { listKnowledgeBases } from "@/lib/knowledge-base";
import { requireUser } from "@/lib/session";
import { getUserWorkspaceBySlug } from "@/lib/workspace";

export const dynamic = "force-dynamic";

function ratingBadge(rating: string): string {
  return rating === "HELPFUL"
    ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
    : "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300";
}

function statusBadge(status: FeedbackReviewStatus): string {
  switch (status) {
    case "RESOLVED":
      return "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300";
    case "PENDING_REVIEW":
      return "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300";
    default:
      return "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300";
  }
}

export default async function FeedbackPage({
  params,
  searchParams,
}: PageProps<"/[locale]/[workspaceSlug]/feedback">) {
  const { locale, workspaceSlug } = await params;
  const t = await getTranslations({ locale, namespace: "feedback" });
  const formatDate = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format;
  const sp = await searchParams;
  const user = await requireUser(`/${workspaceSlug}/feedback`);
  const workspace = await getUserWorkspaceBySlug(user.id, workspaceSlug);
  if (!workspace) {
    notFound();
  }

  const kbParam = typeof sp.kb === "string" ? sp.kb : undefined;
  const statusParam =
    typeof sp.status === "string" &&
    FEEDBACK_REVIEW_STATUSES.includes(sp.status as FeedbackReviewStatus)
      ? (sp.status as FeedbackReviewStatus)
      : undefined;

  const [knowledgeBases, feedback, counts] = await Promise.all([
    listKnowledgeBases(workspace.id),
    listFeedback(workspace.id, {
      knowledgeBaseId: kbParam ?? null,
      reviewStatus: statusParam ?? null,
    }),
    getFeedbackReviewCounts(workspace.id),
  ]);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        {t("description")}
      </p>

      <div className="mt-4 flex flex-wrap gap-2 text-xs">
        {FEEDBACK_REVIEW_STATUSES.map((s) => (
          <span
            key={s}
            className={`rounded-full px-2 py-0.5 font-medium ${statusBadge(s)}`}
          >
            {t(`statusLabels.${s}`)}: {counts[s]}
          </span>
        ))}
      </div>

      <form
        method="get"
        className="mt-6 flex flex-wrap items-end gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
      >
        <div className="flex flex-col gap-1">
          <label htmlFor="kb" className="text-xs text-neutral-500">
            {t("knowledgeBase")}
          </label>
          <select
            id="kb"
            name="kb"
            defaultValue={kbParam ?? ""}
            className="rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm outline-none dark:border-neutral-700"
          >
            <option value="">{t("all")}</option>
            {knowledgeBases.map((kb) => (
              <option key={kb.id} value={kb.id}>
                {kb.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="status" className="text-xs text-neutral-500">
            {t("reviewStatus")}
          </label>
          <select
            id="status"
            name="status"
            defaultValue={statusParam ?? ""}
            className="rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm outline-none dark:border-neutral-700"
          >
            <option value="">{t("all")}</option>
            {FEEDBACK_REVIEW_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`statusLabels.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
        >
          {t("filter")}
        </button>
        {(kbParam || statusParam) && (
          <Link
            href={`/${workspaceSlug}/feedback`}
            className="text-sm text-neutral-500 underline-offset-4 hover:underline"
          >
            {t("reset")}
          </Link>
        )}
      </form>

      {feedback.length === 0 ? (
        <p className="mt-8 rounded-lg border border-dashed border-neutral-300 p-6 text-sm text-neutral-500 dark:border-neutral-700">
          {t("none")}
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
              <tr>
                <th className="px-4 py-3 font-medium">{t("question")}</th>
                <th className="px-4 py-3 font-medium">{t("knowledgeBase")}</th>
                <th className="px-4 py-3 font-medium">{t("rating")}</th>
                <th className="px-4 py-3 font-medium">{t("report")}</th>
                <th className="px-4 py-3 font-medium">{t("status")}</th>
                <th className="px-4 py-3 font-medium">{t("when")}</th>
              </tr>
            </thead>
            <tbody>
              {feedback.map((f) => (
                <tr
                  key={f.id}
                  className="border-b border-neutral-100 last:border-0 dark:border-neutral-900"
                >
                  <td className="px-4 py-3">
                    <Link
                      href={`/${workspaceSlug}/feedback/${f.id}`}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {f.question?.slice(0, 60) || f.conversationTitle?.slice(0, 60) || t("untitled")}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-neutral-500">
                    {f.knowledgeBaseName}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${ratingBadge(f.rating)}`}
                    >
                      {t(`ratingLabels.${f.rating}`)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-neutral-500">
                    {f.reportType ? t(`reportLabels.${f.reportType}`) : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusBadge(f.reviewStatus)}`}
                      >
                        {t(`statusLabels.${f.reviewStatus}`)}
                      </span>
                      {f.promotedCaseId && (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                          {t("promotedBadge")}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-neutral-500">
                    {formatDate(f.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
