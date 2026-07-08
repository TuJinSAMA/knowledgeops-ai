import Link from "next/link";

import { CreateWorkspaceForm } from "@/components/workspace/CreateWorkspaceForm";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function NewWorkspacePage() {
  await requireUser("/workspaces/new");

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            Create a workspace
          </h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            A workspace is an isolated tenant for your knowledge and members.
          </p>
        </div>
        <CreateWorkspaceForm />
        <Link
          href="/"
          className="block text-sm text-neutral-600 underline underline-offset-4 dark:text-neutral-400"
        >
          Back
        </Link>
      </div>
    </main>
  );
}
