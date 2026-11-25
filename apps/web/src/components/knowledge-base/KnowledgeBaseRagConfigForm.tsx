"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";

import { formatConfig } from "@/lib/evaluation-format";
import {
  type ActionState,
  updateKnowledgeBaseRagConfigAction,
} from "@/lib/knowledge-base-actions";
import {
  type KnowledgeBaseRagConfig,
  MIN_SCORE_MAX,
  MIN_SCORE_MIN,
  SYSTEM_PROMPT_ADDENDUM_MAX_LENGTH,
  TOP_K_MAX,
  TOP_K_MIN,
} from "@/lib/rag-config";

const inputClass =
  "w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:focus:border-neutral-200";

export function KnowledgeBaseRagConfigForm({
  workspaceSlug,
  knowledgeBaseId,
  initialConfig,
  canManage,
}: {
  workspaceSlug: string;
  knowledgeBaseId: string;
  initialConfig: KnowledgeBaseRagConfig | null;
  canManage: boolean;
}) {
  const t = useTranslations("knowledgeBases");
  const evalT = useTranslations("evaluations");
  const errorT = useTranslations("errors");
  const boundAction = updateKnowledgeBaseRagConfigAction.bind(
    null,
    workspaceSlug,
    knowledgeBaseId,
  );
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    boundAction,
    {},
  );

  const hasCustomConfig = Boolean(
    initialConfig && Object.keys(initialConfig).length > 0,
  );

  return (
    <div className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-medium">{t("ragConfig.title")}</h2>
          <p className="mt-0.5 text-xs text-neutral-500">
            {t("ragConfig.description")}
          </p>
        </div>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
            hasCustomConfig
              ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
              : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
          }`}
        >
          {hasCustomConfig
            ? t("ragConfig.customActive")
            : t("ragConfig.systemDefault")}
        </span>
      </div>

      {!canManage ? (
        <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400">
          {formatConfig(initialConfig, evalT("defaults"))}
        </p>
      ) : (
        <form
          key={JSON.stringify(initialConfig ?? {})}
          action={formAction}
          className="mt-4 space-y-3"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="kb-topk" className="block text-sm font-medium">
                {evalT("topK")}
              </label>
              <input
                id="kb-topk"
                name="topK"
                type="number"
                min={TOP_K_MIN}
                max={TOP_K_MAX}
                defaultValue={initialConfig?.topK ?? ""}
                placeholder="5"
                className={inputClass}
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="kb-min-score"
                className="block text-sm font-medium"
              >
                {evalT("minScore")}
              </label>
              <input
                id="kb-min-score"
                name="minScore"
                type="number"
                min={MIN_SCORE_MIN}
                max={MIN_SCORE_MAX}
                step="0.05"
                defaultValue={initialConfig?.minScore ?? ""}
                placeholder="0.20"
                className={inputClass}
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="kb-mode" className="block text-sm font-medium">
                {evalT("retrievalMode")}
              </label>
              <select
                id="kb-mode"
                name="retrievalMode"
                defaultValue={initialConfig?.retrievalMode ?? ""}
                className={inputClass}
              >
                <option value="">{t("ragConfig.inheritDefault")}</option>
                <option value="hybrid">{evalT("retrievalModeHybrid")}</option>
                <option value="vector">{evalT("retrievalModeVector")}</option>
                <option value="keyword">{evalT("retrievalModeKeyword")}</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="kb-rewrite" className="block text-sm font-medium">
                {evalT("queryRewrite")}
              </label>
              <select
                id="kb-rewrite"
                name="queryRewrite"
                defaultValue={
                  initialConfig?.queryRewrite === undefined
                    ? ""
                    : String(initialConfig.queryRewrite)
                }
                className={inputClass}
              >
                <option value="">{evalT("queryRewriteDefault")}</option>
                <option value="true">{evalT("queryRewriteEnabled")}</option>
                <option value="false">{evalT("queryRewriteDisabled")}</option>
              </select>
            </div>

            <div className="space-y-1.5 sm:col-span-2">
              <label htmlFor="kb-rerank" className="block text-sm font-medium">
                {evalT("reranker")}
              </label>
              <select
                id="kb-rerank"
                name="reranker"
                defaultValue={initialConfig?.reranker ?? ""}
                className={inputClass}
              >
                <option value="">{evalT("rerankerNone")}</option>
                <option value="heuristic">{evalT("rerankerHeuristic")}</option>
                <option value="llm">{evalT("rerankerLlm")}</option>
              </select>
            </div>

            <div className="space-y-1.5 sm:col-span-2">
              <label
                htmlFor="kb-addendum"
                className="block text-sm font-medium"
              >
                {evalT("systemPromptAddendum")}{" "}
                <span className="text-neutral-400">{t("optional")}</span>
              </label>
              <textarea
                id="kb-addendum"
                name="systemPromptAddendum"
                rows={2}
                maxLength={SYSTEM_PROMPT_ADDENDUM_MAX_LENGTH}
                defaultValue={initialConfig?.systemPromptAddendum ?? ""}
                placeholder={evalT("systemPromptAddendumPlaceholder")}
                className={inputClass}
              />
            </div>
          </div>

          {state.errorCode && (
            <p className="text-sm text-red-600 dark:text-red-400">
              {errorT(state.errorCode, state.errorParams)}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="submit"
              name="intent"
              value="save"
              disabled={pending}
              className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-60 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
            >
              {pending ? t("ragConfig.saving") : t("ragConfig.save")}
            </button>
            {hasCustomConfig && (
              <button
                type="submit"
                name="intent"
                value="reset"
                formNoValidate
                disabled={pending}
                className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-600 transition hover:border-neutral-500 disabled:opacity-60 dark:border-neutral-700 dark:text-neutral-300"
              >
                {t("ragConfig.resetDefaults")}
              </button>
            )}
            {state.ok && !pending && (
              <span className="text-xs text-emerald-600 dark:text-emerald-400">
                {t("ragConfig.saved")}
              </span>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
