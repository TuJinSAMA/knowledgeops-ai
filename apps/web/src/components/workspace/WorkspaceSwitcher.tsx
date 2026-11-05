"use client";

import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import type { WorkspaceSummary } from "@/lib/workspace";

export function WorkspaceSwitcher({
  workspaces,
  currentSlug,
}: {
  workspaces: WorkspaceSummary[];
  currentSlug: string;
}) {
  const router = useRouter();
  const t = useTranslations("navigation");

  function handleChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const value = event.target.value;
    if (value === "__new__") {
      router.push("/workspaces/new");
      return;
    }
    if (value !== currentSlug) {
      router.push(`/${value}`);
    }
  }

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="sr-only">{t("currentWorkspace")}</span>
      <select
        value={currentSlug}
        onChange={handleChange}
        className="rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:focus:border-neutral-200"
      >
        {workspaces.map((workspace) => (
          <option key={workspace.id} value={workspace.slug}>
            {workspace.name}
          </option>
        ))}
        <option value="__new__">{t("newWorkspace")}</option>
      </select>
    </label>
  );
}
