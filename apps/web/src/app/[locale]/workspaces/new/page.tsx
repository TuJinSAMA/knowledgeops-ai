import { getTranslations } from "next-intl/server";

import { CreateWorkspaceForm } from "@/components/workspace/CreateWorkspaceForm";
import { Link } from "@/i18n/navigation";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function NewWorkspacePage({
  params,
}: PageProps<"/[locale]/workspaces/new">) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "settings" });
  await requireUser("/workspaces/new");

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("newWorkspaceTitle")}
          </h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {t("newWorkspaceDescription")}
          </p>
        </div>
        <CreateWorkspaceForm />
        <Link
          href="/"
          className="block text-sm text-neutral-600 underline underline-offset-4 dark:text-neutral-400"
        >
          {t("back")}
        </Link>
      </div>
    </main>
  );
}
