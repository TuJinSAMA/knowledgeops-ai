"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";

import {
  type ActionState,
  deleteEvaluationCaseAction,
} from "@/lib/evaluation-actions";

export function DeleteEvaluationCaseButton({
  workspaceSlug,
  datasetId,
  caseId,
}: {
  workspaceSlug: string;
  datasetId: string;
  caseId: string;
}) {
  const t = useTranslations("evaluations");
  const errorT = useTranslations("errors");
  const boundAction = deleteEvaluationCaseAction.bind(
    null,
    workspaceSlug,
    datasetId,
    caseId,
  );
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    boundAction,
    {},
  );

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (!window.confirm(t("deleteCaseConfirm"))) {
          event.preventDefault();
        }
      }}
    >
      {state.errorCode && (
        <span className="mr-2 text-xs text-red-600 dark:text-red-400">
          {errorT(state.errorCode, state.errorParams)}
        </span>
      )}
      <button
        type="submit"
        disabled={pending}
        className="text-xs font-medium text-red-600 underline-offset-4 hover:underline disabled:opacity-60 dark:text-red-400"
      >
        {pending ? t("deleting") : t("delete")}
      </button>
    </form>
  );
}
