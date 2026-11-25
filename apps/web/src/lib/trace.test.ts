import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  gte: (col: unknown, val: unknown) => ({ op: "gte", col, val }),
  ilike: (col: unknown, val: unknown) => ({ op: "ilike", col, val }),
  isNull: (col: unknown) => ({ op: "isNull", col }),
  isNotNull: (col: unknown) => ({ op: "isNotNull", col }),
  and: (...conds: unknown[]) => ({ op: "and", conds }),
  or: (...conds: unknown[]) => ({ op: "or", conds }),
  desc: (col: unknown) => ({ op: "desc", col }),
  sql: () => ({ mapWith: () => ({}) }),
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
    ragTraces: table("ragTraces"),
    conversations: table("conversations"),
    knowledgeBases: table("knowledgeBases"),
  };
});

vi.mock("./conversation", () => ({
  getDocumentTitles: vi.fn(async () => new Map()),
}));

const captured: {
  inserted?: Record<string, unknown>;
  wheres: unknown[];
  rowsQueue: unknown[][];
} = {
  wheres: [],
  rowsQueue: [],
};

function makeSelectChain() {
  const chain: Record<string, unknown> = {};
  for (const m of [
    "from",
    "leftJoin",
    "where",
    "orderBy",
    "limit",
    "offset",
  ]) {
    chain[m] = (...args: unknown[]) => {
      if (m === "where") captured.wheres.push(args[0]);
      return chain;
    };
  }
  (chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
    resolve(captured.rowsQueue.shift() ?? []);
  return chain;
}

vi.mock("@/db", () => ({
  db: {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        captured.inserted = v;
        return {
          returning: async () => [{ id: "trace-1" }],
        };
      },
    }),
    select: () => makeSelectChain(),
  },
}));

import { createTrace, listTracesFiltered } from "./trace";

function flattenTree(node: unknown, out: unknown[] = []): unknown[] {
  if (node && typeof node === "object") {
    out.push(node);
    const rec = node as { conds?: unknown[] };
    if (Array.isArray(rec.conds)) {
      for (const c of rec.conds) flattenTree(c, out);
    }
  }
  return out;
}

beforeEach(() => {
  captured.inserted = undefined;
  captured.wheres = [];
  captured.rowsQueue = [];
});

describe("createTrace", () => {
  it("persists refused=true when specified and defaults to false", async () => {
    await createTrace({
      workspaceId: "ws-1",
      conversationId: "conv-1",
      query: "Unknown question?",
      refused: true,
    });
    expect(captured.inserted).toMatchObject({
      workspaceId: "ws-1",
      refused: true,
    });

    await createTrace({
      workspaceId: "ws-1",
      conversationId: "conv-1",
      query: "Known question?",
    });
    expect(captured.inserted).toMatchObject({
      refused: false,
    });
  });
});

describe("listTracesFiltered", () => {
  it("applies workspace isolation, KB, REFUSED status, minLatencyMs, and query filters", async () => {
    captured.rowsQueue = [
      [{ value: 1 }],
      [
        {
          id: "t-1",
          query: "年假有几天？",
          rewrittenQuery: null,
          knowledgeBaseId: "kb-1",
          knowledgeBaseName: "SaaS 客服",
          model: "deepseek-chat",
          refused: true,
          costEstimate: "0.000100",
          latencyMs: 3200,
          error: null,
          createdAt: new Date("2026-11-25T10:00:00Z"),
        },
      ],
    ];

    const res = await listTracesFiltered("ws-1", {
      knowledgeBaseId: "kb-1",
      status: "REFUSED",
      minLatencyMs: 3000,
      query: "年假",
    });

    expect(res.total).toBe(1);
    expect(res.items[0]).toMatchObject({
      id: "t-1",
      refused: true,
      knowledgeBaseName: "SaaS 客服",
    });

    const nodes = flattenTree(captured.wheres[0]);
    expect(nodes).toEqual(
      expect.arrayContaining([
        { op: "eq", col: "ragTraces.workspaceId", val: "ws-1" },
        { op: "eq", col: "conversations.knowledgeBaseId", val: "kb-1" },
        { op: "isNull", col: "ragTraces.error" },
        { op: "eq", col: "ragTraces.refused", val: true },
        { op: "gte", col: "ragTraces.latencyMs", val: 3000 },
      ]),
    );
  });
});
