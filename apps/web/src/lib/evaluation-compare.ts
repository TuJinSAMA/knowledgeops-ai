import type { EvaluationResultRecord } from "./evaluation";

export type CaseDiffStatus =
  | "REGRESSED"
  | "IMPROVED"
  | "UNCHANGED"
  | "ONLY_IN_A"
  | "ONLY_IN_B";

export type CaseComparisonSide = {
  category: string | null;
  answer: string | null;
  judgeRationale: string | null;
  retrievalHit: number | null;
  citationAccuracy: number | null;
  correctness: number | null;
  groundedness: number | null;
  latencyMs: number | null;
  costEstimate: number | null;
};

export type CaseComparisonRow = {
  caseId: string;
  question: string;
  diffStatus: CaseDiffStatus;
  a: CaseComparisonSide | null;
  b: CaseComparisonSide | null;
  correctnessDelta: number | null;
  groundednessDelta: number | null;
};

function toFiniteNumber(val: string | number | null | undefined): number | null {
  if (val == null) return null;
  const num = typeof val === "number" ? val : Number(val);
  return Number.isFinite(num) ? num : null;
}

function toSide(record: EvaluationResultRecord): CaseComparisonSide {
  const raw = (record.raw ?? {}) as {
    failure_category?: unknown;
    answer?: unknown;
    judge_rationale?: unknown;
  };
  return {
    category:
      typeof raw.failure_category === "string" && raw.failure_category
        ? raw.failure_category
        : null,
    answer: typeof raw.answer === "string" ? raw.answer : null,
    judgeRationale:
      typeof raw.judge_rationale === "string" && raw.judge_rationale
        ? raw.judge_rationale
        : null,
    retrievalHit: toFiniteNumber(record.retrievalHit),
    citationAccuracy: toFiniteNumber(record.citationAccuracy),
    correctness: toFiniteNumber(record.correctness),
    groundedness: toFiniteNumber(record.groundedness),
    latencyMs: record.latencyMs ?? null,
    costEstimate: toFiniteNumber(record.costEstimate),
  };
}

function classifyTransition(
  a: CaseComparisonSide,
  b: CaseComparisonSide,
): CaseDiffStatus {
  if (a.category === "PASS" && b.category && b.category !== "PASS") {
    return "REGRESSED";
  }
  if (a.category && a.category !== "PASS" && b.category === "PASS") {
    return "IMPROVED";
  }

  const metricPairs: Array<[number | null, number | null]> = [
    [a.correctness, b.correctness],
    [a.groundedness, b.groundedness],
    [a.retrievalHit, b.retrievalHit],
    [a.citationAccuracy, b.citationAccuracy],
  ];

  const deltas = metricPairs
    .filter(
      (pair): pair is [number, number] => pair[0] != null && pair[1] != null,
    )
    .map(([valA, valB]) => valB - valA);

  if (deltas.some((d) => d <= -0.2)) {
    return "REGRESSED";
  }
  if (deltas.some((d) => d >= 0.2) && !deltas.some((d) => d <= -0.1)) {
    return "IMPROVED";
  }
  return "UNCHANGED";
}

const STATUS_ORDER: Record<CaseDiffStatus, number> = {
  REGRESSED: 0,
  IMPROVED: 1,
  ONLY_IN_B: 2,
  ONLY_IN_A: 3,
  UNCHANGED: 4,
};

/**
 * Align per-case results of Run A (baseline) and Run B (candidate), classify
 * each case's regression/improvement transition, and sort regressions first so
 * operators immediately spot broken cases hidden behind aggregate averages.
 */
export function buildCaseComparisonRows(
  resultsA: EvaluationResultRecord[],
  resultsB: EvaluationResultRecord[],
): CaseComparisonRow[] {
  const byCaseA = new Map<string, EvaluationResultRecord>();
  for (const r of resultsA) {
    byCaseA.set(r.caseId, r);
  }
  const byCaseB = new Map<string, EvaluationResultRecord>();
  for (const r of resultsB) {
    byCaseB.set(r.caseId, r);
  }

  const orderedCaseIds = [
    ...new Set([...byCaseB.keys(), ...byCaseA.keys()]),
  ];

  const rows: CaseComparisonRow[] = orderedCaseIds.map((caseId) => {
    const recA = byCaseA.get(caseId);
    const recB = byCaseB.get(caseId);
    const sideA = recA ? toSide(recA) : null;
    const sideB = recB ? toSide(recB) : null;

    let diffStatus: CaseDiffStatus;
    if (sideA && sideB) {
      diffStatus = classifyTransition(sideA, sideB);
    } else if (sideA) {
      diffStatus = "ONLY_IN_A";
    } else {
      diffStatus = "ONLY_IN_B";
    }

    const correctnessDelta =
      sideA?.correctness != null && sideB?.correctness != null
        ? sideB.correctness - sideA.correctness
        : null;
    const groundednessDelta =
      sideA?.groundedness != null && sideB?.groundedness != null
        ? sideB.groundedness - sideA.groundedness
        : null;

    return {
      caseId,
      question: recB?.question ?? recA?.question ?? "",
      diffStatus,
      a: sideA,
      b: sideB,
      correctnessDelta,
      groundednessDelta,
    };
  });

  return rows.sort(
    (x, y) => STATUS_ORDER[x.diffStatus] - STATUS_ORDER[y.diffStatus],
  );
}
