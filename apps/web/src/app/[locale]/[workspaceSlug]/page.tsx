import { Link } from "@/i18n/navigation";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { QuotaMeter } from "@/components/dashboard/QuotaMeter";
import { hasMinRole } from "@/lib/authz";
import {
  type DashboardMetrics,
  getDashboardMetrics,
} from "@/lib/dashboard";
import { getQuotaStatus } from "@/lib/quota";
import { requireUser } from "@/lib/session";
import { getUserWorkspaceBySlug } from "@/lib/workspace";

export const dynamic = "force-dynamic";

const RUN_STATUS_BADGE: Record<string, string> = {
  COMPLETED:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  RUNNING: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  PENDING: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  FAILED: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
};

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="text-xs uppercase tracking-wide text-neutral-500">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function FeedbackBar({ feedback, t }: { feedback: DashboardMetrics["feedback"]; t: (key: string) => string }) {
  if (feedback.total === 0) {
    return (
      <p className="text-sm text-neutral-500">{t("noFeedback")}</p>
    );
  }
  const helpfulPct = Math.round((feedback.helpful / feedback.total) * 100);
  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
        <div
          className="h-full bg-emerald-500"
          style={{ width: `${helpfulPct}%` }}
        />
        <div
          className="h-full bg-red-500"
          style={{ width: `${100 - helpfulPct}%` }}
        />
      </div>
      <div className="mt-2 flex justify-between text-sm text-neutral-600 dark:text-neutral-400">
        <span>
          <span className="font-medium text-emerald-600 dark:text-emerald-400">
            {feedback.helpful}
          </span>{" "}
          {t("helpful")} ({helpfulPct}%)
        </span>
        <span>
          <span className="font-medium text-red-600 dark:text-red-400">
            {feedback.notHelpful}
          </span>{" "}
          {t("notHelpful")}
        </span>
      </div>
    </div>
  );
}

export default async function WorkspaceDashboardPage({
  params,
}: PageProps<"/[locale]/[workspaceSlug]">) {
  const { locale, workspaceSlug } = await params;
  const t = await getTranslations({ locale, namespace: "dashboard" });
  const evaluationT = await getTranslations({ locale, namespace: "evaluations" });
  const formatNumber = new Intl.NumberFormat(locale).format;
  const formatCost = new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format;
  const formatDate = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format;
  const formatLatency = (ms: number | null) =>
    ms == null
      ? "—"
      : ms >= 1000
        ? `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(ms / 1000)} s`
        : `${formatNumber(ms)} ms`;
  const user = await requireUser(`/${workspaceSlug}`);
  const workspace = await getUserWorkspaceBySlug(user.id, workspaceSlug);
  if (!workspace) {
    notFound();
  }

  const [metrics, quota] = await Promise.all([
    getDashboardMetrics(workspace.id),
    getQuotaStatus(workspace.id),
  ]);

  const canSeeAudit = hasMinRole(workspace.role, "ADMIN");

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {workspace.name}
          </h1>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            {t("subtitle", { role: workspace.role })}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-sm">
          <Link
            href={`/${workspace.slug}/chat`}
            className="rounded-md bg-neutral-900 px-3 py-1.5 font-medium text-white dark:bg-white dark:text-neutral-900"
          >
            {t("askAssistant")}
          </Link>
          <Link
            href={`/${workspace.slug}/knowledge-bases`}
            className="rounded-md border border-neutral-300 px-3 py-1.5 font-medium dark:border-neutral-700"
          >
            {t("knowledgeBases")}
          </Link>
        </div>
      </div>

      <section className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <StatCard label={t("documents")} value={formatNumber(metrics.documentCount)} />
        <StatCard label={t("chunks")} value={formatNumber(metrics.chunkCount)} />
        <StatCard label={t("answers")} value={formatNumber(metrics.answerCount)} />
        <StatCard
          label={t("messages")}
          value={formatNumber(metrics.conversationMessageCount)}
        />
        <StatCard
          label={t("avgLatency")}
          value={formatLatency(metrics.avgLatencyMs)}
        />
        <StatCard
          label={t("totalTokens")}
          value={formatNumber(metrics.totalTokens)}
        />
        <StatCard label={t("estimatedCost")} value={formatCost(metrics.totalCost)} />
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">{t("answerFeedback")}</h2>
            <Link
              href={`/${workspace.slug}/feedback`}
              className="text-xs text-neutral-500 underline-offset-4 hover:underline"
            >
              {t("viewAll")}
            </Link>
          </div>
          <div className="mt-4">
            <FeedbackBar feedback={metrics.feedback} t={t} />
          </div>
        </section>

        <section className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">{t("tokenUsage")}</h2>
            <Link
              href={`/${workspace.slug}/usage`}
              className="text-xs text-neutral-500 underline-offset-4 hover:underline"
            >
              {t("details")}
            </Link>
          </div>
          <div className="mt-4">
            <QuotaMeter daily={quota.daily} monthly={quota.monthly} />
          </div>
        </section>
      </div>

      <section className="mt-6 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">{t("recentRuns")}</h2>
          <Link
            href={`/${workspace.slug}/evaluations`}
            className="text-xs text-neutral-500 underline-offset-4 hover:underline"
          >
            {t("allEvaluations")}
          </Link>
        </div>
        {metrics.recentRuns.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">
            {t("noRuns")}
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-neutral-100 dark:divide-neutral-900">
            {metrics.recentRuns.map((run) => (
              <li key={run.id}>
                <Link
                  href={`/${workspace.slug}/evaluations/${run.datasetId}/runs/${run.id}`}
                  className="flex items-center justify-between gap-3 py-2.5 text-sm transition hover:opacity-80"
                >
                  <span className="font-mono text-xs text-neutral-500">
                    {run.id.slice(0, 8)}
                  </span>
                  <span className="flex-1 text-neutral-500">
                    {formatDate(run.createdAt)}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      RUN_STATUS_BADGE[run.status] ?? ""
                    }`}
                  >
                    {evaluationT(`statusLabels.${run.status}`)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {canSeeAudit && (
        <p className="mt-6 text-sm text-neutral-500">
          {t("auditPrompt")}{" "}
          <Link
            href={`/${workspace.slug}/audit`}
            className="underline underline-offset-4"
          >
            {t("openAudit")}
          </Link>
          .
        </p>
      )}
    </main>
  );
}
