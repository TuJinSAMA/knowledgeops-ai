import { Link } from "@/i18n/navigation";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { SignOutButton } from "@/components/auth/SignOutButton";
import { LocaleSwitcher } from "@/components/workspace/LocaleSwitcher";
import { WorkspaceSwitcher } from "@/components/workspace/WorkspaceSwitcher";
import { hasMinRole } from "@/lib/authz";
import { requireUser } from "@/lib/session";
import { getUserWorkspaceBySlug, listUserWorkspaces } from "@/lib/workspace";

export default async function WorkspaceLayout({
  children,
  params,
}: LayoutProps<"/[locale]/[workspaceSlug]">) {
  const { locale, workspaceSlug } = await params;
  const [t, commonT] = await Promise.all([
    getTranslations({ locale, namespace: "navigation" }),
    getTranslations({ locale, namespace: "common" }),
  ]);
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
            {commonT("productName")}
          </Link>
          <WorkspaceSwitcher workspaces={workspaces} currentSlug={current.slug} />
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs uppercase tracking-wide text-neutral-500">
            {current.role}
          </span>
          <Link
            href={`/${current.slug}/chat`}
            className="text-sm text-neutral-600 underline-offset-4 hover:underline dark:text-neutral-400"
          >
            {t("chat")}
          </Link>
          <Link
            href={`/${current.slug}/knowledge-bases`}
            className="text-sm text-neutral-600 underline-offset-4 hover:underline dark:text-neutral-400"
          >
            {t("knowledgeBases")}
          </Link>
          <Link
            href={`/${current.slug}/traces`}
            className="text-sm text-neutral-600 underline-offset-4 hover:underline dark:text-neutral-400"
          >
            {t("traces")}
          </Link>
          <Link
            href={`/${current.slug}/feedback`}
            className="text-sm text-neutral-600 underline-offset-4 hover:underline dark:text-neutral-400"
          >
            {t("feedback")}
          </Link>
          <Link
            href={`/${current.slug}/evaluations`}
            className="text-sm text-neutral-600 underline-offset-4 hover:underline dark:text-neutral-400"
          >
            {t("evaluations")}
          </Link>
          <Link
            href={`/${current.slug}/usage`}
            className="text-sm text-neutral-600 underline-offset-4 hover:underline dark:text-neutral-400"
          >
            {t("usage")}
          </Link>
          {hasMinRole(current.role, "ADMIN") && (
            <Link
              href={`/${current.slug}/audit`}
              className="text-sm text-neutral-600 underline-offset-4 hover:underline dark:text-neutral-400"
            >
              {t("audit")}
            </Link>
          )}
          <Link
            href={`/${current.slug}/settings`}
            className="text-sm text-neutral-600 underline-offset-4 hover:underline dark:text-neutral-400"
          >
            {t("settings")}
          </Link>
          <LocaleSwitcher />
          <SignOutButton />
        </div>
      </header>
      <div className="flex-1">{children}</div>
    </div>
  );
}
