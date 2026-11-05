"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";

import {
  type ActionState,
  createEvaluationDatasetAction,
} from "@/lib/evaluation-actions";

type KnowledgeBaseOption = { id: string; name: string };

export function CreateEvaluationDatasetForm({
  workspaceSlug,
  knowledgeBases,
}: {
  workspaceSlug: string;
  knowledgeBases: KnowledgeBaseOption[];
}) {
  const t = useTranslations("evaluations");
  const errorT = useTranslations("errors");
  const boundAction = createEvaluationDatasetAction.bind(null, workspaceSlug);
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    boundAction,
    {},
  );

  return (
    <form action={formAction} className="space-y-3">
      <div className="space-y-1.5">
        <label htmlFor="ds-name" className="block text-sm font-medium">
          {t("name")}
        </label>
        <input
          id="ds-name"
          name="name"
          type="text"
          placeholder={t("datasetNamePlaceholder")}
          required
          className="w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:focus:border-neutral-200"
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="ds-description" className="block text-sm font-medium">
          {t("descriptionLabel")} <span className="text-neutral-400">{t("optional")}</span>
        </label>
        <textarea
          id="ds-description"
          name="description"
          rows={2}
          placeholder={t("datasetDescriptionPlaceholder")}
          className="w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:focus:border-neutral-200"
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="ds-kb" className="block text-sm font-medium">
          {t("knowledgeBase")} <span className="text-neutral-400">{t("optional")}</span>
        </label>
        <select
          id="ds-kb"
          name="knowledgeBaseId"
          defaultValue=""
          className="w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:focus:border-neutral-200"
        >
          <option value="">{t("noneOption")}</option>
          {knowledgeBases.map((kb) => (
            <option key={kb.id} value={kb.id}>
              {kb.name}
            </option>
          ))}
        </select>
      </div>

      {state.errorCode && (
        <p className="text-sm text-red-600 dark:text-red-400">
          {errorT(state.errorCode, state.errorParams)}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-60 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
      >
        {pending ? t("creating") : t("createDataset")}
      </button>
    </form>
  );
}
