import type { KnowledgeBaseRagConfig } from "@/db/schema";

export type { KnowledgeBaseRagConfig } from "@/db/schema";

export const TOP_K_MIN = 1;
export const TOP_K_MAX = 20;
export const MIN_SCORE_MIN = 0;
export const MIN_SCORE_MAX = 1;
export const SYSTEM_PROMPT_ADDENDUM_MAX_LENGTH = 1000;

export const RETRIEVAL_MODES = ["hybrid", "vector", "keyword"] as const;
export type RetrievalMode = (typeof RETRIEVAL_MODES)[number];

export const RERANKER_MODES = ["none", "heuristic", "llm"] as const;
export type RerankerMode = (typeof RERANKER_MODES)[number];

function isValidRetrievalMode(value: unknown): value is RetrievalMode {
  return (
    typeof value === "string" &&
    (RETRIEVAL_MODES as readonly string[]).includes(value)
  );
}

function isValidRerankerMode(value: unknown): value is RerankerMode {
  return (
    typeof value === "string" &&
    (RERANKER_MODES as readonly string[]).includes(value)
  );
}

/**
 * Extract and normalize only the live runtime RAG parameters from an arbitrary
 * config object (e.g. `evaluation_runs.config` or stored `rag_config`),
 * stripping evaluation-only flags like `useLlmJudge` or legacy index fields.
 */
export function sanitizeRagConfig(
  input: Record<string, unknown> | null | undefined,
): KnowledgeBaseRagConfig {
  if (!input || typeof input !== "object") {
    return {};
  }

  const out: KnowledgeBaseRagConfig = {};

  const rawTopK = input.topK ?? input.top_k;
  if (typeof rawTopK === "number" && Number.isInteger(rawTopK)) {
    if (rawTopK >= TOP_K_MIN && rawTopK <= TOP_K_MAX) {
      out.topK = rawTopK;
    }
  } else if (typeof rawTopK === "string" && rawTopK.trim() !== "") {
    const parsed = Number(rawTopK.trim());
    if (Number.isInteger(parsed) && parsed >= TOP_K_MIN && parsed <= TOP_K_MAX) {
      out.topK = parsed;
    }
  }

  const rawMode = input.retrievalMode ?? input.retrieval_mode;
  const normMode = typeof rawMode === "string" ? rawMode.trim().toLowerCase() : undefined;
  if (isValidRetrievalMode(normMode)) {
    out.retrievalMode = normMode;
  }

  const rawMinScore = input.minScore ?? input.min_score;
  if (typeof rawMinScore === "number" && Number.isFinite(rawMinScore)) {
    if (rawMinScore >= MIN_SCORE_MIN && rawMinScore <= MIN_SCORE_MAX) {
      out.minScore = Number(rawMinScore.toFixed(4));
    }
  } else if (typeof rawMinScore === "string" && rawMinScore.trim() !== "") {
    const parsed = Number(rawMinScore.trim());
    if (Number.isFinite(parsed) && parsed >= MIN_SCORE_MIN && parsed <= MIN_SCORE_MAX) {
      out.minScore = Number(parsed.toFixed(4));
    }
  }

  const rawRewrite = input.queryRewrite ?? input.query_rewrite;
  if (typeof rawRewrite === "boolean") {
    out.queryRewrite = rawRewrite;
  } else if (rawRewrite === "true") {
    out.queryRewrite = true;
  } else if (rawRewrite === "false") {
    out.queryRewrite = false;
  }

  const rawReranker = input.reranker;
  const normReranker =
    typeof rawReranker === "string" ? rawReranker.trim().toLowerCase() : undefined;
  if (isValidRerankerMode(normReranker) && normReranker !== "none") {
    out.reranker = normReranker;
  }

  const rawAddendum =
    input.systemPromptAddendum ?? input.system_prompt_addendum;
  if (typeof rawAddendum === "string" && rawAddendum.trim().length > 0) {
    out.systemPromptAddendum = rawAddendum
      .trim()
      .slice(0, SYSTEM_PROMPT_ADDENDUM_MAX_LENGTH);
  }

  return out;
}

/**
 * Strict FormData parser used by KnowledgeBaseRagConfigForm and
 * TriggerEvaluationRunForm. Returns `{ errorCode: "RAG_CONFIG_INVALID" }` when
 * user-supplied numeric/text bounds are violated instead of silently dropping.
 */
export function parseRagConfigFromFormData(
  formData: FormData,
):
  | { config: KnowledgeBaseRagConfig }
  | { errorCode: "RAG_CONFIG_INVALID" } {
  const config: KnowledgeBaseRagConfig = {};

  const topKRaw = String(formData.get("topK") ?? "").trim();
  if (topKRaw !== "") {
    const topK = Number(topKRaw);
    if (!Number.isInteger(topK) || topK < TOP_K_MIN || topK > TOP_K_MAX) {
      return { errorCode: "RAG_CONFIG_INVALID" };
    }
    config.topK = topK;
  }

  const modeRaw = String(formData.get("retrievalMode") ?? "")
    .trim()
    .toLowerCase();
  if (modeRaw !== "") {
    if (!isValidRetrievalMode(modeRaw)) {
      return { errorCode: "RAG_CONFIG_INVALID" };
    }
    config.retrievalMode = modeRaw;
  }

  const minScoreRaw = String(formData.get("minScore") ?? "").trim();
  if (minScoreRaw !== "") {
    const minScore = Number(minScoreRaw);
    if (
      !Number.isFinite(minScore) ||
      minScore < MIN_SCORE_MIN ||
      minScore > MIN_SCORE_MAX
    ) {
      return { errorCode: "RAG_CONFIG_INVALID" };
    }
    config.minScore = Number(minScore.toFixed(4));
  }

  const rewriteRaw = String(formData.get("queryRewrite") ?? "").trim();
  if (rewriteRaw === "true") {
    config.queryRewrite = true;
  } else if (rewriteRaw === "false") {
    config.queryRewrite = false;
  } else if (rewriteRaw !== "") {
    return { errorCode: "RAG_CONFIG_INVALID" };
  }

  const rerankerRaw = String(formData.get("reranker") ?? "")
    .trim()
    .toLowerCase();
  if (rerankerRaw !== "" && rerankerRaw !== "none") {
    if (!isValidRerankerMode(rerankerRaw)) {
      return { errorCode: "RAG_CONFIG_INVALID" };
    }
    config.reranker = rerankerRaw;
  }

  const addendumRaw = String(formData.get("systemPromptAddendum") ?? "").trim();
  if (addendumRaw.length > SYSTEM_PROMPT_ADDENDUM_MAX_LENGTH) {
    return { errorCode: "RAG_CONFIG_INVALID" };
  }
  if (addendumRaw.length > 0) {
    config.systemPromptAddendum = addendumRaw;
  }

  return { config };
}

/**
 * Compare two RAG configs after sanitization (ignoring evaluation-only flags
 * such as `useLlmJudge` and treating `reranker: "none"` as default).
 */
export function areRagConfigsEqual(
  a: Record<string, unknown> | null | undefined,
  b: Record<string, unknown> | null | undefined,
): boolean {
  const cleanA = sanitizeRagConfig(a);
  const cleanB = sanitizeRagConfig(b);
  const keys = [
    "topK",
    "retrievalMode",
    "minScore",
    "queryRewrite",
    "reranker",
    "systemPromptAddendum",
  ] as const;

  return keys.every((k) => cleanA[k] === cleanB[k]);
}
