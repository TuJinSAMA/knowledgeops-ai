import { notFound } from "next/navigation";

import { RenameWorkspaceForm } from "@/components/workspace/RenameWorkspaceForm";
import { hasMinRole } from "@/lib/authz";
import { requireUser } from "@/lib/session";
import { getUserWorkspaceBySlug } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export default async function WorkspaceSettingsPage({
  params,
}: PageProps<"/[workspaceSlug]/settings">) {
  const { workspaceSlug } = await params;
  const user = await requireUser(`/${workspaceSlug}/settings`);
  const workspace = await getUserWorkspaceBySlug(user.id, workspaceSlug);
  if (!workspace) {
    notFound();
  }

  const canManage = hasMinRole(workspace.role, "ADMIN");

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Workspace settings</h1>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        Slug: <code className="font-mono">{workspace.slug}</code>
      </p>

      <section className="mt-8">
        <h2 className="text-lg font-medium">General</h2>
        <div className="mt-3">
          {canManage ? (
            <RenameWorkspaceForm
              workspaceId={workspace.id}
              slug={workspace.slug}
              currentName={workspace.name}
            />
          ) : (
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Only an ADMIN or OWNER can change workspace settings. Your role is{" "}
              <span className="font-medium">{workspace.role}</span>.
            </p>
          )}
        </div>
      </section>
    </main>
  );
}
