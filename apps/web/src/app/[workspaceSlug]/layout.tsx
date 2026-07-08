import Link from "next/link";
import { notFound } from "next/navigation";

import { SignOutButton } from "@/components/auth/SignOutButton";
import { WorkspaceSwitcher } from "@/components/workspace/WorkspaceSwitcher";
import { hasMinRole } from "@/lib/authz";
import { requireUser } from "@/lib/session";
import { getUserWorkspaceBySlug, listUserWorkspaces } from "@/lib/workspace";

export default async function WorkspaceLayout({
  children,
  params,
}: LayoutProps<"/[workspaceSlug]">) {
  const { workspaceSlug } = await params;
  const user = await requireUser(`/${workspaceSlug}`);

  // Tenant isolation: only members of this workspace may view it. Non-members
  // (and unknown slugs) get a 404 so we don't leak workspace existence.
  const current = await getUserWorkspaceBySlug(user.id, workspaceSlug);
  if (!current) {
    notFound();
  }

  const workspaces = await listUserWorkspaces(user.id);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-neutral-200 px-6 py-3 dark:border-neutral-800">
        <div className="flex items-center gap-4">
          <Link href={`/${current.slug}`} className="font-semibold">
            KnowledgeOps
          </Link>
          <WorkspaceSwitcher workspaces={workspaces} currentSlug={current.slug} />
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs uppercase tracking-wide text-neutral-500">
            {current.role}
          </span>
          <Link
            href={`/${current.slug}/traces`}
            className="text-sm text-neutral-600 underline-offset-4 hover:underline dark:text-neutral-400"
          >
            Traces
          </Link>
          <Link
            href={`/${current.slug}/feedback`}
            className="text-sm text-neutral-600 underline-offset-4 hover:underline dark:text-neutral-400"
          >
            Feedback
          </Link>
          <Link
            href={`/${current.slug}/evaluations`}
            className="text-sm text-neutral-600 underline-offset-4 hover:underline dark:text-neutral-400"
          >
            Evaluations
          </Link>
          <Link
            href={`/${current.slug}/usage`}
            className="text-sm text-neutral-600 underline-offset-4 hover:underline dark:text-neutral-400"
          >
            Usage
          </Link>
          {hasMinRole(current.role, "ADMIN") && (
            <Link
              href={`/${current.slug}/audit`}
              className="text-sm text-neutral-600 underline-offset-4 hover:underline dark:text-neutral-400"
            >
              Audit
            </Link>
          )}
          <Link
            href={`/${current.slug}/settings`}
            className="text-sm text-neutral-600 underline-offset-4 hover:underline dark:text-neutral-400"
          >
            Settings
          </Link>
          <SignOutButton />
        </div>
      </header>
      <div className="flex-1">{children}</div>
    </div>
  );
}
