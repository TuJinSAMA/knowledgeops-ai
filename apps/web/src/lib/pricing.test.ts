import { describe, expect, it } from "vitest";

import { estimateCost } from "./pricing";

describe("estimateCost", () => {
  it("computes deepseek-chat cost from prompt + completion tokens", () => {
    // 1,000,000 prompt @ $0.27 + 1,000,000 completion @ $1.10 = $1.37
    const cost = estimateCost("deepseek-chat", {
      prompt_tokens: 1_000_000,
      completion_tokens: 1_000_000,
      total_tokens: 2_000_000,
    });
    expect(cost).toBeCloseTo(1.37, 6);
  });

  it("scales linearly for small token counts", () => {
    const cost = estimateCost("deepseek-chat", {
      prompt_tokens: 1000,
      completion_tokens: 500,
    });
    // 1000 * 0.27/1e6 + 500 * 1.10/1e6 = 0.00027 + 0.00055 = 0.00082
    expect(cost).toBeCloseTo(0.00082, 8);
  });

  it("returns 0 for the deterministic fake provider", () => {
    expect(
      estimateCost("fake-llm", { prompt_tokens: 100, completion_tokens: 100 }),
    ).toBe(0);
  });

  it("returns null for an unknown model (never fabricates a cost)", () => {
    expect(
      estimateCost("mystery-model", { prompt_tokens: 10, completion_tokens: 10 }),
    ).toBeNull();
  });

  it("returns null when model or usage is missing", () => {
    expect(estimateCost(null, { prompt_tokens: 10 })).toBeNull();
    expect(estimateCost("deepseek-chat", null)).toBeNull();
  });

  it("treats missing token fields as zero", () => {
    expect(estimateCost("deepseek-chat", {})).toBe(0);
    expect(
      estimateCost("deepseek-chat", { completion_tokens: 1_000_000 }),
    ).toBeCloseTo(1.1, 6);
  });
});
