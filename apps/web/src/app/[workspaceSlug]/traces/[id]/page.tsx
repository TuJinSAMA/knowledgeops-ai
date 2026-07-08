import Link from "next/link";
import { notFound } from "next/navigation";

import { requireUser } from "@/lib/session";
import { getTrace, type TraceRetrievedChunk } from "@/lib/trace";
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
}: PageProps<"/[workspaceSlug]/traces/[id]">) {
  const { workspaceSlug, id } = await params;
  const user = await requireUser(`/${workspaceSlug}/traces/${id}`);
  const workspace = await getUserWorkspaceBySlug(user.id, workspaceSlug);
  if (!workspace) {
    notFound();
  }

  const trace = await getTrace(workspace.id, id);
  if (!trace) {
    notFound();
  }

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
        ← All traces
      </Link>

      <h1 className="mt-3 text-2xl font-semibold tracking-tight">
        Answer trace
      </h1>
      <p className="mt-1 text-xs text-neutral-500">
        {trace.createdAt.toISOString().replace("T", " ").slice(0, 19)} ·{" "}
        <code className="font-mono">{trace.id}</code>
      </p>

      {trace.error && (
        <div className="mt-6 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          <div className="font-medium">Error</div>
          <p className="mt-1 whitespace-pre-wrap">{trace.error}</p>
        </div>
      )}

      <section className="mt-6">
        <h2 className="text-sm font-medium text-neutral-500">Question</h2>
        <p className="mt-2 whitespace-pre-wrap rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          {trace.query}
        </p>
      </section>

      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Model" value={trace.model ?? "—"} />
        <Stat
          label="Latency"
          value={trace.latencyMs == null ? "—" : `${trace.latencyMs} ms`}
        />
        <Stat
          label="Total tokens"
          value={usage.total_tokens != null ? String(usage.total_tokens) : "—"}
        />
        <Stat
          label="Est. cost"
          value={cost == null ? "—" : `$${cost.toFixed(6)}`}
        />
      </section>

      {(usage.prompt_tokens != null ||
        usage.completion_tokens != null ||
        Object.keys(stages).length > 0) && (
        <section className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {usage.prompt_tokens != null && (
            <Stat label="Prompt tokens" value={String(usage.prompt_tokens)} />
          )}
          {usage.completion_tokens != null && (
            <Stat
              label="Completion tokens"
              value={String(usage.completion_tokens)}
            />
          )}
          {Object.entries(stages).map(([name, ms]) => (
            <Stat
              key={name}
              label={`${name} latency`}
              value={`${Math.round(ms)} ms`}
            />
          ))}
        </section>
      )}

      <section className="mt-8">
        <h2 className="text-lg font-medium">
          Retrieved chunks{" "}
          <span className="text-sm font-normal text-neutral-500">
            ({chunks.length})
          </span>
        </h2>
        {chunks.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">
            No chunks cleared the relevance threshold — the assistant likely
            refused to answer.
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {chunks.map((c, i) => (
              <li
                key={c.chunkId ?? i}
                className="rounded-lg border border-neutral-200 p-3 text-sm dark:border-neutral-800"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    [{i + 1}] document{" "}
                    <code className="font-mono text-xs">{c.documentId}</code>
                    {c.chunkIndex != null && (
                      <span className="text-neutral-500">
                        {" "}
                        · chunk #{c.chunkIndex}
                      </span>
                    )}
                  </span>
                  {typeof c.score === "number" && (
                    <span className="text-neutral-400">
                      score {c.score.toFixed(4)}
                    </span>
                  )}
                </div>
                {c.snippet && (
                  <p className="mt-2 whitespace-pre-wrap text-neutral-600 dark:text-neutral-400">
                    {c.snippet}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-medium">Final context sent to the model</h2>
        {trace.finalContext ? (
          <pre className="mt-3 max-h-96 overflow-auto rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-xs leading-relaxed dark:border-neutral-800 dark:bg-neutral-950">
            {trace.finalContext}
          </pre>
        ) : (
          <p className="mt-2 text-sm text-neutral-500">
            No context was assembled (refusal or error).
          </p>
        )}
      </section>

      {trace.response && (
        <section className="mt-8">
          <h2 className="text-lg font-medium">Model response</h2>
          <p className="mt-3 whitespace-pre-wrap rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
            {trace.response}
          </p>
        </section>
      )}
    </main>
  );
}
