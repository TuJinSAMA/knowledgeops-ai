import { Link } from "@/i18n/navigation";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { CopyChunkIdButton } from "@/components/knowledge-base/CopyChunkIdButton";
import {
  type DocumentStatus,
  getDocumentDetail,
  listDocumentChunks,
  parseChunkContextHeader,
} from "@/lib/knowledge-base";
import { requireUser } from "@/lib/session";
import { getUserWorkspaceBySlug } from "@/lib/workspace";

export const dynamic = "force-dynamic";

const STATUS_STYLES: Record<DocumentStatus, string> = {
  PENDING:
    "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  PROCESSING:
    "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  INGESTED:
    "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  FAILED: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

function formatByteSize(bytes: number | null): string {
  if (bytes == null || !Number.isFinite(bytes)) {
    return "—";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

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

export default async function DocumentChunkInspectorPage({
  params,
  searchParams,
}: PageProps<"/[locale]/[workspaceSlug]/knowledge-bases/[knowledgeBaseId]/documents/[documentId]">) {
  const { locale, workspaceSlug, knowledgeBaseId, documentId } = await params;
  const sp = await searchParams;
  const queryParam = typeof sp.q === "string" ? sp.q.trim() : "";

  const t = await getTranslations({ locale, namespace: "knowledgeBases" });
  const formatNumber = new Intl.NumberFormat(locale).format;
  const formatDate = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format;

  const user = await requireUser(
    `/${workspaceSlug}/knowledge-bases/${knowledgeBaseId}/documents/${documentId}`,
  );
  const workspace = await getUserWorkspaceBySlug(user.id, workspaceSlug);
  if (!workspace) {
    notFound();
  }

  const doc = await getDocumentDetail(
    workspace.id,
    knowledgeBaseId,
    documentId,
  );
  if (!doc) {
    notFound();
  }

  const chunks = await listDocumentChunks(
    workspace.id,
    knowledgeBaseId,
    documentId,
    { query: queryParam || null },
  );

  const selfPath = `/${workspaceSlug}/knowledge-bases/${knowledgeBaseId}/documents/${documentId}`;

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <Link
        href={`/${workspaceSlug}/knowledge-bases/${knowledgeBaseId}`}
        className="text-sm text-neutral-500 underline-offset-4 hover:underline"
      >
        ← {doc.knowledgeBaseName}
      </Link>

      <div className="mt-3 flex flex-wrap items-center gap-2.5">
        <h1 className="text-2xl font-semibold tracking-tight">{doc.title}</h1>
        <span className="rounded bg-neutral-100 px-2 py-0.5 font-mono text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
          v{doc.version}
        </span>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[doc.status]}`}
        >
          {t(`status.${doc.status}`)}
        </span>
      </div>
      <p className="mt-1 text-xs text-neutral-500">
        {t("chunkInspector.updatedAt", { date: formatDate(doc.updatedAt) })} ·{" "}
        <code className="font-mono">{doc.id}</code>
      </p>

      {doc.status === "FAILED" && doc.lastError && (
        <div className="mt-6 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          <div className="font-medium">{t("status.FAILED")}</div>
          <p className="mt-1 whitespace-pre-wrap">{doc.lastError}</p>
        </div>
      )}

      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={t("chunkInspector.mimeType")} value={doc.mimeType} />
        <Stat
          label={t("chunkInspector.fileSize")}
          value={formatByteSize(doc.byteSize)}
        />
        <Stat
          label={t("chunkInspector.totalChunks")}
          value={formatNumber(doc.chunkCount)}
        />
        <Stat
          label={t("chunkInspector.totalTokens")}
          value={formatNumber(doc.totalTokens)}
        />
      </section>

      <form
        method="get"
        className="mt-8 flex flex-wrap items-center gap-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800"
      >
        <input
          type="search"
          name="q"
          defaultValue={queryParam}
          placeholder={t("chunkInspector.searchPlaceholder")}
          className="min-w-[200px] flex-1 rounded-md border border-neutral-300 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:focus:border-neutral-200"
        />
        <button
          type="submit"
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
        >
          {t("chunkInspector.search")}
        </button>
        {queryParam && (
          <Link
            href={selfPath}
            className="px-2 text-sm text-neutral-500 underline-offset-4 hover:underline"
          >
            {t("chunkInspector.clearSearch")}
          </Link>
        )}
      </form>

      <section className="mt-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">
            {queryParam
              ? t("chunkInspector.matchingChunks", {
                  matched: chunks.length,
                  total: doc.chunkCount,
                })
              : t("chunkInspector.chunksHeading", { count: chunks.length })}
          </h2>
        </div>

        {chunks.length === 0 ? (
          <p className="mt-3 rounded-lg border border-dashed border-neutral-300 p-6 text-sm text-neutral-500 dark:border-neutral-700">
            {queryParam
              ? t("chunkInspector.noMatchingChunks")
              : doc.status === "INGESTED"
                ? t("chunkInspector.emptyChunks")
                : t("chunkInspector.pendingIngestion")}
          </p>
        ) : (
          <ol className="mt-4 space-y-3">
            {chunks.map((chunk) => {
              const { header, body } = parseChunkContextHeader(chunk.content);
              return (
                <li
                  key={chunk.id}
                  id={`chunk-${chunk.chunkIndex}`}
                  className="scroll-mt-24 rounded-lg border border-neutral-200 p-4 transition target:border-neutral-900 target:ring-2 target:ring-neutral-900/15 dark:border-neutral-800 dark:target:border-neutral-100 dark:target:ring-neutral-100/20"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <a
                        href={`#chunk-${chunk.chunkIndex}`}
                        className="rounded bg-neutral-100 px-2 py-0.5 font-mono text-xs font-semibold text-neutral-800 hover:underline dark:bg-neutral-800 dark:text-neutral-200"
                      >
                        #{chunk.chunkIndex}
                      </a>
                      {header?.section && (
                        <span className="rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-900 dark:bg-blue-950/50 dark:text-blue-200">
                          {header.section}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-neutral-500">
                      {chunk.tokenCount != null && (
                        <span>
                          {t("chunkInspector.tokens", {
                            count: chunk.tokenCount,
                          })}
                        </span>
                      )}
                      <CopyChunkIdButton
                        chunkId={chunk.id}
                        copyLabel={t("chunkInspector.copyId")}
                        copiedLabel={t("chunkInspector.copied")}
                      />
                    </div>
                  </div>
                  <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-neutral-800 dark:text-neutral-200">
                    {body}
                  </p>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </main>
  );
}
