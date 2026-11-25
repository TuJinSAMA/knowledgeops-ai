import { describe, expect, it } from "vitest";

import type { EvaluationResultRecord } from "./evaluation";
import { buildCaseComparisonRows } from "./evaluation-compare";

function makeResult(
  overrides: Partial<EvaluationResultRecord> & {
    caseId: string;
    question: string;
    category?: string;
    answer?: string;
  },
): EvaluationResultRecord {
  return {
    id: `res-${overrides.caseId}`,
    runId: overrides.runId ?? "run-1",
    caseId: overrides.caseId,
    question: overrides.question,
    retrievalHit: overrides.retrievalHit ?? "1.0000",
    citationAccuracy: overrides.citationAccuracy ?? "1.0000",
    correctness: overrides.correctness ?? "0.9000",
    groundedness: overrides.groundedness ?? "0.9000",
    latencyMs: overrides.latencyMs ?? 500,
    costEstimate: overrides.costEstimate ?? "0.000200",
    raw: {
      failure_category: overrides.category ?? "PASS",
      answer: overrides.answer ?? "Sample answer [1]",
    },
    createdAt: new Date("2026-11-25T00:00:00Z"),
  };
}

describe("buildCaseComparisonRows", () => {
  it("classifies PASS -> non-PASS as REGRESSED, non-PASS -> PASS as IMPROVED, and sorts regressions first", () => {
    const runA = [
      makeResult({ caseId: "c-unchanged", question: "Q unchanged", category: "PASS" }),
      makeResult({
        caseId: "c-improved",
        question: "Q improved",
        category: "RETRIEVAL_MISS",
        retrievalHit: "0.0000",
      }),
      makeResult({
        caseId: "c-regressed",
        question: "Q regressed",
        category: "PASS",
        correctness: "1.0000",
      }),
    ];

    const runB = [
      makeResult({ caseId: "c-unchanged", question: "Q unchanged", category: "PASS" }),
      makeResult({
        caseId: "c-improved",
        question: "Q improved",
        category: "PASS",
        retrievalHit: "1.0000",
      }),
      makeResult({
        caseId: "c-regressed",
        question: "Q regressed",
        category: "HALLUCINATION_RISK",
        correctness: "0.4000",
      }),
    ];

    const rows = buildCaseComparisonRows(runA, runB);
    expect(rows.map((r) => [r.caseId, r.diffStatus])).toEqual([
      ["c-regressed", "REGRESSED"],
      ["c-improved", "IMPROVED"],
      ["c-unchanged", "UNCHANGED"],
    ]);
    expect(rows[0].correctnessDelta).toBeCloseTo(-0.6, 4);
  });

  it("flags metric drops >= 0.20 as REGRESSED even without category labels, and handles single-side cases", () => {
    const runA = [
      makeResult({
        caseId: "c-score-drop",
        question: "Q drop",
        category: "",
        groundedness: "0.8500",
      }),
    ];
    const runB = [
      makeResult({
        caseId: "c-score-drop",
        question: "Q drop",
        category: "",
        groundedness: "0.6000",
      }),
      makeResult({ caseId: "c-new", question: "New case in B" }),
    ];

    const rows = buildCaseComparisonRows(runA, runB);
    expect(rows[0]).toMatchObject({
      caseId: "c-score-drop",
      diffStatus: "REGRESSED",
    });
    expect(rows[1]).toMatchObject({
      caseId: "c-new",
      diffStatus: "ONLY_IN_B",
    });
  });
});
