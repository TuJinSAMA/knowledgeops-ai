import { Link } from "@/i18n/navigation";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { listKnowledgeBases } from "@/lib/knowledge-base";
import { requireUser } from "@/lib/session";
import {
  listTracesFiltered,
  TRACE_STATUS_FILTERS,
  type TraceStatusFilter,
} from "@/lib/trace";
import { getUserWorkspaceBySlug } from "@/lib/workspace";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 30;
const LATENCY_THRESHOLDS = [1000, 3000, 5000] as const;

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

function buildTracesQuery(params: {
  kb?: string;
  status?: TraceStatusFilter;
  latency?: number;
  q?: string;
  page?: number;
}): string {
  const qs = new URLSearchParams();
  if (params.kb) qs.set("kb", params.kb);
  if (params.status && params.status !== "ALL") qs.set("status", params.status);
  if (params.latency && params.latency > 0) {
    qs.set("latency", String(params.latency));
  }
  if (params.q) qs.set("q", params.q);
  if (params.page && params.page > 1) qs.set("page", String(params.page));
  const str = qs.toString();
  return str ? `?${str}` : "";
}

export default async function TracesPage({
  params,
  searchParams,
}: PageProps<"/[locale]/[workspaceSlug]/traces">) {
  const { locale, workspaceSlug } = await params;
  const sp = await searchParams;

  const t = await getTranslations({ locale, namespace: "traces" });
  const formatDate = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format;
  const user = await requireUser(`/${workspaceSlug}/traces`);
  const workspace = await getUserWorkspaceBySlug(user.id, workspaceSlug);
  if (!workspace) {
    notFound();
  }

  const kbParam = typeof sp.kb === "string" && sp.kb ? sp.kb : undefined;
  const statusParam: TraceStatusFilter =
    typeof sp.status === "string" &&
    TRACE_STATUS_FILTERS.includes(sp.status as TraceStatusFilter)
      ? (sp.status as TraceStatusFilter)
      : "ALL";
  const latencyRaw = typeof sp.latency === "string" ? Number(sp.latency) : 0;
  const minLatencyMs =
    Number.isFinite(latencyRaw) && latencyRaw > 0 ? latencyRaw : undefined;
  const queryParam =
    typeof sp.q === "string" && sp.q.trim() ? sp.q.trim() : undefined;
  const pageRaw = typeof sp.page === "string" ? Number.parseInt(sp.page, 10) : 1;
  const currentPage = Number.isFinite(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
  const offset = (currentPage - 1) * PAGE_SIZE;

  const [knowledgeBases, tracePage] = await Promise.all([
    listKnowledgeBases(workspace.id),
    listTracesFiltered(workspace.id, {
      knowledgeBaseId: kbParam ?? null,
      status: statusParam,
      minLatencyMs: minLatencyMs ?? null,
      query: queryParam ?? null,
      limit: PAGE_SIZE,
      offset,
    }),
  ]);

  const { items: traces, total } = tracePage;
  const hasFilters = Boolean(
    kbParam || statusParam !== "ALL" || minLatencyMs || queryParam,
  );
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        {t("description")}
      </p>

      <form
        method="get"
        className="mt-6 flex flex-wrap items-end gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
      >
        <div className="flex flex-col gap-1">
          <label htmlFor="trace-kb" className="text-xs text-neutral-500">
            {t("filters.knowledgeBase")}
          </label>
          <select
            id="trace-kb"
            name="kb"
            defaultValue={kbParam ?? ""}
            className="rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm outline-none dark:border-neutral-700"
          >
            <option value="">{t("filters.all")}</option>
            {knowledgeBases.map((kb) => (
              <option key={kb.id} value={kb.id}>
                {kb.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="trace-status" className="text-xs text-neutral-500">
            {t("filters.status")}
          </label>
          <select
            id="trace-status"
            name="status"
            defaultValue={statusParam}
            className="rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm outline-none dark:border-neutral-700"
          >
            {TRACE_STATUS_FILTERS.map((st) => (
              <option key={st} value={st}>
                {t(`filters.statusLabels.${st}`)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="trace-latency" className="text-xs text-neutral-500">
            {t("filters.minLatency")}
          </label>
          <select
            id="trace-latency"
            name="latency"
            defaultValue={minLatencyMs ? String(minLatencyMs) : ""}
            className="rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm outline-none dark:border-neutral-700"
          >
            <option value="">{t("filters.anyLatency")}</option>
            {LATENCY_THRESHOLDS.map((ms) => (
              <option key={ms} value={ms}>
                ≥ {ms / 1000}s
              </option>
            ))}
          </select>
        </div>

        <div className="flex min-w-[180px] flex-1 flex-col gap-1">
          <label htmlFor="trace-q" className="text-xs text-neutral-500">
            {t("filters.search")}
          </label>
          <input
            id="trace-q"
            name="q"
            type="search"
            defaultValue={queryParam ?? ""}
            placeholder={t("filters.searchPlaceholder")}
            className="rounded-md border border-neutral-300 bg-transparent px-2.5 py-1 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:focus:border-neutral-200"
          />
        </div>

        <button
          type="submit"
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
        >
          {t("filters.apply")}
        </button>

        {hasFilters && (
          <Link
            href={`/${workspaceSlug}/traces`}
            className="text-sm text-neutral-500 underline-offset-4 hover:underline"
          >
            {t("filters.reset")}
          </Link>
        )}
      </form>

      {traces.length === 0 ? (
        <p className="mt-8 rounded-lg border border-dashed border-neutral-300 p-6 text-sm text-neutral-500 dark:border-neutral-700">
          {hasFilters ? t("filters.noMatches") : t("none")}
        </p>
      ) : (
        <>
          <div className="mt-6 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                <tr>
                  <th className="px-4 py-3 font-medium">{t("query")}</th>
                  <th className="px-4 py-3 font-medium">
                    {t("filters.knowledgeBase")}
                  </th>
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
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Link
                          href={`/${workspaceSlug}/traces/${trace.id}`}
                          className="font-medium underline-offset-4 hover:underline"
                        >
                          {trace.query.slice(0, 70) || t("empty")}
                        </Link>
                        {trace.error ? (
                          <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-950 dark:text-red-300">
                            {t("error")}
                          </span>
                        ) : trace.refused ? (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                            {t("refusedShort")}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-neutral-500">
                      {trace.knowledgeBaseName ?? "—"}
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

          <div className="mt-4 flex items-center justify-between text-xs text-neutral-500">
            <span>
              {t("filters.paginationSummary", {
                from: offset + 1,
                to: offset + traces.length,
                total,
              })}
            </span>
            {totalPages > 1 && (
              <div className="flex items-center gap-2">
                {currentPage > 1 && (
                  <Link
                    href={`/${workspaceSlug}/traces${buildTracesQuery({
                      kb: kbParam,
                      status: statusParam,
                      latency: minLatencyMs,
                      q: queryParam,
                      page: currentPage - 1,
                    })}`}
                    className="rounded border border-neutral-300 px-2.5 py-1 hover:border-neutral-600 dark:border-neutral-700"
                  >
                    {t("filters.prevPage")}
                  </Link>
                )}
                <span>
                  {currentPage} / {totalPages}
                </span>
                {currentPage < totalPages && (
                  <Link
                    href={`/${workspaceSlug}/traces${buildTracesQuery({
                      kb: kbParam,
                      status: statusParam,
                      latency: minLatencyMs,
                      q: queryParam,
                      page: currentPage + 1,
                    })}`}
                    className="rounded border border-neutral-300 px-2.5 py-1 hover:border-neutral-600 dark:border-neutral-700"
                  >
                    {t("filters.nextPage")}
                  </Link>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </main>
  );
}
