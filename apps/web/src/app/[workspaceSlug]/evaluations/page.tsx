import Link from "next/link";
import { notFound } from "next/navigation";

import { CreateEvaluationDatasetForm } from "@/components/evaluation/CreateEvaluationDatasetForm";
import { hasMinRole } from "@/lib/authz";
import { listEvaluationDatasets } from "@/lib/evaluation";
import { listKnowledgeBases } from "@/lib/knowledge-base";
import { requireUser } from "@/lib/session";
import { getUserWorkspaceBySlug } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export default async function EvaluationsPage({
  params,
}: PageProps<"/[workspaceSlug]/evaluations">) {
  const { workspaceSlug } = await params;
  const user = await requireUser(`/${workspaceSlug}/evaluations`);
  const workspace = await getUserWorkspaceBySlug(user.id, workspaceSlug);
  if (!workspace) {
    notFound();
  }

  const canManage = hasMinRole(workspace.role, "ADMIN");
  const [datasets, knowledgeBases] = await Promise.all([
    listEvaluationDatasets(workspace.id),
    canManage ? listKnowledgeBases(workspace.id) : Promise.resolve([]),
  ]);

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Evaluations</h1>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        Build evaluation datasets of questions with expected answers, then run
        them against a RAG configuration to measure and compare answer quality.
      </p>

      <section className="mt-8">
        {datasets.length === 0 ? (
          <p className="rounded-lg border border-dashed border-neutral-300 p-6 text-sm text-neutral-500 dark:border-neutral-700">
            No evaluation datasets yet.
            {canManage ? " Create your first one below." : ""}
          </p>
        ) : (
          <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {datasets.map((ds) => (
              <li key={ds.id}>
                <Link
                  href={`/${workspaceSlug}/evaluations/${ds.id}`}
                  className="flex items-center justify-between gap-4 px-4 py-3 transition hover:bg-neutral-50 dark:hover:bg-neutral-900"
                >
                  <span className="min-w-0">
                    <span className="font-medium">{ds.name}</span>
                    {ds.knowledgeBaseName && (
                      <span className="ml-2 text-xs text-neutral-500">
                        · {ds.knowledgeBaseName}
                      </span>
                    )}
                    {ds.description && (
                      <span className="block truncate text-sm text-neutral-500">
                        {ds.description}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-xs text-neutral-500">
                    {ds.caseCount} case{ds.caseCount === 1 ? "" : "s"} ·{" "}
                    {ds.runCount} run{ds.runCount === 1 ? "" : "s"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {canManage && (
        <section className="mt-10 max-w-lg">
          <h2 className="text-lg font-medium">New dataset</h2>
          <div className="mt-3">
            <CreateEvaluationDatasetForm
              workspaceSlug={workspaceSlug}
              knowledgeBases={knowledgeBases.map((kb) => ({
                id: kb.id,
                name: kb.name,
              }))}
            />
          </div>
        </section>
      )}
    </main>
  );
}
