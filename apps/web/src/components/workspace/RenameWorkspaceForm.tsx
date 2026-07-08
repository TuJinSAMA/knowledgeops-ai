"use client";

import { useActionState } from "react";

import {
  type ActionState,
  renameWorkspaceAction,
} from "@/lib/workspace-actions";

export function RenameWorkspaceForm({
  workspaceId,
  slug,
  currentName,
}: {
  workspaceId: string;
  slug: string;
  currentName: string;
}) {
  const boundAction = renameWorkspaceAction.bind(null, workspaceId, slug);
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    boundAction,
    {},
  );

  return (
    <form action={formAction} className="space-y-3">
      <div className="space-y-1.5">
        <label htmlFor="name" className="block text-sm font-medium">
          Workspace name
        </label>
        <input
          id="name"
          name="name"
          type="text"
          defaultValue={currentName}
          required
          className="w-full max-w-md rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:focus:border-neutral-200"
        />
      </div>

      {state.error && (
        <p className="text-sm text-red-600 dark:text-red-400">{state.error}</p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-60 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
      >
        {pending ? "Saving…" : "Save changes"}
      </button>
    </form>
  );
}
