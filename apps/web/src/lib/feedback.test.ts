import { beforeEach, describe, expect, it, vi } from "vitest";

const captured: {
  selectedFields: Record<string, unknown> | null;
  leftJoins: unknown[];
  rows: unknown[];
  txSelectQueue: unknown[][];
  txInserts: Array<{ table: unknown; values: unknown }>;
  txUpdates: Array<{ table: unknown; values: unknown }>;
} = {
  selectedFields: null,
  leftJoins: [],
  rows: [],
  txSelectQueue: [],
  txInserts: [],
  txUpdates: [],
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
    evaluationCases: table("evaluationCases"),
    evaluationDatasets: table("evaluationDatasets"),
    knowledgeBases: table("knowledgeBases"),
    messages: table("messages"),
    ragTraces: table("ragTraces"),
  };
});

function makeChain(resultProvider: () => unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of [
    "from",
    "innerJoin",
    "leftJoin",
    "where",
    "orderBy",
    "limit",
    "groupBy",
  ]) {
    chain[m] = (...args: unknown[]) => {
      if (m === "leftJoin") captured.leftJoins.push(args[0]);
      return chain;
    };
  }
  (chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
    resolve(resultProvider());
  return chain;
}

const txMock = {
  select: () => makeChain(() => captured.txSelectQueue.shift() ?? []),
  insert: (table: unknown) => ({
    values: (values: unknown) => {
      captured.txInserts.push({ table, values });
      return {
        returning: () =>
          Promise.resolve([
            {
              id:
                (table as { __table?: string })?.__table === "evaluationDatasets"
                  ? "ds-new"
                  : "case-new",
              name:
                (values as { name?: string })?.name ?? "Inline Dataset",
            },
          ]),
      };
    },
  }),
  update: (table: unknown) => ({
    set: (values: unknown) => {
      captured.txUpdates.push({ table, values });
      return {
        where: () => ({
          returning: () => Promise.resolve([{ id: "fb-1" }]),
          then: (resolve: (v: unknown) => void) => resolve([{ id: "fb-1" }]),
        }),
      };
    },
  }),
};

vi.mock("@/db", () => ({
  db: {
    select: (fields: Record<string, unknown>) => {
      captured.selectedFields = fields;
      return makeChain(() => captured.rows);
    },
    transaction: async <T>(fn: (tx: typeof txMock) => Promise<T>): Promise<T> =>
      fn(txMock),
  },
}));

import * as schema from "@/db/schema";
import {
  getFeedback,
  listFeedback,
  promoteFeedbackToCase,
} from "./feedback";

beforeEach(() => {
  captured.selectedFields = null;
  captured.leftJoins = [];
  captured.rows = [];
  captured.txSelectQueue = [];
  captured.txInserts = [];
  captured.txUpdates = [];
});

describe("listFeedback and getFeedback turn question and promotion provenance", () => {
  it("left-joins ragTraces and selects turn-level question and promotedCaseId in listFeedback", async () => {
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
        promotedCaseId: "case-1",
        createdAt: new Date("2026-11-05T00:00:00Z"),
      },
    ];

    const list = await listFeedback("ws-1");
    expect(captured.leftJoins).toContain(schema.ragTraces);
    expect(captured.selectedFields).toHaveProperty("question");
    expect(captured.selectedFields).toHaveProperty("promotedCaseId");
    expect(list[0].question).toBe("年假有多少天？");
    expect(list[0].promotedCaseId).toBe("case-1");
  });

  it("left-joins ragTraces, evaluationCases, evaluationDatasets in getFeedback", async () => {
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
        promotedCaseId: "case-1",
        promotedDatasetId: "ds-1",
        promotedDatasetName: "Regression Set",
        createdAt: new Date("2026-11-05T00:00:00Z"),
        updatedAt: new Date("2026-11-05T00:00:00Z"),
      },
    ];

    const detail = await getFeedback("ws-1", "fb-1");
    expect(captured.leftJoins).toContain(schema.ragTraces);
    expect(captured.leftJoins).toContain(schema.evaluationCases);
    expect(captured.leftJoins).toContain(schema.evaluationDatasets);
    expect(detail?.question).toBe("年假有多少天？");
    expect(detail?.promotedCaseId).toBe("case-1");
    expect(detail?.promotedDatasetId).toBe("ds-1");
    expect(detail?.promotedDatasetName).toBe("Regression Set");
  });
});

describe("promoteFeedbackToCase", () => {
  it("rejects empty question before touching the database", async () => {
    const res = await promoteFeedbackToCase("ws-1", "fb-1", {
      datasetId: "ds-1",
      question: "   ",
    });
    expect(res).toEqual({
      ok: false,
      reason: "EVALUATION_CASE_QUESTION_REQUIRED",
    });
  });

  it("returns FEEDBACK_NOT_FOUND when feedback does not exist in workspace", async () => {
    captured.txSelectQueue.push([]);
    const res = await promoteFeedbackToCase("ws-1", "fb-missing", {
      datasetId: "ds-1",
      question: "How to refund?",
    });
    expect(res).toEqual({ ok: false, reason: "FEEDBACK_NOT_FOUND" });
  });

  it("returns FEEDBACK_ALREADY_PROMOTED when promotedCaseId is already set", async () => {
    captured.txSelectQueue.push([
      {
        id: "fb-1",
        knowledgeBaseId: "kb-1",
        promotedCaseId: "case-existing",
      },
    ]);
    const res = await promoteFeedbackToCase("ws-1", "fb-1", {
      datasetId: "ds-1",
      question: "How to refund?",
    });
    expect(res).toEqual({ ok: false, reason: "FEEDBACK_ALREADY_PROMOTED" });
    expect(captured.txInserts).toHaveLength(0);
  });

  it("returns DATASET_NOT_FOUND when target datasetId belongs to another workspace", async () => {
    captured.txSelectQueue.push([
      { id: "fb-1", knowledgeBaseId: "kb-1", promotedCaseId: null },
    ]);
    captured.txSelectQueue.push([]); // dataset lookup empty
    const res = await promoteFeedbackToCase("ws-1", "fb-1", {
      datasetId: "ds-other-ws",
      question: "How to refund?",
    });
    expect(res).toEqual({ ok: false, reason: "DATASET_NOT_FOUND" });
    expect(captured.txInserts).toHaveLength(0);
  });

  it("returns DATASET_NAME_REQUIRED when creating a new dataset inline with empty name", async () => {
    captured.txSelectQueue.push([
      { id: "fb-1", knowledgeBaseId: "kb-1", promotedCaseId: null },
    ]);
    const res = await promoteFeedbackToCase("ws-1", "fb-1", {
      newDatasetName: "   ",
      question: "How to refund?",
    });
    expect(res).toEqual({ ok: false, reason: "DATASET_NAME_REQUIRED" });
  });

  it("creates an inline dataset bound to feedback KB, inserts case, and updates feedback", async () => {
    captured.txSelectQueue.push([
      { id: "fb-1", knowledgeBaseId: "kb-1", promotedCaseId: null },
    ]);
    const res = await promoteFeedbackToCase("ws-1", "fb-1", {
      newDatasetName: "客服回归集",
      question: "购买后多久可以退款？",
      expectedAnswer: "7 天内全额退款",
      requiredFacts: ["7 天", "全额退款"],
      tags: ["from-feedback", "wrong-answer"],
      markResolved: true,
    });

    expect(res).toEqual({
      ok: true,
      caseId: "case-new",
      datasetId: "ds-new",
      datasetName: "客服回归集",
    });
    expect(captured.txInserts).toHaveLength(2);
    expect(captured.txInserts[0].values).toMatchObject({
      workspaceId: "ws-1",
      knowledgeBaseId: "kb-1",
      name: "客服回归集",
    });
    expect(captured.txInserts[1].values).toMatchObject({
      datasetId: "ds-new",
      question: "购买后多久可以退款？",
      expectedAnswer: "7 天内全额退款",
      requiredFacts: ["7 天", "全额退款"],
      tags: ["from-feedback", "wrong-answer"],
    });
    expect(captured.txUpdates.at(-1)?.values).toMatchObject({
      promotedCaseId: "case-new",
      reviewStatus: "RESOLVED",
    });
  });
});
