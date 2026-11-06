import { beforeEach, describe, expect, it, vi } from "vitest";

// Inspectable drizzle condition builders so we can assert tenant scoping on the
// query without a real database.
vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  and: (...conds: unknown[]) => ({ op: "and", conds }),
  desc: (col: unknown) => ({ op: "desc", col }),
}));

// Column tokens so eq(auditLogs.workspaceId, ws) yields a recognizable object.
vi.mock("@/db/schema", () => ({
  auditLogs: {
    id: "auditLogs.id",
    workspaceId: "auditLogs.workspaceId",
    action: "auditLogs.action",
    targetType: "auditLogs.targetType",
    targetId: "auditLogs.targetId",
    metadata: "auditLogs.metadata",
    actorId: "auditLogs.actorId",
    createdAt: "auditLogs.createdAt",
  },
  user: { id: "user.id", name: "user.name", email: "user.email" },
}));

// Recording db mock: captures insert values and every .where() condition, and
// resolves awaited query chains from a per-table result map.
type Captured = {
  insertValues?: Record<string, unknown>;
  wheres: unknown[];
  failInsert?: boolean;
  resultsByTable: Map<unknown, unknown[]>;
};

const captured: Captured = {
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
  db: {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        captured.insertValues = v;
        if (captured.failInsert) {
          return Promise.reject(new Error("insert boom"));
        }
        return Promise.resolve([{ id: "audit-1" }]);
      },
    }),
    select: () => makeChain(),
    selectDistinct: () => makeChain(),
  },
}));

import {
  AUDIT_ACTIONS,
  listAuditActions,
  listAuditLogs,
  recordAudit,
} from "./audit";

const WS = "ws-1";

// Recursively collect all eq `val`s under a (possibly nested) condition tree.
function collectVals(cond: unknown, acc: unknown[] = []): unknown[] {
  if (cond && typeof cond === "object") {
    const c = cond as { op?: string; val?: unknown; conds?: unknown[] };
    if (c.op === "eq") {
      acc.push(c.val);
    }
    if (c.op === "and" && Array.isArray(c.conds)) {
      for (const sub of c.conds) collectVals(sub, acc);
    }
  }
  return acc;
}

beforeEach(() => {
  captured.insertValues = undefined;
  captured.wheres = [];
  captured.failInsert = false;
  captured.resultsByTable = new Map();
});

describe("recordAudit", () => {
  it("defines FEEDBACK_PROMOTE_CASE action constant", () => {
    expect(AUDIT_ACTIONS.FEEDBACK_PROMOTE_CASE).toBe("feedback.promote-case");
  });

  it("inserts a workspace-scoped entry with actor/action/target/metadata", async () => {
    await recordAudit({
      workspaceId: WS,
      actorId: "user-9",
      action: AUDIT_ACTIONS.KNOWLEDGE_BASE_CREATE,
      target: { type: "knowledge_base", id: "kb-7" },
      metadata: { name: "FAQ" },
    });

    expect(captured.insertValues).toMatchObject({
      workspaceId: WS,
      actorId: "user-9",
      action: "knowledge-base.create",
      targetType: "knowledge_base",
      targetId: "kb-7",
      metadata: { name: "FAQ" },
    });
  });

  it("defaults optional fields to null", async () => {
    await recordAudit({
      workspaceId: WS,
      actorId: null,
      action: "x.y",
    });
    expect(captured.insertValues).toMatchObject({
      workspaceId: WS,
      actorId: null,
      targetType: null,
      targetId: null,
      metadata: null,
    });
  });

  it("never throws when the insert fails (best-effort)", async () => {
    captured.failInsert = true;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      recordAudit({ workspaceId: WS, actorId: null, action: "x.y" }),
    ).resolves.toBeUndefined();
    spy.mockRestore();
  });
});

describe("listAuditLogs", () => {
  it("scopes the query to the workspace", async () => {
    captured.resultsByTable.set("auditLogs.id" /* unused */, []);
    await listAuditLogs(WS);
    expect(captured.wheres).toHaveLength(1);
    expect(collectVals(captured.wheres[0])).toContain(WS);
  });

  it("adds an action filter alongside the workspace scope", async () => {
    await listAuditLogs(WS, { action: "document.upload" });
    const vals = collectVals(captured.wheres[0]);
    expect(vals).toContain(WS);
    expect(vals).toContain("document.upload");
  });

  it("does not leak another workspace's id into the filter", async () => {
    await listAuditLogs(WS);
    expect(collectVals(captured.wheres[0])).not.toContain("ws-2");
  });
});

describe("listAuditActions", () => {
  it("scopes the distinct-actions query to the workspace", async () => {
    await listAuditActions(WS);
    expect(captured.wheres).toHaveLength(1);
    expect(collectVals(captured.wheres[0])).toContain(WS);
  });
});
