"use client";

import { useActionState } from "react";

import {
  type ActionState,
  deleteKnowledgeBaseAction,
} from "@/lib/knowledge-base-actions";

export function DeleteKnowledgeBaseButton({
  workspaceSlug,
  knowledgeBaseId,
  knowledgeBaseName,
}: {
  workspaceSlug: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
}) {
  const boundAction = deleteKnowledgeBaseAction.bind(
    null,
    workspaceSlug,
    knowledgeBaseId,
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
            `Delete "${knowledgeBaseName}"? This also deletes all of its documents and cannot be undone.`,
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
        {pending ? "Deleting…" : "Delete knowledge base"}
      </button>
    </form>
  );
}
