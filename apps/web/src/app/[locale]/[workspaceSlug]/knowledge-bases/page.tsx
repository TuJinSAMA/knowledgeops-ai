import { Link } from "@/i18n/navigation";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { CreateKnowledgeBaseForm } from "@/components/knowledge-base/CreateKnowledgeBaseForm";
import { hasMinRole } from "@/lib/authz";
import { listKnowledgeBases } from "@/lib/knowledge-base";
import { requireUser } from "@/lib/session";
import { getUserWorkspaceBySlug } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export default async function KnowledgeBasesPage({
  params,
}: PageProps<"/[locale]/[workspaceSlug]/knowledge-bases">) {
  const { locale, workspaceSlug } = await params;
  const t = await getTranslations({ locale, namespace: "knowledgeBases" });
  const user = await requireUser(`/${workspaceSlug}/knowledge-bases`);
  const workspace = await getUserWorkspaceBySlug(user.id, workspaceSlug);
  if (!workspace) {
    notFound();
  }

  const canManage = hasMinRole(workspace.role, "ADMIN");
  const knowledgeBases = await listKnowledgeBases(workspace.id);

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        {t("description")}
      </p>

      <section className="mt-8">
        {knowledgeBases.length === 0 ? (
          <p className="rounded-lg border border-dashed border-neutral-300 p-6 text-sm text-neutral-500 dark:border-neutral-700">
            {t("none")}
            {canManage ? ` ${t("createFirst")}` : ""}
          </p>
        ) : (
          <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {knowledgeBases.map((kb) => (
              <li key={kb.id}>
                <Link
                  href={`/${workspaceSlug}/knowledge-bases/${kb.id}`}
                  className="flex items-center justify-between px-4 py-3 transition hover:bg-neutral-50 dark:hover:bg-neutral-900"
                >
                  <span>
                    <span className="font-medium">{kb.name}</span>
                    {kb.description && (
                      <span className="ml-2 text-sm text-neutral-500">
                        {kb.description}
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-neutral-500">
                    {t("documents", { count: kb.documentCount })}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {canManage && (
        <section className="mt-10 max-w-lg">
          <h2 className="text-lg font-medium">{t("new")}</h2>
          <div className="mt-3">
            <CreateKnowledgeBaseForm workspaceSlug={workspaceSlug} />
          </div>
        </section>
      )}
    </main>
  );
}
