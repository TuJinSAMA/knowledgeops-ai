export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-8 px-6 py-16">
      <div className="space-y-3">
        <p className="text-sm font-medium uppercase tracking-widest text-neutral-500">
          Hameo
        </p>
        <h1 className="text-4xl font-bold tracking-tight">KnowledgeOps AI</h1>
        <p className="text-lg text-neutral-600 dark:text-neutral-400">
          An enterprise AI knowledge quality platform for building, evaluating,
          and operating trustworthy RAG-powered knowledge assistants.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {[
          ["Knowledge Management", "Ingest, chunk, embed and version enterprise knowledge."],
          ["RAG Observability", "Trace every answer: retrieval, context, cost and latency."],
          ["Evaluation", "Datasets and batch runs to measure answer quality."],
          ["Enterprise Readiness", "Multi-tenant workspaces, RBAC, quotas and audit logs."],
        ].map(([title, desc]) => (
          <div
            key={title}
            className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
          >
            <h2 className="font-semibold">{title}</h2>
            <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
              {desc}
            </p>
          </div>
        ))}
      </div>

      <div className="flex gap-4 text-sm">
        <a
          className="rounded-md bg-neutral-900 px-4 py-2 font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          href="/api/health"
        >
          System health
        </a>
      </div>
    </main>
  );
}
