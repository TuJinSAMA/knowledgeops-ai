import Link from "next/link";
import { notFound } from "next/navigation";

import { ChatPanel } from "@/components/chat/ChatPanel";
import { listKnowledgeBases } from "@/lib/knowledge-base";
import { requireUser } from "@/lib/session";
import { getUserWorkspaceBySlug } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export default async function ChatPage({
  params,
}: PageProps<"/[workspaceSlug]/chat">) {
  const { workspaceSlug } = await params;
  const user = await requireUser(`/${workspaceSlug}/chat`);
  const workspace = await getUserWorkspaceBySlug(user.id, workspaceSlug);
  if (!workspace) {
    notFound();
  }

  const knowledgeBases = await listKnowledgeBases(workspace.id);
  const chatEndpoint = `/${workspaceSlug}/api/chat`;

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Assistant</h1>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        Ask questions and get answers grounded in your knowledge base, with
        citations back to the source documents.
      </p>

      {knowledgeBases.length === 0 ? (
        <p className="mt-8 rounded-lg border border-dashed border-neutral-300 p-6 text-sm text-neutral-500 dark:border-neutral-700">
          No knowledge bases yet.{" "}
          <Link
            href={`/${workspaceSlug}/knowledge-bases`}
            className="underline underline-offset-4"
          >
            Create one and upload documents
          </Link>{" "}
          before asking the assistant.
        </p>
      ) : (
        <div className="mt-6">
          <ChatPanel
            chatEndpoint={chatEndpoint}
            traceBasePath={`/${workspaceSlug}/traces`}
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
