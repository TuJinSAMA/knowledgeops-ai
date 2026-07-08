/**
 * Per-model price map for estimating answer cost (mvp-plan T5.2). Prices are in
 * USD per 1,000,000 tokens, split into prompt (input) and completion (output)
 * rates. The map lives in the web layer (single place to maintain pricing) and
 * is applied to the `token_usage` the AI service returns on its `done` event.
 *
 * Offline/fake providers cost nothing. Unknown models return `null` so we never
 * fabricate a cost figure; the trace simply records no estimate.
 *
 * Sources (update when providers change pricing):
 *   - deepseek-chat: DeepSeek API standard pricing (USD/1M tokens),
 *     input (cache miss) $0.27, output $1.10. https://api-docs.deepseek.com/quick_start/pricing
 *   - fake-llm: deterministic offline provider, no cost.
 */

export type TokenUsage = {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
};

export type ModelPrice = {
  /** USD per 1,000,000 prompt (input) tokens. */
  inputPer1M: number;
  /** USD per 1,000,000 completion (output) tokens. */
  outputPer1M: number;
};

const TOKENS_PER_UNIT = 1_000_000;

export const PRICE_MAP: Record<string, ModelPrice> = {
  "deepseek-chat": { inputPer1M: 0.27, outputPer1M: 1.1 },
  // Deterministic offline provider used in fake mode — free.
  "fake-llm": { inputPer1M: 0, outputPer1M: 0 },
};

/**
 * Estimate the USD cost of one answer from its token usage and model. Returns
 * `null` when the model is unknown (no price entry) or usage is missing, so the
 * caller can record an absent estimate rather than a misleading zero.
 *
 * Pure function — no I/O — so it is trivially unit-tested.
 */
export function estimateCost(
  model: string | null | undefined,
  usage: TokenUsage | null | undefined,
): number | null {
  if (!model || !usage) {
    return null;
  }
  const price = PRICE_MAP[model];
  if (!price) {
    return null;
  }
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  const cost =
    (promptTokens * price.inputPer1M + completionTokens * price.outputPer1M) /
    TOKENS_PER_UNIT;
  // Guard against negative/NaN inputs producing junk.
  if (!Number.isFinite(cost) || cost < 0) {
    return null;
  }
  return cost;
}
