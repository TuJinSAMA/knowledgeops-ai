"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";

import {
  type ActionState,
  createEvaluationCaseAction,
} from "@/lib/evaluation-actions";

const inputClass =
  "w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:focus:border-neutral-200";

export function CreateEvaluationCaseForm({
  workspaceSlug,
  datasetId,
}: {
  workspaceSlug: string;
  datasetId: string;
}) {
  const t = useTranslations("evaluations");
  const errorT = useTranslations("errors");
  const boundAction = createEvaluationCaseAction.bind(
    null,
    workspaceSlug,
    datasetId,
  );
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    boundAction,
    {},
  );

  return (
    <form action={formAction} className="space-y-3" key={state.errorCode ? "err" : "ok"}>
      <div className="space-y-1.5">
        <label htmlFor="case-question" className="block text-sm font-medium">
          {t("question")}
        </label>
        <textarea
          id="case-question"
          name="question"
          rows={2}
          required
          placeholder={t("questionPlaceholder")}
          className={inputClass}
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="case-answer" className="block text-sm font-medium">
          {t("expectedAnswer")} <span className="text-neutral-400">{t("optional")}</span>
        </label>
        <textarea
          id="case-answer"
          name="expectedAnswer"
          rows={2}
          placeholder={t("expectedAnswerPlaceholder")}
          className={inputClass}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label
            htmlFor="case-docs"
            className="block text-sm font-medium"
          >
            {t("expectedSourceDocuments")}{" "}
            <span className="text-neutral-400">{t("idsPerLine")}</span>
          </label>
          <textarea
            id="case-docs"
            name="expectedSourceDocuments"
            rows={2}
            className={inputClass}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="case-chunks" className="block text-sm font-medium">
            {t("expectedChunksLabel")}{" "}
            <span className="text-neutral-400">{t("idsPerLine")}</span>
          </label>
          <textarea
            id="case-chunks"
            name="expectedChunks"
            rows={2}
            className={inputClass}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="case-facts" className="block text-sm font-medium">
            {t("requiredFactsLabel")}{" "}
            <span className="text-neutral-400">{t("onePerLine")}</span>
          </label>
          <textarea
            id="case-facts"
            name="requiredFacts"
            rows={2}
            className={inputClass}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="case-tags" className="block text-sm font-medium">
            {t("tags")} <span className="text-neutral-400">{t("commaSeparated")}</span>
          </label>
          <input
            id="case-tags"
            name="tags"
            type="text"
            placeholder={t("tagsPlaceholder")}
            className={inputClass}
          />
        </div>
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
        {pending ? t("adding") : t("addCaseButton")}
      </button>
    </form>
  );
}
