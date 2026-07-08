"use client";

import { useActionState } from "react";

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
            `Delete "${datasetName}"? This also deletes all of its cases, runs and results and cannot be undone.`,
          )
        ) {
          event.preventDefault();
        }
      }}
      className="space-y-2"
    >
      {state.error && (
        <p className="text-sm text-red-600 dark:text-red-400">{state.error}</p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-60 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
      >
        {pending ? "Deleting…" : "Delete dataset"}
      </button>
    </form>
  );
}
