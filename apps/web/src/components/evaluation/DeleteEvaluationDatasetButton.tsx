"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";

import {
  type ActionState,
  deleteEvaluationDatasetAction,
} from "@/lib/evaluation-actions";

export function DeleteEvaluationDatasetButton({
  workspaceSlug,
  datasetId,
  datasetName,
}: {
  workspaceSlug: string;
  datasetId: string;
  datasetName: string;
}) {
  const t = useTranslations("evaluations");
  const errorT = useTranslations("errors");
  const boundAction = deleteEvaluationDatasetAction.bind(
    null,
    workspaceSlug,
    datasetId,
  );
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    boundAction,
    {},
  );

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (
          !window.confirm(
            t("deleteConfirm", { name: datasetName }),
          )
        ) {
          event.preventDefault();
        }
      }}
      className="space-y-2"
    >
      {state.errorCode && (
        <p className="text-sm text-red-600 dark:text-red-400">
          {errorT(state.errorCode, state.errorParams)}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-60 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
      >
        {pending ? t("deleting") : t("deleteDataset")}
      </button>
    </form>
  );
}
