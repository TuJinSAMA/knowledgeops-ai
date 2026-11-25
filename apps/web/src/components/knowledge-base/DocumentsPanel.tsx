"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { Link } from "@/i18n/navigation";

type DocumentStatus = "PENDING" | "PROCESSING" | "INGESTED" | "FAILED";

type DocumentSummary = {
  id: string;
  title: string;
  mimeType: string;
  status: DocumentStatus;
  version: number;
  byteSize: number | null;
  chunkCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

const ACCEPT =
  ".md,.markdown,.txt,.text,.pdf,text/markdown,text/plain,application/pdf";

// Statuses that are still progressing; while any document is in one of these we
// keep polling so the UI reflects ingestion as it advances.
const IN_FLIGHT: ReadonlySet<DocumentStatus> = new Set([
  "PENDING",
  "PROCESSING",
]);

const STATUS_STYLES: Record<DocumentStatus, string> = {
  PENDING:
    "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  PROCESSING:
    "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  INGESTED:
    "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  FAILED: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

function formatByteSize(bytes: number | null): string | null {
  if (bytes == null || !Number.isFinite(bytes)) {
    return null;
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function DocumentsPanel({
  endpoint,
  documentDetailBasePath,
  initialDocuments,
  canUpload,
}: {
  endpoint: string;
  documentDetailBasePath: string;
  initialDocuments: DocumentSummary[];
  canUpload: boolean;
}) {
  const t = useTranslations("knowledgeBases");
  const errorT = useTranslations("errors");
  const [documents, setDocuments] =
    useState<DocumentSummary[]>(initialDocuments);
  const [uploadProgress, setUploadProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const [busyDocId, setBusyDocId] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const replaceTargetIdRef = useRef<string | null>(null);

  const resolveErrorMessage = useCallback(
    (
      data: { error?: string; errorCode?: string },
      fallbackStatus: number,
    ): string => {
      if (data.errorCode && errorT.has(data.errorCode)) {
        return errorT(data.errorCode);
      }
      return data.error ?? t("uploadFailedStatus", { status: fallbackStatus });
    },
    [errorT, t],
  );

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(endpoint, { cache: "no-store" });
      if (!res.ok) {
        return;
      }
      const data = (await res.json()) as { documents: DocumentSummary[] };
      setDocuments(data.documents);
    } catch {
      // Transient fetch failure during polling; keep the last known state.
    }
  }, [endpoint]);

  // Poll while any document is still being ingested.
  useEffect(() => {
    const hasInFlight = documents.some((doc) => IN_FLIGHT.has(doc.status));
    if (!hasInFlight) {
      return;
    }
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [documents, refresh]);

  const handleUploadBatch = useCallback(
    async (files: File[]) => {
      if (files.length === 0) {
        return;
      }
      setError(null);
      const errors: string[] = [];
      for (let i = 0; i < files.length; i += 1) {
        setUploadProgress({ current: i + 1, total: files.length });
        try {
          const formData = new FormData();
          formData.append("file", files[i]);
          const res = await fetch(endpoint, { method: "POST", body: formData });
          if (!res.ok) {
            const data = (await res.json().catch(() => ({}))) as {
              error?: string;
              errorCode?: string;
            };
            errors.push(
              `${files[i].name}: ${resolveErrorMessage(data, res.status)}`,
            );
          }
        } catch {
          errors.push(`${files[i].name}: ${t("uploadFailed")}`);
        }
      }
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      setUploadProgress(null);
      if (errors.length > 0) {
        setError(errors.join(" · "));
      }
      await refresh();
    },
    [endpoint, refresh, resolveErrorMessage, t],
  );

  const handleReplace = useCallback(
    async (documentId: string, file: File) => {
      setError(null);
      setBusyDocId(documentId);
      try {
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch(`${endpoint}/${documentId}`, {
          method: "PUT",
          body: formData,
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string;
            errorCode?: string;
          };
          setError(resolveErrorMessage(data, res.status));
          return;
        }
        await refresh();
      } catch {
        setError(t("uploadFailed"));
      } finally {
        setBusyDocId(null);
        replaceTargetIdRef.current = null;
        if (replaceInputRef.current) {
          replaceInputRef.current.value = "";
        }
      }
    },
    [endpoint, refresh, resolveErrorMessage, t],
  );

  const handleRetry = useCallback(
    async (documentId: string) => {
      setError(null);
      setBusyDocId(documentId);
      try {
        const res = await fetch(`${endpoint}/${documentId}/retry`, {
          method: "POST",
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string;
            errorCode?: string;
          };
          setError(resolveErrorMessage(data, res.status));
          return;
        }
        await refresh();
      } catch {
        setError(t("actionFailed"));
      } finally {
        setBusyDocId(null);
      }
    },
    [endpoint, refresh, resolveErrorMessage, t],
  );

  const handleDelete = useCallback(
    async (doc: DocumentSummary) => {
      if (!window.confirm(t("deleteDocConfirm", { title: doc.title }))) {
        return;
      }
      setError(null);
      setBusyDocId(doc.id);
      try {
        const res = await fetch(`${endpoint}/${doc.id}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string;
            errorCode?: string;
          };
          setError(resolveErrorMessage(data, res.status));
          return;
        }
        await refresh();
      } catch {
        setError(t("actionFailed"));
      } finally {
        setBusyDocId(null);
      }
    },
    [endpoint, refresh, resolveErrorMessage, t],
  );

  const uploading = uploadProgress !== null;

  return (
    <div className="space-y-6">
      {canUpload && (
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragActive(false);
            if (uploading) return;
            const dropped = Array.from(event.dataTransfer.files ?? []);
            if (dropped.length > 0) {
              void handleUploadBatch(dropped);
            }
          }}
          className={`space-y-2 rounded-lg border border-dashed p-4 transition ${
            dragActive
              ? "border-neutral-900 bg-neutral-50 dark:border-neutral-200 dark:bg-neutral-900"
              : "border-neutral-300 dark:border-neutral-700"
          }`}
        >
          <label htmlFor="document-file" className="block text-sm font-medium">
            {t("upload")}
          </label>
          <input
            id="document-file"
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPT}
            disabled={uploading}
            onChange={(event) => {
              const selected = Array.from(event.target.files ?? []);
              if (selected.length > 0) {
                void handleUploadBatch(selected);
              }
            }}
            className="block w-full text-sm text-neutral-600 file:mr-3 file:rounded-md file:border-0 file:bg-neutral-900 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-neutral-700 disabled:opacity-60 dark:text-neutral-400 dark:file:bg-white dark:file:text-neutral-900"
          />
          <p className="text-xs text-neutral-500">{t("acceptedFilesBatch")}</p>
          {uploadProgress && (
            <p className="text-sm text-neutral-500">
              {t("uploadingBatch", {
                current: uploadProgress.current,
                total: uploadProgress.total,
              })}
            </p>
          )}
          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}

          {/* Hidden single-file input used by per-row "Replace version" */}
          <input
            ref={replaceInputRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              const targetId = replaceTargetIdRef.current;
              if (file && targetId) {
                void handleReplace(targetId, file);
              }
            }}
          />
        </div>
      )}

      <div>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">{t("documentsTitle")}</h2>
          <button
            type="button"
            onClick={() => void refresh()}
            className="text-xs text-neutral-500 underline-offset-4 hover:underline"
          >
            {t("refresh")}
          </button>
        </div>

        {documents.length === 0 ? (
          <p className="mt-3 rounded-lg border border-dashed border-neutral-300 p-6 text-sm text-neutral-500 dark:border-neutral-700">
            {t("noDocuments")}
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {documents.map((doc) => {
              const sizeLabel = formatByteSize(doc.byteSize);
              const isBusy = busyDocId === doc.id || doc.status === "PROCESSING";
              return (
                <li key={doc.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`${documentDetailBasePath}/${doc.id}`}
                          className="truncate font-medium underline-offset-4 hover:underline"
                        >
                          {doc.title}
                        </Link>
                        {doc.version > 1 && (
                          <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                            v{doc.version}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-neutral-500">
                        {doc.mimeType}
                        {sizeLabel ? ` · ${sizeLabel}` : ""}
                        {doc.status === "INGESTED" && (
                          <>
                            {" · "}
                            {t("chunks", { count: doc.chunkCount })}
                          </>
                        )}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[doc.status]}`}
                      >
                        {t(`status.${doc.status}`)}
                      </span>

                      <Link
                        href={`${documentDetailBasePath}/${doc.id}`}
                        className="rounded border border-neutral-200 px-2 py-1 text-xs text-neutral-600 transition hover:border-neutral-400 dark:border-neutral-800 dark:text-neutral-300 dark:hover:border-neutral-600"
                      >
                        {t("inspectChunks")}
                      </Link>

                      {canUpload && doc.status === "FAILED" && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void handleRetry(doc.id)}
                          className="rounded border border-amber-300 px-2 py-1 text-xs font-medium text-amber-800 transition hover:bg-amber-50 disabled:opacity-50 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-950"
                        >
                          {t("retryIngest")}
                        </button>
                      )}

                      {canUpload && (
                        <>
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => {
                              replaceTargetIdRef.current = doc.id;
                              replaceInputRef.current?.click();
                            }}
                            className="rounded border border-neutral-200 px-2 py-1 text-xs text-neutral-600 transition hover:border-neutral-400 disabled:opacity-50 dark:border-neutral-800 dark:text-neutral-300 dark:hover:border-neutral-600"
                          >
                            {t("replaceDoc")}
                          </button>
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => void handleDelete(doc)}
                            className="rounded border border-red-200 px-2 py-1 text-xs text-red-600 transition hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
                          >
                            {t("deleteDoc")}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  {doc.status === "FAILED" && doc.lastError && (
                    <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
                      {doc.lastError}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
