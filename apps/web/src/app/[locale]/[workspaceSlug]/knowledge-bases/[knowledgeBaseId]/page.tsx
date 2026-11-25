import { Link } from "@/i18n/navigation";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { DeleteKnowledgeBaseButton } from "@/components/knowledge-base/DeleteKnowledgeBaseButton";
import { DocumentsPanel } from "@/components/knowledge-base/DocumentsPanel";
import { KnowledgeBaseRagConfigForm } from "@/components/knowledge-base/KnowledgeBaseRagConfigForm";
import { hasMinRole } from "@/lib/authz";
import { getKnowledgeBase, listDocuments } from "@/lib/knowledge-base";
import { requireUser } from "@/lib/session";
import { getUserWorkspaceBySlug } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export default async function KnowledgeBaseDetailPage({
  params,
}: PageProps<"/[locale]/[workspaceSlug]/knowledge-bases/[knowledgeBaseId]">) {
  const { locale, workspaceSlug, knowledgeBaseId } = await params;
  const t = await getTranslations({ locale, namespace: "knowledgeBases" });
  // The documents API route lives under the /api segment.
  const documentsEndpoint = `/${locale}/${workspaceSlug}/api/knowledge-bases/${knowledgeBaseId}/documents`;
  const user = await requireUser(`/${workspaceSlug}/knowledge-bases/${knowledgeBaseId}`);
  const workspace = await getUserWorkspaceBySlug(user.id, workspaceSlug);
  if (!workspace) {
    notFound();
  }

  const kb = await getKnowledgeBase(workspace.id, knowledgeBaseId);
  if (!kb) {
    notFound();
  }

  const canManage = hasMinRole(workspace.role, "ADMIN");
  const documents = await listDocuments(workspace.id, knowledgeBaseId);
  // Serialize dates to strings for the client polling component.
  const initialDocuments = documents.map((doc) => ({
    ...doc,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  }));

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <Link
        href={`/${workspaceSlug}/knowledge-bases`}
        className="text-sm text-neutral-500 underline-offset-4 hover:underline"
      >
        {t("back")}
      </Link>

      <div className="mt-3 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{kb.name}</h1>
          {kb.description && (
            <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
              {kb.description}
            </p>
          )}
        </div>
      </div>

      <section className="mt-8">
        <KnowledgeBaseRagConfigForm
          workspaceSlug={workspaceSlug}
          knowledgeBaseId={kb.id}
          initialConfig={kb.ragConfig}
          canManage={canManage}
        />
      </section>

      <section className="mt-8">
        <DocumentsPanel
          endpoint={documentsEndpoint}
          documentDetailBasePath={`/${workspaceSlug}/knowledge-bases/${knowledgeBaseId}/documents`}
          initialDocuments={initialDocuments}
          canUpload={canManage}
        />
      </section>

      {canManage && (
        <section className="mt-12 border-t border-neutral-200 pt-6 dark:border-neutral-800">
          <h2 className="text-sm font-medium text-neutral-500">{t("dangerZone")}</h2>
          <div className="mt-3">
            <DeleteKnowledgeBaseButton
              workspaceSlug={workspaceSlug}
              knowledgeBaseId={kb.id}
              knowledgeBaseName={kb.name}
            />
          </div>
        </section>
      )}
    </main>
  );
}
