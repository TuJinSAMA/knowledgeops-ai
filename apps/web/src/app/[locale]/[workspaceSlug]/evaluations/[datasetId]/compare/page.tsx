import { Link } from "@/i18n/navigation";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import {
  type EvaluationRunSummary,
  getEvaluationDataset,
  getEvaluationRun,
  listEvaluationRuns,
} from "@/lib/evaluation";
import {
  formatConfig,
  formatScore,
  RUN_METRIC_KEYS,
  summaryMetric,
} from "@/lib/evaluation-format";
import { requireUser } from "@/lib/session";
import { getUserWorkspaceBySlug } from "@/lib/workspace";

export const dynamic = "force-dynamic";

function runLabel(
  run: EvaluationRunSummary,
  formatDate: (date: Date) => string,
  defaultsLabel: string,
): string {
  return `${formatDate(run.createdAt)} — ${formatConfig(run.config, defaultsLabel)}`;
}

function deltaCell(a: number | null, b: number | null, locale: string) {
  if (a == null || b == null) {
    return <span className="text-neutral-400">—</span>;
  }
  const delta = b - a;
  if (Math.abs(delta) < 1e-9) {
    return (
      <span className="text-neutral-500">
        ±{new Intl.NumberFormat(locale, {
          style: "percent",
          maximumFractionDigits: 1,
          minimumFractionDigits: 1,
        }).format(0)}
      </span>
    );
  }
  const positive = delta > 0;
  return (
    <span
      className={
        positive
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-red-600 dark:text-red-400"
      }
    >
      {positive ? "+" : ""}
      {new Intl.NumberFormat(locale, {
        style: "percent",
        maximumFractionDigits: 1,
        minimumFractionDigits: 1,
      }).format(delta)}
    </span>
  );
}

export default async function CompareRunsPage({
  params,
  searchParams,
}: PageProps<"/[locale]/[workspaceSlug]/evaluations/[datasetId]/compare">) {
  const { locale, workspaceSlug, datasetId } = await params;
  const t = await getTranslations({ locale, namespace: "evaluations" });
  const formatDate = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format;
  const sp = await searchParams;
  const user = await requireUser(
    `/${workspaceSlug}/evaluations/${datasetId}/compare`,
  );
  const workspace = await getUserWorkspaceBySlug(user.id, workspaceSlug);
  if (!workspace) {
    notFound();
  }

  const dataset = await getEvaluationDataset(workspace.id, datasetId);
  if (!dataset) {
    notFound();
  }

  const runs = await listEvaluationRuns(workspace.id, datasetId);

  const aId = typeof sp.a === "string" ? sp.a : runs[1]?.id;
  const bId = typeof sp.b === "string" ? sp.b : runs[0]?.id;

  // Scope each run to this dataset + workspace (tenant isolation via getEvaluationRun).
  const [runA, runB] = await Promise.all([
    aId ? getEvaluationRun(workspace.id, aId) : Promise.resolve(null),
    bId ? getEvaluationRun(workspace.id, bId) : Promise.resolve(null),
  ]);
  const validA = runA && runA.datasetId === datasetId ? runA : null;
  const validB = runB && runB.datasetId === datasetId ? runB : null;

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <Link
        href={`/${workspaceSlug}/evaluations/${datasetId}`}
        className="text-sm text-neutral-500 underline-offset-4 hover:underline"
      >
        ← {dataset.name}
      </Link>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">{t("compareTitle")}</h1>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        {t("compareDescription")}
      </p>

      {runs.length < 2 ? (
        <p className="mt-8 rounded-lg border border-dashed border-neutral-300 p-6 text-sm text-neutral-500 dark:border-neutral-700">
          {t("needTwoRuns")}
        </p>
      ) : (
        <>
          <form
            method="get"
            className="mt-6 flex flex-wrap items-end gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
          >
            <div className="flex flex-col gap-1">
              <label htmlFor="cmp-a" className="text-xs text-neutral-500">
                {t("runABaseline")}
              </label>
              <select
                id="cmp-a"
                name="a"
                defaultValue={validA?.id ?? ""}
                className="rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm outline-none dark:border-neutral-700"
              >
                {runs.map((run) => (
                  <option key={run.id} value={run.id}>
                    {runLabel(run, formatDate, t("defaults"))}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="cmp-b" className="text-xs text-neutral-500">
                {t("runB")}
              </label>
              <select
                id="cmp-b"
                name="b"
                defaultValue={validB?.id ?? ""}
                className="rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm outline-none dark:border-neutral-700"
              >
                {runs.map((run) => (
                  <option key={run.id} value={run.id}>
                    {runLabel(run, formatDate, t("defaults"))}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
            >
              {t("compare")}
            </button>
          </form>

          {validA && validB ? (
            <div className="mt-6 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                  <tr>
                    <th className="px-4 py-3 font-medium">{t("metric")}</th>
                    <th className="px-4 py-3 font-medium">{t("runA")}</th>
                    <th className="px-4 py-3 font-medium">{t("runB")}</th>
                    <th className="px-4 py-3 font-medium">{t("delta")}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-neutral-100 dark:border-neutral-900">
                    <td className="px-4 py-3 text-neutral-500">{t("config")}</td>
                    <td className="px-4 py-3">{formatConfig(validA.config, t("defaults"))}</td>
                    <td className="px-4 py-3">{formatConfig(validB.config, t("defaults"))}</td>
                    <td className="px-4 py-3 text-neutral-400">—</td>
                  </tr>
                  <tr className="border-b border-neutral-100 dark:border-neutral-900">
                    <td className="px-4 py-3 text-neutral-500">{t("status")}</td>
                    <td className="px-4 py-3">{t(`statusLabels.${validA.status}`)}</td>
                    <td className="px-4 py-3">{t(`statusLabels.${validB.status}`)}</td>
                    <td className="px-4 py-3 text-neutral-400">—</td>
                  </tr>
                  {RUN_METRIC_KEYS.map((key) => {
                    const a = summaryMetric(validA.summaryMetrics, key);
                    const b = summaryMetric(validB.summaryMetrics, key);
                    return (
                      <tr
                        key={key}
                        className="border-b border-neutral-100 last:border-0 dark:border-neutral-900"
                      >
                        <td className="px-4 py-3 text-neutral-500">
                          {t(`metricLabels.${key}`)}
                        </td>
                        <td className="px-4 py-3">{formatScore(a, locale)}</td>
                        <td className="px-4 py-3">{formatScore(b, locale)}</td>
                        <td className="px-4 py-3">{deltaCell(a, b, locale)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-6 text-sm text-neutral-500">
              {t("selectRuns")}
            </p>
          )}
        </>
      )}
    </main>
  );
}
