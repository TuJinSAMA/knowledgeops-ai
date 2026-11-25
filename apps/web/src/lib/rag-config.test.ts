import { describe, expect, it } from "vitest";

import {
  areRagConfigsEqual,
  parseRagConfigFromFormData,
  sanitizeRagConfig,
  SYSTEM_PROMPT_ADDENDUM_MAX_LENGTH,
} from "./rag-config";

function formDataOf(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) {
    fd.append(k, v);
  }
  return fd;
}

describe("sanitizeRagConfig", () => {
  it("strips evaluation-only and legacy index fields while keeping valid runtime knobs", () => {
    const cleaned = sanitizeRagConfig({
      topK: 6,
      retrievalMode: "hybrid",
      minScore: 0.42,
      queryRewrite: true,
      reranker: "heuristic",
      systemPromptAddendum: "  Be concise.  ",
      useLlmJudge: true,
      chunkSize: 500,
      embeddingModel: "qwen/qwen3-embedding-8b",
      promptVersion: "v2",
    });

    expect(cleaned).toEqual({
      topK: 6,
      retrievalMode: "hybrid",
      minScore: 0.42,
      queryRewrite: true,
      reranker: "heuristic",
      systemPromptAddendum: "Be concise.",
    });
  });

  it("normalizes snake_case keys and treats reranker='none' as default", () => {
    expect(
      sanitizeRagConfig({
        top_k: 4,
        retrieval_mode: "vector",
        min_score: 0.3,
        query_rewrite: false,
        reranker: "none",
      }),
    ).toEqual({
      topK: 4,
      retrievalMode: "vector",
      minScore: 0.3,
      queryRewrite: false,
    });
  });

  it("drops out-of-range numbers and returns empty object for null/empty input", () => {
    expect(sanitizeRagConfig(null)).toEqual({});
    expect(sanitizeRagConfig({ topK: 99, minScore: -0.5 })).toEqual({});
  });
});

describe("parseRagConfigFromFormData", () => {
  it("parses valid form fields cleanly", () => {
    const res = parseRagConfigFromFormData(
      formDataOf({
        topK: "8",
        retrievalMode: "hybrid",
        minScore: "0.35",
        queryRewrite: "true",
        reranker: "llm",
        systemPromptAddendum: "Answer politely.",
      }),
    );
    expect(res).toEqual({
      config: {
        topK: 8,
        retrievalMode: "hybrid",
        minScore: 0.35,
        queryRewrite: true,
        reranker: "llm",
        systemPromptAddendum: "Answer politely.",
      },
    });
  });

  it("rejects invalid topK, minScore, or overlong addendum with RAG_CONFIG_INVALID", () => {
    expect(parseRagConfigFromFormData(formDataOf({ topK: "0" }))).toEqual({
      errorCode: "RAG_CONFIG_INVALID",
    });
    expect(parseRagConfigFromFormData(formDataOf({ topK: "25" }))).toEqual({
      errorCode: "RAG_CONFIG_INVALID",
    });
    expect(parseRagConfigFromFormData(formDataOf({ minScore: "1.2" }))).toEqual({
      errorCode: "RAG_CONFIG_INVALID",
    });
    expect(
      parseRagConfigFromFormData(
        formDataOf({
          systemPromptAddendum: "a".repeat(
            SYSTEM_PROMPT_ADDENDUM_MAX_LENGTH + 1,
          ),
        }),
      ),
    ).toEqual({
      errorCode: "RAG_CONFIG_INVALID",
    });
  });
});

describe("areRagConfigsEqual", () => {
  it("treats run config with useLlmJudge and reranker='none' as equal to promoted live config", () => {
    const runConfig = {
      topK: 6,
      retrievalMode: "hybrid",
      reranker: "none",
      useLlmJudge: true,
    };
    const liveConfig = {
      topK: 6,
      retrievalMode: "hybrid",
    };
    expect(areRagConfigsEqual(runConfig, liveConfig)).toBe(true);
    expect(areRagConfigsEqual(null, {})).toBe(true);
    expect(areRagConfigsEqual(liveConfig, { topK: 4, retrievalMode: "hybrid" })).toBe(
      false,
    );
  });
});
