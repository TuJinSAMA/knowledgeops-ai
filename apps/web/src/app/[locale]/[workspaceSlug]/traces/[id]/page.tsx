import { Link } from "@/i18n/navigation";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { requireUser } from "@/lib/session";
import { getTraceDetail, type TraceRetrievedChunk } from "@/lib/trace";
import { getUserWorkspaceBySlug } from "@/lib/workspace";

export const dynamic = "force-dynamic";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-800">
      <div className="text-xs uppercase tracking-wide text-neutral-500">
        {label}
      </div>
      <div className="mt-1 text-sm font-medium">{value}</div>
    </div>
  );
}

export default async function TraceDetailPage({
  params,
}: PageProps<"/[locale]/[workspaceSlug]/traces/[id]">) {
  const { locale, workspaceSlug, id } = await params;
  const t = await getTranslations({ locale, namespace: "traces" });
  const formatDate = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }).format;
  const user = await requireUser(`/${workspaceSlug}/traces/${id}`);
  const workspace = await getUserWorkspaceBySlug(user.id, workspaceSlug);
  if (!workspace) {
    notFound();
  }

  const detail = await getTraceDetail(workspace.id, id);
  if (!detail) {
    notFound();
  }
  const { trace, knowledgeBaseId, knowledgeBaseName, documentTitles } = detail;

  const chunks = (trace.retrievedChunks ?? []) as TraceRetrievedChunk[];
  const usage = trace.tokenUsage ?? {};
  const stages = trace.stageLatencyMs ?? {};
  const cost =
    trace.costEstimate == null ? null : Number(trace.costEstimate);

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <Link
        href={`/${workspaceSlug}/traces`}
        className="text-sm text-neutral-500 underline-offset-4 hover:underline"
      >
        {t("back")}
      </Link>

      <div className="mt-3 flex flex-wrap items-center gap-2.5">
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("detail")}
        </h1>
        {trace.refused && !trace.error && (
          <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            {t("refusedBadge")}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-neutral-500">
        {formatDate(trace.createdAt)} ·{" "}
        <code className="font-mono">{trace.id}</code>
        {knowledgeBaseId && knowledgeBaseName && (
          <>
            {" · "}
            <Link
              href={`/${workspaceSlug}/knowledge-bases/${knowledgeBaseId}`}
              className="underline-offset-4 hover:underline"
            >
              {knowledgeBaseName}
            </Link>
          </>
        )}
      </p>

      {trace.error && (
        <div className="mt-6 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          <div className="font-medium">{t("error")}</div>
          <p className="mt-1 whitespace-pre-wrap">{trace.error}</p>
        </div>
      )}

      <section className="mt-6">
        <h2 className="text-sm font-medium text-neutral-500">{t("question")}</h2>
        <p className="mt-2 whitespace-pre-wrap rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          {trace.query}
        </p>
      </section>

      {trace.rewrittenQuery && trace.rewrittenQuery !== trace.query && (
        <section className="mt-4">
          <h2 className="text-sm font-medium text-neutral-500">
            {t("rewrittenQuery")}
          </h2>
          <p className="mt-2 whitespace-pre-wrap rounded-lg border border-blue-200 bg-blue-50/50 p-4 text-sm text-blue-950 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200">
            {trace.rewrittenQuery}
          </p>
        </section>
      )}

      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={t("model")} value={trace.model ?? "—"} />
        <Stat
          label={t("latency")}
          value={trace.latencyMs == null ? "—" : `${trace.latencyMs} ms`}
        />
        <Stat
          label={t("totalTokens")}
          value={usage.total_tokens != null ? String(usage.total_tokens) : "—"}
        />
        <Stat
          label={t("estimatedCost")}
          value={cost == null ? "—" : `$${cost.toFixed(6)}`}
        />
      </section>

      {(usage.prompt_tokens != null ||
        usage.completion_tokens != null ||
        Object.keys(stages).length > 0) && (
        <section className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {usage.prompt_tokens != null && (
            <Stat label={t("promptTokens")} value={String(usage.prompt_tokens)} />
          )}
          {usage.completion_tokens != null && (
            <Stat
              label={t("completionTokens")}
              value={String(usage.completion_tokens)}
            />
          )}
          {Object.entries(stages).map(([name, ms]) => (
            <Stat
              key={name}
              label={t("stageLatency", { name })}
              value={`${Math.round(ms)} ms`}
            />
          ))}
        </section>
      )}

      <section className="mt-8">
        <h2 className="text-lg font-medium">
          {t("retrievedChunks", { count: chunks.length })}
        </h2>
        {chunks.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">
            {t("noChunks")}
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {chunks.map((c, i) => {
              const docTitle = documentTitles.get(c.documentId) ?? null;
              const chunkHref =
                knowledgeBaseId && docTitle
                  ? `/${workspaceSlug}/knowledge-bases/${knowledgeBaseId}/documents/${c.documentId}${
                      c.chunkIndex != null ? `#chunk-${c.chunkIndex}` : ""
                    }`
                  : null;
              return (
                <li
                  key={c.chunkId ?? i}
                  className="rounded-lg border border-neutral-200 p-3 text-sm dark:border-neutral-800"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">
                      {chunkHref ? (
                        <Link
                          href={chunkHref}
                          className="underline-offset-4 hover:underline"
                        >
                          [{i + 1}] {docTitle}
                          {c.chunkIndex != null
                            ? ` · ${t("chunk", { index: c.chunkIndex })}`
                            : ""}
                        </Link>
                      ) : (
                        <>
                          {t("document", { index: i + 1 })}{" "}
                          <code className="font-mono text-xs">
                            {c.documentId}
                          </code>
                          {c.chunkIndex != null && (
                            <span className="text-neutral-500">
                              {" "}
                              · {t("chunk", { index: c.chunkIndex })}
                            </span>
                          )}
                        </>
                      )}
                    </span>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-400">
                      {typeof c.vectorScore === "number" && (
                        <span>
                          {t("vectorScore", { score: c.vectorScore.toFixed(4) })}
                        </span>
                      )}
                      {typeof c.keywordScore === "number" && (
                        <span>
                          {t("keywordScore", {
                            score: c.keywordScore.toFixed(4),
                          })}
                        </span>
                      )}
                      {typeof c.score === "number" && (
                        <span className="font-medium text-neutral-600 dark:text-neutral-300">
                          {t("score", { score: c.score.toFixed(4) })}
                        </span>
                      )}
                    </div>
                  </div>
                  {c.snippet && (
                    <p className="mt-2 whitespace-pre-wrap text-neutral-600 dark:text-neutral-400">
                      {c.snippet}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-medium">{t("finalContext")}</h2>
        {trace.finalContext ? (
          <pre className="mt-3 max-h-96 overflow-auto rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-xs leading-relaxed dark:border-neutral-800 dark:bg-neutral-950">
            {trace.finalContext}
          </pre>
        ) : (
          <p className="mt-2 text-sm text-neutral-500">
            {t("noContext")}
          </p>
        )}
      </section>

      {trace.response && (
        <section className="mt-8">
          <h2 className="text-lg font-medium">{t("response")}</h2>
          <p className="mt-3 whitespace-pre-wrap rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
            {trace.response}
          </p>
        </section>
      )}
    </main>
  );
}
