import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  and: (...conds: unknown[]) => ({ op: "and", conds }),
  desc: (col: unknown) => ({ op: "desc", col }),
  sql: () => ({ mapWith: () => ({}) }),
}));

vi.mock("@/db/schema", () => {
  const table = (name: string) =>
    new Proxy(
      { __table: name },
      {
        get: (target, prop) =>
          prop in target ? (target as Record<PropertyKey, unknown>)[prop] : `${name}.${String(prop)}`,
      },
    );
  return {
    answerFeedback: table("answerFeedback"),
    conversations: table("conversations"),
    documentChunks: table("documentChunks"),
    documents: table("documents"),
    evaluationRuns: table("evaluationRuns"),
    knowledgeBases: table("knowledgeBases"),
    messages: table("messages"),
    ragTraces: table("ragTraces"),
  };
});

const captured: { wheres: unknown[]; resultsByTable: Map<unknown, unknown[]> } = {
  wheres: [],
  resultsByTable: new Map(),
};

function makeChain() {
  const state: { table: unknown } = { table: null };
  const chain: Record<string, unknown> = {};
  for (const m of [
    "from",
    "innerJoin",
    "leftJoin",
    "where",
    "groupBy",
    "orderBy",
    "limit",
  ]) {
    chain[m] = (...args: unknown[]) => {
      if (m === "from") state.table = args[0];
      if (m === "where") captured.wheres.push(args[0]);
      return chain;
    };
  }
  (chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
    resolve(captured.resultsByTable.get(state.table) ?? []);
  return chain;
}

vi.mock("@/db", () => ({
  db: { select: () => makeChain(), selectDistinct: () => makeChain() },
}));

import * as schema from "@/db/schema";

import {
  getDashboardMetrics,
  getFeedbackDistribution,
  getKnowledgeStats,
  getTraceStats,
} from "./dashboard";

const WS = "ws-1";

function collectVals(cond: unknown, acc: unknown[] = []): unknown[] {
  if (cond && typeof cond === "object") {
    const c = cond as { op?: string; val?: unknown; conds?: unknown[] };
    if (c.op === "eq") acc.push(c.val);
    if (c.op === "and" && Array.isArray(c.conds)) {
      for (const sub of c.conds) collectVals(sub, acc);
    }
  }
  return acc;
}

beforeEach(() => {
  captured.wheres = [];
  captured.resultsByTable = new Map();
  captured.resultsByTable.set(schema.documents, [{ value: 5 }]);
  captured.resultsByTable.set(schema.documentChunks, [{ value: 42 }]);
  captured.resultsByTable.set(schema.ragTraces, [
    { answerCount: 3, avgLatency: "120.6", totalTokens: 1500, totalCost: 0.25 },
  ]);
  captured.resultsByTable.set(schema.messages, [{ value: 8 }]);
  captured.resultsByTable.set(schema.answerFeedback, [
    { rating: "HELPFUL", count: 4 },
    { rating: "NOT_HELPFUL", count: 1 },
  ]);
  captured.resultsByTable.set(schema.evaluationRuns, [
    {
      id: "run-1",
      datasetId: "ds-1",
      status: "COMPLETED",
      summaryMetrics: { retrievalHitRate: 0.8 },
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
  ]);
});

describe("getDashboardMetrics", () => {
  it("maps every aggregate correctly", async () => {
    const m = await getDashboardMetrics(WS);
    expect(m.documentCount).toBe(5);
    expect(m.chunkCount).toBe(42);
    expect(m.answerCount).toBe(3);
    expect(m.avgLatencyMs).toBe(121);
    expect(m.totalTokens).toBe(1500);
    expect(m.totalCost).toBe(0.25);
    expect(m.conversationMessageCount).toBe(8);
    expect(m.feedback).toEqual({ helpful: 4, notHelpful: 1, total: 5 });
    expect(m.recentRuns).toHaveLength(1);
    expect(m.recentRuns[0].id).toBe("run-1");
  });

  it("scopes every aggregate query to the workspace (tenant isolation)", async () => {
    await getDashboardMetrics(WS);
    // 6 queries: documents, chunks, traces, messages, feedback, runs.
    expect(captured.wheres.length).toBeGreaterThanOrEqual(6);
    for (const where of captured.wheres) {
      expect(collectVals(where)).toContain(WS);
    }
  });

  it("does not scope any query to another workspace", async () => {
    await getDashboardMetrics(WS);
    for (const where of captured.wheres) {
      expect(collectVals(where)).not.toContain("ws-2");
    }
  });
});

describe("getTraceStats", () => {
  it("returns null avg latency when there are no traces", async () => {
    captured.resultsByTable.set(schema.ragTraces, [
      { answerCount: 0, avgLatency: null, totalTokens: 0, totalCost: 0 },
    ]);
    const stats = await getTraceStats(WS);
    expect(stats.avgLatencyMs).toBeNull();
    expect(stats.answerCount).toBe(0);
  });
});

describe("getKnowledgeStats", () => {
  it("scopes both counts to the workspace via the knowledge_bases join", async () => {
    await getKnowledgeStats(WS);
    expect(captured.wheres).toHaveLength(2);
    for (const where of captured.wheres) {
      expect(collectVals(where)).toContain(WS);
    }
  });
});

describe("getFeedbackDistribution", () => {
  it("buckets ratings into helpful / not helpful", async () => {
    const dist = await getFeedbackDistribution(WS);
    expect(dist).toEqual({ helpful: 4, notHelpful: 1, total: 5 });
  });
});
