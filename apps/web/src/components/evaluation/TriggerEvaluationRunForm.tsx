"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";

import {
  type ActionState,
  triggerEvaluationRunAction,
} from "@/lib/evaluation-actions";

const inputClass =
  "w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:focus:border-neutral-200";

export function TriggerEvaluationRunForm({
  workspaceSlug,
  datasetId,
  disabled,
}: {
  workspaceSlug: string;
  datasetId: string;
  disabled?: boolean;
}) {
  const t = useTranslations("evaluations");
  const errorT = useTranslations("errors");
  const boundAction = triggerEvaluationRunAction.bind(
    null,
    workspaceSlug,
    datasetId,
  );
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    boundAction,
    {},
  );

  return (
    <form action={formAction} className="space-y-3">
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        {t("runDescription")}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="run-chunk" className="block text-sm font-medium">
            {t("chunkSize")}
          </label>
          <input
            id="run-chunk"
            name="chunkSize"
            type="number"
            min={1}
            placeholder="1000"
            className={inputClass}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="run-topk" className="block text-sm font-medium">
            {t("topK")}
          </label>
          <input
            id="run-topk"
            name="topK"
            type="number"
            min={1}
            placeholder="5"
            className={inputClass}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="run-mode" className="block text-sm font-medium">
            {t("retrievalMode")}
          </label>
          <select
            id="run-mode"
            name="retrievalMode"
            defaultValue="hybrid"
            className={inputClass}
          >
            <option value="hybrid">{t("retrievalModeHybrid")}</option>
            <option value="vector">{t("retrievalModeVector")}</option>
            <option value="keyword">{t("retrievalModeKeyword")}</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="run-rewrite" className="block text-sm font-medium">
            {t("queryRewrite")}
          </label>
          <select
            id="run-rewrite"
            name="queryRewrite"
            defaultValue=""
            className={inputClass}
          >
            <option value="">{t("queryRewriteDefault")}</option>
            <option value="true">{t("queryRewriteEnabled")}</option>
            <option value="false">{t("queryRewriteDisabled")}</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="run-embed" className="block text-sm font-medium">
            {t("embeddingModel")}
          </label>
          <input
            id="run-embed"
            name="embeddingModel"
            type="text"
            placeholder="qwen/qwen3-embedding-8b"
            className={inputClass}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="run-rerank" className="block text-sm font-medium">
            {t("reranker")}
          </label>
          <select
            id="run-rerank"
            name="reranker"
            defaultValue=""
            className={inputClass}
          >
            <option value="">{t("rerankerNone")}</option>
            <option value="heuristic">{t("rerankerHeuristic")}</option>
            <option value="llm">{t("rerankerLlm")}</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="run-prompt" className="block text-sm font-medium">
            {t("promptVersion")}
          </label>
          <input
            id="run-prompt"
            name="promptVersion"
            type="text"
            placeholder="v1"
            className={inputClass}
          />
        </div>
      </div>

      <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400">
        <input
          type="checkbox"
          name="useLlmJudge"
          className="rounded border-neutral-300"
        />
        {t("useLlmJudge")}
      </label>

      {state.errorCode && (
        <p className="text-sm text-red-600 dark:text-red-400">
          {errorT(state.errorCode, state.errorParams)}
        </p>
      )}

      <button
        type="submit"
        disabled={pending || disabled}
        title={
          disabled ? t("addCaseBeforeRun") : undefined
        }
        className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-60 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
      >
        {pending ? t("queuing") : t("runEvaluation")}
      </button>
    </form>
  );
}
