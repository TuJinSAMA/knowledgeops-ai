"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type DocumentStatus = "PENDING" | "PROCESSING" | "INGESTED" | "FAILED";

type DocumentSummary = {
  id: string;
  title: string;
  mimeType: string;
  status: DocumentStatus;
  chunkCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

const ACCEPT = ".md,.markdown,.txt,.text,.pdf,text/markdown,text/plain,application/pdf";

// Statuses that are still progressing; while any document is in one of these we
// keep polling so the UI reflects ingestion as it advances.
const IN_FLIGHT: ReadonlySet<DocumentStatus> = new Set(["PENDING", "PROCESSING"]);

const STATUS_STYLES: Record<DocumentStatus, string> = {
  PENDING:
    "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  PROCESSING:
    "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  INGESTED:
    "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  FAILED: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

export function DocumentsPanel({
  endpoint,
  initialDocuments,
  canUpload,
}: {
  endpoint: string;
  initialDocuments: DocumentSummary[];
  canUpload: boolean;
}) {
  const [documents, setDocuments] = useState<DocumentSummary[]>(initialDocuments);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const handleUpload = useCallback(
    async (file: File) => {
      setError(null);
      setUploading(true);
      try {
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch(endpoint, { method: "POST", body: formData });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          setError(data.error ?? `Upload failed (${res.status})`);
          return;
        }
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
        await refresh();
      } catch {
        setError("Upload failed. Please try again.");
      } finally {
        setUploading(false);
      }
    },
    [endpoint, refresh],
  );

  return (
    <div className="space-y-6">
      {canUpload && (
        <div className="space-y-2">
          <label
            htmlFor="document-file"
            className="block text-sm font-medium"
          >
            Upload a document
          </label>
          <input
            id="document-file"
            ref={fileInputRef}
            type="file"
            accept={ACCEPT}
            disabled={uploading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                void handleUpload(file);
              }
            }}
            className="block w-full text-sm text-neutral-600 file:mr-3 file:rounded-md file:border-0 file:bg-neutral-900 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-neutral-700 disabled:opacity-60 dark:text-neutral-400 dark:file:bg-white dark:file:text-neutral-900"
          />
          <p className="text-xs text-neutral-500">
            Markdown, plain text, or PDF.
          </p>
          {uploading && (
            <p className="text-sm text-neutral-500">Uploading…</p>
          )}
          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}
        </div>
      )}

      <div>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Documents</h2>
          <button
            type="button"
            onClick={() => void refresh()}
            className="text-xs text-neutral-500 underline-offset-4 hover:underline"
          >
            Refresh
          </button>
        </div>

        {documents.length === 0 ? (
          <p className="mt-3 rounded-lg border border-dashed border-neutral-300 p-6 text-sm text-neutral-500 dark:border-neutral-700">
            No documents yet.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {documents.map((doc) => (
              <li key={doc.id} className="px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{doc.title}</p>
                    <p className="text-xs text-neutral-500">
                      {doc.mimeType}
                      {doc.status === "INGESTED" && (
                        <>
                          {" · "}
                          {doc.chunkCount} chunk
                          {doc.chunkCount === 1 ? "" : "s"}
                        </>
                      )}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[doc.status]}`}
                  >
                    {doc.status}
                  </span>
                </div>
                {doc.status === "FAILED" && doc.lastError && (
                  <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
                    {doc.lastError}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
