import { Link } from "@/i18n/navigation";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { CreateEvaluationCaseForm } from "@/components/evaluation/CreateEvaluationCaseForm";
import { DeleteEvaluationCaseButton } from "@/components/evaluation/DeleteEvaluationCaseButton";
import { DeleteEvaluationDatasetButton } from "@/components/evaluation/DeleteEvaluationDatasetButton";
import { TriggerEvaluationRunForm } from "@/components/evaluation/TriggerEvaluationRunForm";
import { hasMinRole } from "@/lib/authz";
import {
  type EvaluationRunStatus,
  getEvaluationDataset,
  listEvaluationCases,
  listEvaluationRuns,
} from "@/lib/evaluation";
import { requireUser } from "@/lib/session";
import { getUserWorkspaceBySlug } from "@/lib/workspace";

export const dynamic = "force-dynamic";

function runStatusBadge(status: EvaluationRunStatus): string {
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

function formatConfig(config: Record<string, unknown> | null, defaultsLabel: string): string {
  if (!config || Object.keys(config).length === 0) {
    return defaultsLabel;
  }
  return Object.entries(config)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" · ");
}

export default async function EvaluationDatasetPage({
  params,
}: PageProps<"/[locale]/[workspaceSlug]/evaluations/[datasetId]">) {
  const { locale, workspaceSlug, datasetId } = await params;
  const t = await getTranslations({ locale, namespace: "evaluations" });
  const user = await requireUser(`/${workspaceSlug}/evaluations/${datasetId}`);
  const workspace = await getUserWorkspaceBySlug(user.id, workspaceSlug);
  if (!workspace) {
    notFound();
  }

  const dataset = await getEvaluationDataset(workspace.id, datasetId);
  if (!dataset) {
    notFound();
  }

  const canManage = hasMinRole(workspace.role, "ADMIN");
  const [cases, runs] = await Promise.all([
    listEvaluationCases(workspace.id, datasetId),
    listEvaluationRuns(workspace.id, datasetId),
  ]);

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <Link
        href={`/${workspaceSlug}/evaluations`}
        className="text-sm text-neutral-500 underline-offset-4 hover:underline"
      >
        {t("backDatasets")}
      </Link>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">
        {dataset.name}
      </h1>
      {dataset.description && (
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          {dataset.description}
        </p>
      )}
      <p className="mt-1 text-xs text-neutral-500">
        {dataset.knowledgeBaseName
          ? t("boundKnowledgeBase", { name: dataset.knowledgeBaseName })
          : t("noBoundKnowledgeBase")}{" "}
        · {t("cases", { count: dataset.caseCount })}
      </p>

      {/* Cases */}
      <section className="mt-8">
        <h2 className="text-lg font-medium">{t("casesTitle")}</h2>
        {cases.length === 0 ? (
          <p className="mt-3 rounded-lg border border-dashed border-neutral-300 p-6 text-sm text-neutral-500 dark:border-neutral-700">
            {t("noCases")}{canManage ? ` ${t("addOne")}` : ""}
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {cases.map((c) => (
              <li key={c.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-medium">{c.question}</p>
                    {c.expectedAnswer && (
                      <p className="mt-1 text-sm text-neutral-500">
                        {t("expected", { answer: c.expectedAnswer })}
                      </p>
                    )}
                    <div className="mt-1 flex flex-wrap gap-1 text-xs text-neutral-500">
                      {c.expectedSourceDocuments?.length ? (
                        <span className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">
                          {t("expectedDocuments", {
                            count: c.expectedSourceDocuments.length,
                          })}
                        </span>
                      ) : null}
                      {c.expectedChunks?.length ? (
                        <span className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">
                          {t("expectedChunks", { count: c.expectedChunks.length })}
                        </span>
                      ) : null}
                      {c.requiredFacts?.length ? (
                        <span className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">
                          {t("requiredFacts", { count: c.requiredFacts.length })}
                        </span>
                      ) : null}
                      {c.tags?.map((tag) => (
                        <span
                          key={tag}
                          className="rounded bg-blue-100 px-1.5 py-0.5 text-blue-800 dark:bg-blue-950 dark:text-blue-300"
                        >
                          {tag}
                        </span>
                      ))}
                      {c.sourceFeedbackId && (
                        <Link
                          href={`/${workspaceSlug}/feedback/${c.sourceFeedbackId}`}
                          className="rounded bg-emerald-100 px-1.5 py-0.5 font-medium text-emerald-800 underline-offset-4 hover:underline dark:bg-emerald-950 dark:text-emerald-300"
                        >
                          {t("fromFeedback")}
                        </Link>
                      )}
                    </div>
                  </div>
                  {canManage && (
                    <DeleteEvaluationCaseButton
                      workspaceSlug={workspaceSlug}
                      datasetId={datasetId}
                      caseId={c.id}
                    />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {canManage && (
          <div className="mt-6 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            <h3 className="text-sm font-medium">{t("addCase")}</h3>
            <div className="mt-3">
              <CreateEvaluationCaseForm
                workspaceSlug={workspaceSlug}
                datasetId={datasetId}
              />
            </div>
          </div>
        )}
      </section>

      {/* Runs */}
      <section className="mt-10">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">{t("runs")}</h2>
          {runs.length >= 2 && (
            <Link
              href={`/${workspaceSlug}/evaluations/${datasetId}/compare?a=${runs[1].id}&b=${runs[0].id}`}
              className="text-sm text-neutral-600 underline-offset-4 hover:underline dark:text-neutral-400"
            >
              {t("compareRuns")}
            </Link>
          )}
        </div>
        {runs.length === 0 ? (
          <p className="mt-3 rounded-lg border border-dashed border-neutral-300 p-6 text-sm text-neutral-500 dark:border-neutral-700">
            {t("noRuns")}
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                <tr>
                  <th className="px-4 py-3 font-medium">{t("config")}</th>
                  <th className="px-4 py-3 font-medium">{t("status")}</th>
                  <th className="px-4 py-3 font-medium">{t("created")}</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr
                    key={run.id}
                    className="border-b border-neutral-100 last:border-0 dark:border-neutral-900"
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/${workspaceSlug}/evaluations/${datasetId}/runs/${run.id}`}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {formatConfig(run.config, t("defaults"))}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${runStatusBadge(run.status)}`}
                      >
                        {t(`statusLabels.${run.status}`)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-neutral-500">
                      {new Intl.DateTimeFormat(locale, {
                        dateStyle: "medium",
                        timeStyle: "medium",
                      }).format(run.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {canManage && (
          <div className="mt-6 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            <h3 className="text-sm font-medium">{t("triggerRun")}</h3>
            <div className="mt-3">
              <TriggerEvaluationRunForm
                workspaceSlug={workspaceSlug}
                datasetId={datasetId}
                disabled={cases.length === 0}
              />
            </div>
          </div>
        )}
      </section>

      {canManage && (
        <section className="mt-12 border-t border-neutral-200 pt-6 dark:border-neutral-800">
          <h2 className="text-sm font-medium text-red-600 dark:text-red-400">
            {t("dangerZone")}
          </h2>
          <div className="mt-3">
            <DeleteEvaluationDatasetButton
              workspaceSlug={workspaceSlug}
              datasetId={datasetId}
              datasetName={dataset.name}
            />
          </div>
        </section>
      )}
    </main>
  );
}
