import NextLink from "next/link";
import { Link } from "@/i18n/navigation";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { getServerSession } from "@/lib/session";
import { ensureWorkspaceForUser, listUserWorkspaces } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export default async function Home({
  params,
}: PageProps<"/[locale]">) {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  const session = await getServerSession();

  // Authenticated users land directly in their (default) workspace.
  if (session?.user) {
    await ensureWorkspaceForUser(session.user);
    const workspaces = await listUserWorkspaces(session.user.id);
    if (workspaces.length > 0) {
      redirect(`/${locale}/${workspaces[0].slug}`);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-8 px-6 py-16">
      <div className="space-y-3">
        <p className="text-sm font-medium uppercase tracking-widest text-neutral-500">
          Hameo
        </p>
        <h1 className="text-4xl font-bold tracking-tight">{t("marketing.headline")}</h1>
        <p className="text-lg text-neutral-600 dark:text-neutral-400">
          {t("marketing.description")}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {[
          [t("marketing.knowledgeManagement"), t("marketing.knowledgeManagementDescription")],
          [t("marketing.observability"), t("marketing.observabilityDescription")],
          [t("marketing.evaluation"), t("marketing.evaluationDescription")],
          [t("marketing.enterpriseReadiness"), t("marketing.enterpriseReadinessDescription")],
        ].map(([title, desc]) => (
          <div
            key={title}
            className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
          >
            <h2 className="font-semibold">{title}</h2>
            <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
              {desc}
            </p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-4 text-sm">
        <Link
          className="rounded-md bg-neutral-900 px-4 py-2 font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          href="/sign-in"
        >
          {t("auth.signIn")}
        </Link>
        <Link
          className="rounded-md border border-neutral-300 px-4 py-2 font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
          href="/sign-up"
        >
          {t("auth.signUp")}
        </Link>
        <NextLink
          className="rounded-md border border-neutral-300 px-4 py-2 font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
          href="/api/health"
        >
          {t("common.systemHealth")}
        </NextLink>
      </div>
    </main>
  );
}
