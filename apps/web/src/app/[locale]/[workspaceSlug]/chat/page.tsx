import { Link } from "@/i18n/navigation";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { ChatPanel } from "@/components/chat/ChatPanel";
import { listKnowledgeBases } from "@/lib/knowledge-base";
import { requireUser } from "@/lib/session";
import { getUserWorkspaceBySlug } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export default async function ChatPage({
  params,
}: PageProps<"/[locale]/[workspaceSlug]/chat">) {
  const { locale, workspaceSlug } = await params;
  const t = await getTranslations({ locale, namespace: "chat" });
  const user = await requireUser(`/${workspaceSlug}/chat`);
  const workspace = await getUserWorkspaceBySlug(user.id, workspaceSlug);
  if (!workspace) {
    notFound();
  }

  const knowledgeBases = await listKnowledgeBases(workspace.id);
  const chatEndpoint = `/${locale}/${workspaceSlug}/api/chat`;

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        {t("description")}
      </p>

      {knowledgeBases.length === 0 ? (
        <p className="mt-8 rounded-lg border border-dashed border-neutral-300 p-6 text-sm text-neutral-500 dark:border-neutral-700">
          {t("noKnowledgeBases")}{" "}
          <Link
            href={`/${workspaceSlug}/knowledge-bases`}
            className="underline underline-offset-4"
          >
            {t("createKnowledgeBase")}
          </Link>{" "}
          {t("beforeAsking")}
        </p>
      ) : (
        <div className="mt-6">
          <ChatPanel
            chatEndpoint={chatEndpoint}
            traceBasePath={`/${locale}/${workspaceSlug}/traces`}
            workspaceSlug={workspaceSlug}
            knowledgeBases={knowledgeBases.map((kb) => ({
              id: kb.id,
              name: kb.name,
            }))}
          />
        </div>
      )}
    </main>
  );
}
