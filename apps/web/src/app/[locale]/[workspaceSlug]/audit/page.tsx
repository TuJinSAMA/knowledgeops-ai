import { Link } from "@/i18n/navigation";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { listAuditActions, listAuditLogs } from "@/lib/audit";
import { hasMinRole } from "@/lib/authz";
import { requireUser } from "@/lib/session";
import { getUserWorkspaceBySlug } from "@/lib/workspace";

export const dynamic = "force-dynamic";

// Human-readable labels for the known audit actions. Unknown actions fall back
// to their raw identifier so new actions still render before a label is added.
function summarizeMetadata(
  metadata: Record<string, unknown> | null,
): string | null {
  if (!metadata) {
    return null;
  }
  const name = metadata.name ?? metadata.title;
  if (typeof name === "string" && name.length > 0) {
    return name;
  }
  return null;
}

export default async function AuditPage({
  params,
  searchParams,
}: PageProps<"/[locale]/[workspaceSlug]/audit">) {
  const { locale, workspaceSlug } = await params;
  const t = await getTranslations({ locale, namespace: "audit" });
  const actionLabel = (action: string) =>
    t.has(`actionLabels.${action}`) ? t(`actionLabels.${action}`) : action;
  const formatWhen = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }).format;
  const sp = await searchParams;
  const user = await requireUser(`/${workspaceSlug}/audit`);
  const workspace = await getUserWorkspaceBySlug(user.id, workspaceSlug);
  if (!workspace) {
    notFound();
  }

  // The audit trail is operationally sensitive; restrict it to ADMIN and above.
  if (!hasMinRole(workspace.role, "ADMIN")) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="mt-4 rounded-lg border border-dashed border-neutral-300 p-6 text-sm text-neutral-500 dark:border-neutral-700">
          {t("restricted")}
        </p>
      </main>
    );
  }

  const actionParam = typeof sp.action === "string" ? sp.action : undefined;

  const [actions, entries] = await Promise.all([
    listAuditActions(workspace.id),
    listAuditLogs(workspace.id, { action: actionParam ?? null }),
  ]);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        {t("description")}
      </p>

      <form
        method="get"
        className="mt-6 flex flex-wrap items-end gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
      >
        <div className="flex flex-col gap-1">
          <label htmlFor="action" className="text-xs text-neutral-500">
            {t("action")}
          </label>
          <select
            id="action"
            name="action"
            defaultValue={actionParam ?? ""}
            className="rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm outline-none dark:border-neutral-700"
          >
            <option value="">{t("all")}</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {actionLabel(a)}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
        >
          {t("filter")}
        </button>
        {actionParam && (
          <Link
            href={`/${workspaceSlug}/audit`}
            className="text-sm text-neutral-500 underline-offset-4 hover:underline"
          >
            {t("reset")}
          </Link>
        )}
      </form>

      {entries.length === 0 ? (
        <p className="mt-8 rounded-lg border border-dashed border-neutral-300 p-6 text-sm text-neutral-500 dark:border-neutral-700">
          {t("none")}
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
              <tr>
                <th className="px-4 py-3 font-medium">{t("action")}</th>
                <th className="px-4 py-3 font-medium">{t("target")}</th>
                <th className="px-4 py-3 font-medium">{t("actor")}</th>
                <th className="px-4 py-3 font-medium">{t("when")}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const summary = summarizeMetadata(e.metadata);
                return (
                  <tr
                    key={e.id}
                    className="border-b border-neutral-100 last:border-0 dark:border-neutral-900"
                  >
                    <td className="px-4 py-3 font-medium">
                      {actionLabel(e.action)}
                    </td>
                    <td className="px-4 py-3 text-neutral-500">
                      {summary ? (
                        <span>{summary}</span>
                      ) : e.targetType ? (
                        <span className="font-mono text-xs">
                          {e.targetType}
                          {e.targetId ? ` · ${e.targetId.slice(0, 8)}` : ""}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-3 text-neutral-500">
                      {e.actorName ?? e.actorEmail ?? t("unknown")}
                    </td>
                    <td className="px-4 py-3 text-neutral-500">
                      {formatWhen(e.createdAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
