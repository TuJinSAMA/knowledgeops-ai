import type { EvaluationRunConfig } from "./evaluation";

// Metric keys shown (in order) for a run, with human labels. Per-case results
// expose retrieval_hit / citation_accuracy / correctness / groundedness as
// numeric scores; run summaries reuse the same labels for their aggregates.
export const RUN_METRIC_KEYS = [
  "retrievalHit",
  "citationAccuracy",
  "correctness",
  "groundedness",
];

/** Format a 0..1 numeric score (stored as a string by pg) as a percentage. */
export function formatScore(
  value: string | number | null | undefined,
  locale = "en-US",
): string {
  if (value == null) {
    return "—";
  }
  const num = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(num)) {
    return "—";
  }
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
  }).format(num);
}

/** Format an estimated USD cost (stored as a string by pg). */
export function formatCost(
  value: string | number | null | undefined,
  locale = "en-US",
): string {
  if (value == null) {
    return "—";
  }
  const num = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(num)) {
    return "—";
  }
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 6,
  }).format(num);
}

export function formatLatency(
  ms: number | null | undefined,
  locale = "en-US",
): string {
  return ms == null
    ? "—"
    : `${new Intl.NumberFormat(locale).format(ms)} ms`;
}

/** Render a run config object as a compact "key=value · key=value" string. */
export function formatConfig(
  config: EvaluationRunConfig | Record<string, unknown> | null,
  defaultsLabel = "defaults",
): string {
  if (!config || Object.keys(config).length === 0) {
    return defaultsLabel;
  }
  return Object.entries(config)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" · ");
}

/**
 * Pull a numeric summary metric out of a run's summary_metrics jsonb. The worker
 * (T7.3) owns the exact keys; we look up a few common spellings so the UI renders
 * sensibly regardless of camelCase/snake_case. Returns null when absent.
 */
export function summaryMetric(
  summary: Record<string, unknown> | null,
  key: string,
): number | null {
  if (!summary) {
    return null;
  }
  const candidates = [
    key,
    key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`),
    `${key}_rate`,
  ];
  for (const candidate of candidates) {
    const value = summary[candidate];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return null;
}
