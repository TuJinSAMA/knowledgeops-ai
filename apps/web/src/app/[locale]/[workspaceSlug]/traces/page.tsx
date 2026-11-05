import { Link } from "@/i18n/navigation";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { requireUser } from "@/lib/session";
import { listTraces } from "@/lib/trace";
import { getUserWorkspaceBySlug } from "@/lib/workspace";

export const dynamic = "force-dynamic";

function formatCost(cost: string | null): string {
  if (cost == null) {
    return "—";
  }
  const value = Number(cost);
  if (!Number.isFinite(value)) {
    return "—";
  }
  return `$${value.toFixed(6)}`;
}

export default async function TracesPage({
  params,
}: PageProps<"/[locale]/[workspaceSlug]/traces">) {
  const { locale, workspaceSlug } = await params;
  const t = await getTranslations({ locale, namespace: "traces" });
  const formatDate = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }).format;
  const user = await requireUser(`/${workspaceSlug}/traces`);
  const workspace = await getUserWorkspaceBySlug(user.id, workspaceSlug);
  if (!workspace) {
    notFound();
  }

  const traces = await listTraces(workspace.id);

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        {t("description")}
      </p>

      {traces.length === 0 ? (
        <p className="mt-8 rounded-lg border border-dashed border-neutral-300 p-6 text-sm text-neutral-500 dark:border-neutral-700">
          {t("none")}
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
              <tr>
                <th className="px-4 py-3 font-medium">{t("query")}</th>
                <th className="px-4 py-3 font-medium">{t("model")}</th>
                <th className="px-4 py-3 font-medium">{t("latency")}</th>
                <th className="px-4 py-3 font-medium">{t("cost")}</th>
                <th className="px-4 py-3 font-medium">{t("when")}</th>
              </tr>
            </thead>
            <tbody>
              {traces.map((trace) => (
                <tr
                  key={trace.id}
                  className="border-b border-neutral-100 last:border-0 dark:border-neutral-900"
                >
                  <td className="px-4 py-3">
                    <Link
                      href={`/${workspaceSlug}/traces/${trace.id}`}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {trace.query.slice(0, 80) || t("empty")}
                    </Link>
                    {trace.error && (
                      <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-950 dark:text-red-300">
                        {t("error")}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-neutral-500">
                    {trace.model ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-neutral-500">
                    {trace.latencyMs == null ? "—" : `${trace.latencyMs} ms`}
                  </td>
                  <td className="px-4 py-3 text-neutral-500">
                    {formatCost(trace.costEstimate)}
                  </td>
                  <td className="px-4 py-3 text-neutral-500">
                    {formatDate(trace.createdAt)}
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
