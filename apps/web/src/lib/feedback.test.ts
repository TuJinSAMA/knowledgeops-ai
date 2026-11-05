import { beforeEach, describe, expect, it, vi } from "vitest";

const captured: {
  selectedFields: Record<string, unknown> | null;
  leftJoins: unknown[];
  rows: unknown[];
} = {
  selectedFields: null,
  leftJoins: [],
  rows: [],
};

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  and: (...conds: unknown[]) => ({ op: "and", conds }),
  desc: (col: unknown) => ({ op: "desc", col }),
  sql: (strings: TemplateStringsArray, ...vals: unknown[]) => ({
    op: "sql",
    strings: Array.from(strings),
    vals,
    mapWith: () => ({}),
  }),
}));

vi.mock("@/db/schema", () => {
  const table = (name: string) =>
    new Proxy(
      { __table: name },
      {
        get: (target, prop) =>
          prop in target
            ? (target as Record<PropertyKey, unknown>)[prop]
            : `${name}.${String(prop)}`,
      },
    );
  return {
    answerFeedback: table("answerFeedback"),
    conversations: table("conversations"),
    knowledgeBases: table("knowledgeBases"),
    messages: table("messages"),
    ragTraces: table("ragTraces"),
  };
});

function makeChain() {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "innerJoin", "leftJoin", "where", "orderBy", "limit", "groupBy"]) {
    chain[m] = (...args: unknown[]) => {
      if (m === "leftJoin") captured.leftJoins.push(args[0]);
      return chain;
    };
  }
  (chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
    resolve(captured.rows);
  return chain;
}

vi.mock("@/db", () => ({
  db: {
    select: (fields: Record<string, unknown>) => {
      captured.selectedFields = fields;
      return makeChain();
    },
  },
}));

import * as schema from "@/db/schema";
import { getFeedback, listFeedback } from "./feedback";

beforeEach(() => {
  captured.selectedFields = null;
  captured.leftJoins = [];
  captured.rows = [];
});

describe("listFeedback and getFeedback turn question resolution", () => {
  it("left-joins ragTraces and selects turn-level question in listFeedback", async () => {
    captured.rows = [
      {
        id: "fb-1",
        rating: "NOT_HELPFUL",
        reportType: "MISSING_KNOWLEDGE",
        reviewStatus: "NEW",
        failureReason: null,
        comment: "missing policy",
        knowledgeBaseId: "kb-1",
        knowledgeBaseName: "SaaS KB",
        question: "年假有多少天？",
        conversationTitle: "云席是做什么的？",
        traceId: "trace-5",
        createdAt: new Date("2026-11-05T00:00:00Z"),
      },
    ];

    const list = await listFeedback("ws-1");
    expect(captured.leftJoins).toContain(schema.ragTraces);
    expect(captured.selectedFields).toHaveProperty("question");
    expect(list[0].question).toBe("年假有多少天？");
  });

  it("left-joins ragTraces and selects turn-level question in getFeedback", async () => {
    captured.rows = [
      {
        id: "fb-1",
        rating: "NOT_HELPFUL",
        reportType: "MISSING_KNOWLEDGE",
        comment: "missing policy",
        reviewStatus: "NEW",
        failureReason: null,
        traceId: "trace-5",
        messageId: "msg-5",
        answer: "I don't have enough information.",
        knowledgeBaseId: "kb-1",
        knowledgeBaseName: "SaaS KB",
        question: "年假有多少天？",
        conversationTitle: "云席是做什么的？",
        createdAt: new Date("2026-11-05T00:00:00Z"),
        updatedAt: new Date("2026-11-05T00:00:00Z"),
      },
    ];

    const detail = await getFeedback("ws-1", "fb-1");
    expect(captured.leftJoins).toContain(schema.ragTraces);
    expect(captured.selectedFields).toHaveProperty("question");
    expect(detail?.question).toBe("年假有多少天？");
  });
});
