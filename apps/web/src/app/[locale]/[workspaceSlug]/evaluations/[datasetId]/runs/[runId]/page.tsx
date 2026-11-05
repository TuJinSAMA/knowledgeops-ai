import { Link } from "@/i18n/navigation";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import {
  type EvaluationRunStatus,
  getEvaluationDataset,
  getEvaluationRun,
  listEvaluationResults,
} from "@/lib/evaluation";
import {
  formatConfig,
  formatCost,
  formatLatency,
  formatScore,
  RUN_METRIC_KEYS,
  summaryMetric,
} from "@/lib/evaluation-format";
import { requireUser } from "@/lib/session";
import { getUserWorkspaceBySlug } from "@/lib/workspace";

export const dynamic = "force-dynamic";

function statusBadge(status: EvaluationRunStatus): string {
  switch (status) {
    case "COMPLETED":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300";
    case "RUNNING":
      return "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300";
    case "FAILED":
      return "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300";
    default:
      return "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300";
  }
}

export default async function EvaluationRunPage({
  params,
}: PageProps<"/[locale]/[workspaceSlug]/evaluations/[datasetId]/runs/[runId]">) {
  const { locale, workspaceSlug, datasetId, runId } = await params;
  const t = await getTranslations({ locale, namespace: "evaluations" });
  const formatDate = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format;
  const user = await requireUser(
    `/${workspaceSlug}/evaluations/${datasetId}/runs/${runId}`,
  );
  const workspace = await getUserWorkspaceBySlug(user.id, workspaceSlug);
  if (!workspace) {
    notFound();
  }

  const [dataset, run] = await Promise.all([
    getEvaluationDataset(workspace.id, datasetId),
    getEvaluationRun(workspace.id, runId),
  ]);
  if (!dataset || !run || run.datasetId !== datasetId) {
    notFound();
  }

  const results = await listEvaluationResults(workspace.id, runId);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <Link
        href={`/${workspaceSlug}/evaluations/${datasetId}`}
        className="text-sm text-neutral-500 underline-offset-4 hover:underline"
      >
        ← {dataset.name}
      </Link>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{t("evaluationRun")}</h1>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusBadge(run.status)}`}
        >
          {t(`statusLabels.${run.status}`)}
        </span>
      </div>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        {t("config")}: {formatConfig(run.config, t("defaults"))}
      </p>
      <p className="mt-1 text-xs text-neutral-500">
        {t("createdAt", { date: formatDate(run.createdAt) })}
        {run.startedAt
          ? ` ${t("startedAt", { date: formatDate(run.startedAt) })}`
          : ""}
        {run.finishedAt
          ? ` ${t("finishedAt", { date: formatDate(run.finishedAt) })}`
          : ""}
      </p>

      {/* Summary metrics */}
      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {RUN_METRIC_KEYS.map((key) => (
          <div
            key={key}
            className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
          >
            <p className="text-xs uppercase tracking-wide text-neutral-500">
              {t(`metricLabels.${key}`)}
            </p>
            <p className="mt-1 text-xl font-semibold">
              {formatScore(summaryMetric(run.summaryMetrics, key), locale)}
            </p>
          </div>
        ))}
      </section>

      {/* Per-case results */}
      <section className="mt-8">
        <h2 className="text-lg font-medium">{t("perCaseResults")}</h2>
        {results.length === 0 ? (
          <p className="mt-3 rounded-lg border border-dashed border-neutral-300 p-6 text-sm text-neutral-500 dark:border-neutral-700">
            {run.status === "PENDING" || run.status === "RUNNING"
              ? t("noPendingResults")
              : t("noResults")}
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                <tr>
                  <th className="px-4 py-3 font-medium">{t("question")}</th>
                  <th className="px-4 py-3 font-medium">{t("retrieval")}</th>
                  <th className="px-4 py-3 font-medium">{t("citation")}</th>
                  <th className="px-4 py-3 font-medium">{t("correct")}</th>
                  <th className="px-4 py-3 font-medium">{t("grounded")}</th>
                  <th className="px-4 py-3 font-medium">{t("latency")}</th>
                  <th className="px-4 py-3 font-medium">{t("cost")}</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr
                    key={r.id}
                    className="border-b border-neutral-100 last:border-0 dark:border-neutral-900"
                  >
                    <td className="px-4 py-3">{r.question.slice(0, 80)}</td>
                    <td className="px-4 py-3 text-neutral-600 dark:text-neutral-400">
                      {formatScore(r.retrievalHit, locale)}
                    </td>
                    <td className="px-4 py-3 text-neutral-600 dark:text-neutral-400">
                      {formatScore(r.citationAccuracy, locale)}
                    </td>
                    <td className="px-4 py-3 text-neutral-600 dark:text-neutral-400">
                      {formatScore(r.correctness, locale)}
                    </td>
                    <td className="px-4 py-3 text-neutral-600 dark:text-neutral-400">
                      {formatScore(r.groundedness, locale)}
                    </td>
                    <td className="px-4 py-3 text-neutral-500">
                      {formatLatency(r.latencyMs, locale)}
                    </td>
                    <td className="px-4 py-3 text-neutral-500">
                      {formatCost(r.costEstimate, locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
