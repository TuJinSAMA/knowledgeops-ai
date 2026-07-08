"use client";

import { useState, useTransition } from "react";

import {
  submitFeedbackAction,
  type SubmitFeedbackInput,
} from "@/lib/feedback-actions";

type Rating = "HELPFUL" | "NOT_HELPFUL";
type ReportType = "WRONG_ANSWER" | "MISSING_KNOWLEDGE" | "OTHER";

const REPORT_OPTIONS: { value: ReportType; label: string }[] = [
  { value: "WRONG_ANSWER", label: "Wrong answer" },
  { value: "MISSING_KNOWLEDGE", label: "Missing knowledge" },
  { value: "OTHER", label: "Other" },
];

const ratingButtonClass = (active: boolean): string =>
  `rounded border px-1.5 py-0.5 text-xs transition ${
    active
      ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
      : "border-neutral-200 text-neutral-600 hover:bg-neutral-50 dark:border-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-900"
  }`;

/**
 * Inline feedback controls under an assistant answer (Phase 6). A coarse
 * helpful / not helpful rating plus an optional detailed report (wrong answer /
 * missing knowledge / other + comment). State stays local: the rating is
 * visible and changeable after submitting, and re-submitting upserts server
 * side (one feedback per user per answer).
 */
export function FeedbackControls({
  workspaceSlug,
  messageId,
}: {
  workspaceSlug: string;
  messageId: string;
}) {
  const [rating, setRating] = useState<Rating | null>(null);
  const [reportType, setReportType] = useState<ReportType>("WRONG_ANSWER");
  const [comment, setComment] = useState("");
  const [showReport, setShowReport] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (input: Omit<SubmitFeedbackInput, "workspaceSlug" | "messageId">) => {
    setError(null);
    startTransition(async () => {
      const result = await submitFeedbackAction({
        workspaceSlug,
        messageId,
        ...input,
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      setRating(input.rating);
      setSaved(true);
    });
  };

  const rate = (next: Rating) => {
    if (next === "NOT_HELPFUL") {
      setShowReport(true);
    }
    submit({ rating: next });
  };

  const submitReport = () => {
    submit({
      rating: "NOT_HELPFUL",
      reportType,
      comment: comment.trim() || null,
    });
    setShowReport(false);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => rate("HELPFUL")}
          className={ratingButtonClass(rating === "HELPFUL")}
        >
          Helpful
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => rate("NOT_HELPFUL")}
          className={ratingButtonClass(rating === "NOT_HELPFUL")}
        >
          Not helpful
        </button>
        <button
          type="button"
          onClick={() => setShowReport((v) => !v)}
          className="text-xs text-neutral-500 underline-offset-4 hover:underline"
        >
          {showReport ? "Cancel report" : "Report issue"}
        </button>
        {saved && !pending && (
          <span className="text-xs text-emerald-600 dark:text-emerald-400">
            Thanks for the feedback
          </span>
        )}
      </div>

      {showReport && (
        <div className="space-y-2 rounded-md border border-neutral-200 p-2 dark:border-neutral-800">
          <select
            value={reportType}
            onChange={(e) => setReportType(e.target.value as ReportType)}
            className="w-full rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-xs outline-none dark:border-neutral-700"
          >
            {REPORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={2}
            placeholder="What went wrong? (optional)"
            className="w-full resize-none rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-xs outline-none dark:border-neutral-700"
          />
          <button
            type="button"
            disabled={pending}
            onClick={submitReport}
            className="rounded bg-neutral-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-60 dark:bg-white dark:text-neutral-900"
          >
            {pending ? "Submitting…" : "Submit report"}
          </button>
        </div>
      )}

      {error && (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}
