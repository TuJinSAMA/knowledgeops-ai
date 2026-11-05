import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { QuotaMeter } from "@/components/dashboard/QuotaMeter";
import { getTraceStats } from "@/lib/dashboard";
import { getQuotaStatus } from "@/lib/quota";
import { requireUser } from "@/lib/session";
import { getUserWorkspaceBySlug } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export default async function UsagePage({
  params,
}: PageProps<"/[locale]/[workspaceSlug]/usage">) {
  const { locale, workspaceSlug } = await params;
  const t = await getTranslations({ locale, namespace: "usage" });
  const formatCount = new Intl.NumberFormat(locale).format;
  const formatCost = new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format;
  const user = await requireUser(`/${workspaceSlug}/usage`);
  const workspace = await getUserWorkspaceBySlug(user.id, workspaceSlug);
  if (!workspace) {
    notFound();
  }

  const [quota, traceStats] = await Promise.all([
    getQuotaStatus(workspace.id),
    getTraceStats(workspace.id),
  ]);

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        {t("description")}
      </p>

      <section className="mt-8 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
        <h2 className="font-semibold">{t("quotaWindows")}</h2>
        <p className="mt-1 text-xs text-neutral-500">
          {t("quotaDescription")}
        </p>
        <div className="mt-4">
          <QuotaMeter daily={quota.daily} monthly={quota.monthly} />
        </div>
      </section>

      <section className="mt-6 grid grid-cols-3 gap-3">
        <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <div className="text-xs uppercase tracking-wide text-neutral-500">
            {t("answers")}
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">
            {formatCount(traceStats.answerCount)}
          </div>
        </div>
        <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <div className="text-xs uppercase tracking-wide text-neutral-500">
            {t("totalTokens")}
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">
            {formatCount(traceStats.totalTokens)}
          </div>
        </div>
        <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <div className="text-xs uppercase tracking-wide text-neutral-500">
            {t("estimatedCost")}
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">
            {formatCost(traceStats.totalCost)}
          </div>
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-neutral-200 p-5 text-sm text-neutral-600 dark:border-neutral-800 dark:text-neutral-400">
        <h2 className="font-semibold text-neutral-900 dark:text-neutral-100">
          {t("degradedTitle")}
        </h2>
        <p className="mt-2">
          {t("degradedDescription")}
        </p>
      </section>
    </main>
  );
}
