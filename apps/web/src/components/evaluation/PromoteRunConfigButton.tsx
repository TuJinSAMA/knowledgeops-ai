"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";

import {
  type ActionState,
  promoteEvaluationRunConfigAction,
} from "@/lib/evaluation-actions";

export function PromoteRunConfigButton({
  workspaceSlug,
  datasetId,
  runId,
  knowledgeBaseName,
  isLive,
  canManage,
}: {
  workspaceSlug: string;
  datasetId: string;
  runId: string;
  knowledgeBaseName: string;
  isLive: boolean;
  canManage: boolean;
}) {
  const t = useTranslations("evaluations");
  const errorT = useTranslations("errors");
  const boundAction = promoteEvaluationRunConfigAction.bind(
    null,
    workspaceSlug,
    datasetId,
    runId,
  );
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    boundAction,
    {},
  );

  if (isLive || state.ok) {
    return (
      <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
        {t("liveOnKnowledgeBase", { name: knowledgeBaseName })}
      </span>
    );
  }

  if (!canManage) {
    return null;
  }

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (
          !window.confirm(
            t("promoteConfigConfirm", { name: knowledgeBaseName }),
          )
        ) {
          event.preventDefault();
        }
      }}
      className="inline-flex flex-col items-start gap-1"
    >
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-900 transition hover:border-neutral-900 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:hover:border-neutral-300"
      >
        {pending
          ? t("promotingConfig")
          : t("promoteConfigButton", { name: knowledgeBaseName })}
      </button>
      {state.errorCode && (
        <p className="text-xs text-red-600 dark:text-red-400">
          {errorT(state.errorCode, state.errorParams)}
        </p>
      )}
    </form>
  );
}
