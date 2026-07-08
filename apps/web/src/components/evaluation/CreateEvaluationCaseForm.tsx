"use client";

import { useActionState } from "react";

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
    <form action={formAction} className="space-y-3" key={state.error ? "err" : "ok"}>
      <div className="space-y-1.5">
        <label htmlFor="case-question" className="block text-sm font-medium">
          Question
        </label>
        <textarea
          id="case-question"
          name="question"
          rows={2}
          required
          placeholder="How do I reset my password?"
          className={inputClass}
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="case-answer" className="block text-sm font-medium">
          Expected answer <span className="text-neutral-400">(optional)</span>
        </label>
        <textarea
          id="case-answer"
          name="expectedAnswer"
          rows={2}
          placeholder="Use the 'Forgot password' link on the sign-in page."
          className={inputClass}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label
            htmlFor="case-docs"
            className="block text-sm font-medium"
          >
            Expected source documents{" "}
            <span className="text-neutral-400">(ids, one per line)</span>
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
            Expected chunks{" "}
            <span className="text-neutral-400">(ids, one per line)</span>
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
            Required facts{" "}
            <span className="text-neutral-400">(one per line)</span>
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
            Tags <span className="text-neutral-400">(comma separated)</span>
          </label>
          <input
            id="case-tags"
            name="tags"
            type="text"
            placeholder="auth, billing"
            className={inputClass}
          />
        </div>
      </div>

      {state.error && (
        <p className="text-sm text-red-600 dark:text-red-400">{state.error}</p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-60 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
      >
        {pending ? "Adding…" : "Add case"}
      </button>
    </form>
  );
}
