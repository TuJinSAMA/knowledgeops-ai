"use client";

import { useActionState } from "react";

import {
  type ActionState,
  createKnowledgeBaseAction,
} from "@/lib/knowledge-base-actions";

export function CreateKnowledgeBaseForm({ workspaceSlug }: { workspaceSlug: string }) {
  const boundAction = createKnowledgeBaseAction.bind(null, workspaceSlug);
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    boundAction,
    {},
  );

  return (
    <form action={formAction} className="space-y-3">
      <div className="space-y-1.5">
        <label htmlFor="kb-name" className="block text-sm font-medium">
          Name
        </label>
        <input
          id="kb-name"
          name="name"
          type="text"
          placeholder="Product documentation"
          required
          className="w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:focus:border-neutral-200"
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="kb-description" className="block text-sm font-medium">
          Description <span className="text-neutral-400">(optional)</span>
        </label>
        <textarea
          id="kb-description"
          name="description"
          rows={2}
          placeholder="What kind of knowledge lives here?"
          className="w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:focus:border-neutral-200"
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
        {pending ? "Creating…" : "Create knowledge base"}
      </button>
    </form>
  );
}
