import Link from "next/link";
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
  RUN_METRIC_LABELS,
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
}: PageProps<"/[workspaceSlug]/evaluations/[datasetId]/runs/[runId]">) {
  const { workspaceSlug, datasetId, runId } = await params;
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
        <h1 className="text-2xl font-semibold tracking-tight">Evaluation run</h1>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusBadge(run.status)}`}
        >
          {run.status}
        </span>
      </div>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        Config: {formatConfig(run.config)}
      </p>
      <p className="mt-1 text-xs text-neutral-500">
        Created {run.createdAt.toISOString().replace("T", " ").slice(0, 19)}
        {run.startedAt
          ? ` · started ${run.startedAt.toISOString().replace("T", " ").slice(0, 19)}`
          : ""}
        {run.finishedAt
          ? ` · finished ${run.finishedAt.toISOString().replace("T", " ").slice(0, 19)}`
          : ""}
      </p>

      {/* Summary metrics */}
      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {RUN_METRIC_LABELS.map(({ key, label }) => (
          <div
            key={key}
            className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
          >
            <p className="text-xs uppercase tracking-wide text-neutral-500">
              {label}
            </p>
            <p className="mt-1 text-xl font-semibold">
              {formatScore(summaryMetric(run.summaryMetrics, key))}
            </p>
          </div>
        ))}
      </section>

      {/* Per-case results */}
      <section className="mt-8">
        <h2 className="text-lg font-medium">Per-case results</h2>
        {results.length === 0 ? (
          <p className="mt-3 rounded-lg border border-dashed border-neutral-300 p-6 text-sm text-neutral-500 dark:border-neutral-700">
            {run.status === "PENDING" || run.status === "RUNNING"
              ? "No results yet — the evaluation worker has not finished this run."
              : "No results recorded for this run."}
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                <tr>
                  <th className="px-4 py-3 font-medium">Question</th>
                  <th className="px-4 py-3 font-medium">Retrieval</th>
                  <th className="px-4 py-3 font-medium">Citation</th>
                  <th className="px-4 py-3 font-medium">Correct</th>
                  <th className="px-4 py-3 font-medium">Grounded</th>
                  <th className="px-4 py-3 font-medium">Latency</th>
                  <th className="px-4 py-3 font-medium">Cost</th>
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
                      {formatScore(r.retrievalHit)}
                    </td>
                    <td className="px-4 py-3 text-neutral-600 dark:text-neutral-400">
                      {formatScore(r.citationAccuracy)}
                    </td>
                    <td className="px-4 py-3 text-neutral-600 dark:text-neutral-400">
                      {formatScore(r.correctness)}
                    </td>
                    <td className="px-4 py-3 text-neutral-600 dark:text-neutral-400">
                      {formatScore(r.groundedness)}
                    </td>
                    <td className="px-4 py-3 text-neutral-500">
                      {formatLatency(r.latencyMs)}
                    </td>
                    <td className="px-4 py-3 text-neutral-500">
                      {formatCost(r.costEstimate)}
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
