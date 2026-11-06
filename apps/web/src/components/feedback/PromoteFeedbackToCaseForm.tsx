"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";

import { Link } from "@/i18n/navigation";
import {
  type PromoteActionState,
  promoteFeedbackToCaseAction,
} from "@/lib/feedback-actions";

export type DatasetOption = {
  id: string;
  name: string;
  knowledgeBaseId: string | null;
};

const inputClass =
  "w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:focus:border-neutral-200";

export function PromoteFeedbackToCaseForm({
  workspaceSlug,
  feedbackId,
  knowledgeBaseId,
  knowledgeBaseName,
  initialQuestion,
  reportType,
  datasets,
}: {
  workspaceSlug: string;
  feedbackId: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  initialQuestion: string;
  reportType: string | null;
  datasets: DatasetOption[];
}) {
  const t = useTranslations("feedback");
  const errorT = useTranslations("errors");

  // Prioritize datasets bound to the same knowledge base.
  const sortedDatasets = [...datasets].sort((a, b) => {
    const aMatch = a.knowledgeBaseId === knowledgeBaseId ? 0 : 1;
    const bMatch = b.knowledgeBaseId === knowledgeBaseId ? 0 : 1;
    return aMatch - bMatch;
  });

  const defaultDatasetChoice = sortedDatasets[0]?.id ?? "__new__";
  const [selectedDataset, setSelectedDataset] =
    useState<string>(defaultDatasetChoice);

  const defaultTags = [
    "from-feedback",
    reportType ? reportType.toLowerCase().replace(/_/g, "-") : null,
  ]
    .filter(Boolean)
    .join(", ");

  const boundAction = promoteFeedbackToCaseAction.bind(
    null,
    workspaceSlug,
    feedbackId,
  );
  const [state, formAction, pending] = useActionState<
    PromoteActionState,
    FormData
  >(boundAction, {});

  if (state.ok && state.datasetId) {
    return (
      <div className="rounded-lg border border-emerald-300 bg-emerald-50/60 p-4 text-sm dark:border-emerald-900 dark:bg-emerald-950/30">
        <div className="font-medium text-emerald-900 dark:text-emerald-200">
          {t("promotedCardTitle")}
        </div>
        <p className="mt-1 text-emerald-800 dark:text-emerald-300">
          {t("promotedToDataset", { dataset: state.datasetName ?? "" })}
        </p>
        <Link
          href={`/${workspaceSlug}/evaluations/${state.datasetId}`}
          className="mt-2 inline-block font-medium text-emerald-900 underline underline-offset-4 dark:text-emerald-200"
        >
          {t("openDataset")}
        </Link>
      </div>
    );
  }

  return (
    <form
      action={formAction}
      className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
    >
      <div className="space-y-1">
        <label htmlFor="promote-dataset" className="block text-xs text-neutral-500">
          {t("targetDataset")}
        </label>
        <select
          id="promote-dataset"
          name="datasetId"
          value={selectedDataset}
          onChange={(e) => setSelectedDataset(e.target.value)}
          className={inputClass}
        >
          {sortedDatasets.map((ds) => (
            <option key={ds.id} value={ds.id}>
              {ds.name}
            </option>
          ))}
          <option value="__new__">{t("createNewDatasetOption")}</option>
        </select>
      </div>

      {selectedDataset === "__new__" && (
        <div className="space-y-1">
          <label
            htmlFor="promote-new-ds-name"
            className="block text-xs text-neutral-500"
          >
            {t("newDatasetName")} ({knowledgeBaseName})
          </label>
          <input
            id="promote-new-ds-name"
            name="newDatasetName"
            type="text"
            required
            defaultValue={`${knowledgeBaseName} Regression`}
            placeholder={t("newDatasetNamePlaceholder")}
            className={inputClass}
          />
        </div>
      )}

      <div className="space-y-1">
        <label htmlFor="promote-question" className="block text-xs text-neutral-500">
          {t("questionLabel")}
        </label>
        <textarea
          id="promote-question"
          name="question"
          rows={2}
          required
          defaultValue={initialQuestion}
          className={inputClass}
        />
      </div>

      <div className="space-y-1">
        <label
          htmlFor="promote-expected-answer"
          className="block text-xs text-neutral-500"
        >
          {t("expectedAnswerLabel")}
        </label>
        <textarea
          id="promote-expected-answer"
          name="expectedAnswer"
          rows={2}
          placeholder={t("expectedAnswerPlaceholder")}
          className={inputClass}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label
            htmlFor="promote-facts"
            className="block text-xs text-neutral-500"
          >
            {t("requiredFactsLabel")}
          </label>
          <textarea
            id="promote-facts"
            name="requiredFacts"
            rows={2}
            className={inputClass}
          />
        </div>
        <div className="space-y-1">
          <label
            htmlFor="promote-docs"
            className="block text-xs text-neutral-500"
          >
            {t("expectedDocsLabel")}
          </label>
          <textarea
            id="promote-docs"
            name="expectedSourceDocuments"
            rows={2}
            className={inputClass}
          />
        </div>
      </div>

      <div className="space-y-1">
        <label htmlFor="promote-tags" className="block text-xs text-neutral-500">
          {t("tagsLabel")}
        </label>
        <input
          id="promote-tags"
          name="tags"
          type="text"
          defaultValue={defaultTags}
          className={inputClass}
        />
      </div>

      <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400">
        <input
          type="checkbox"
          name="markResolved"
          defaultChecked
          className="rounded border-neutral-300"
        />
        {t("markResolvedLabel")}
      </label>

      {state.errorCode && (
        <p className="text-xs text-red-600 dark:text-red-400">
          {errorT(state.errorCode, state.errorParams)}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-60 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
      >
        {pending ? t("promoting") : t("promoteButton")}
      </button>
    </form>
  );
}
