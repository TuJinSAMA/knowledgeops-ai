import { beforeEach, describe, expect, it, vi } from "vitest";

// Real AuthzError so the action's `instanceof AuthzError` branch works, while
// the guard itself is mocked to simulate membership/role outcomes. Defined via
// vi.hoisted so it exists before the hoisted vi.mock factory runs.
const { AuthzError } = vi.hoisted(() => {
  class AuthzError extends Error {
    readonly status: 401 | 403;
    constructor(status: 401 | 403, message: string) {
      super(message);
      this.name = "AuthzError";
      this.status = status;
    }
  }
  return { AuthzError };
});

const requireWorkspaceMemberBySlugMock = vi.fn();
vi.mock("./authz", () => ({
  AuthzError,
  requireWorkspaceMemberBySlug: (...args: unknown[]) =>
    requireWorkspaceMemberBySlugMock(...args),
}));

const createKnowledgeBaseMock = vi.fn();
const deleteKnowledgeBaseMock = vi.fn();
vi.mock("./knowledge-base", () => ({
  createKnowledgeBase: (...args: unknown[]) => createKnowledgeBaseMock(...args),
  deleteKnowledgeBase: (...args: unknown[]) => deleteKnowledgeBaseMock(...args),
}));

const recordAuditMock = vi.fn();
vi.mock("./audit", () => ({
  AUDIT_ACTIONS: {
    KNOWLEDGE_BASE_CREATE: "knowledge-base.create",
    KNOWLEDGE_BASE_DELETE: "knowledge-base.delete",
  },
  recordAudit: (...args: unknown[]) => recordAuditMock(...args),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// redirect throws a sentinel (mirrors Next's control-flow throw) so we can
// assert navigation happened without leaving the function normally.
class RedirectSignal extends Error {}
const redirectMock = vi.fn((path: string) => {
  throw new RedirectSignal(path);
});
vi.mock("next/navigation", () => ({
  redirect: (path: string) => redirectMock(path),
}));

import {
  createKnowledgeBaseAction,
  deleteKnowledgeBaseAction,
} from "./knowledge-base-actions";

const SLUG = "acme";
const KB_ID = "kb-1";
const WORKSPACE_ID = "ws-1";

function formDataOf(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) {
    fd.append(k, v);
  }
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createKnowledgeBaseAction", () => {
  it("requires ADMIN and creates within the resolved workspace (same-workspace member)", async () => {
    requireWorkspaceMemberBySlugMock.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      user: { id: "user-1" },
      role: "ADMIN",
    });
    createKnowledgeBaseMock.mockResolvedValue({ id: KB_ID, name: "Docs" });

    await expect(
      createKnowledgeBaseAction(SLUG, {}, formDataOf({ name: "Docs" })),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(requireWorkspaceMemberBySlugMock).toHaveBeenCalledWith(SLUG, "ADMIN");
    // Tenant isolation: creation is scoped to the guard-resolved workspace id.
    expect(createKnowledgeBaseMock).toHaveBeenCalledWith(
      WORKSPACE_ID,
      "Docs",
      null,
    );
    // Audit entry is recorded for the resolved workspace + actor.
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        actorId: "user-1",
        action: "knowledge-base.create",
      }),
    );
    expect(redirectMock).toHaveBeenCalledWith(
      `/${SLUG}/knowledge-bases/${KB_ID}`,
    );
  });

  it("rejects a caller whose role is below ADMIN without creating", async () => {
    requireWorkspaceMemberBySlugMock.mockRejectedValue(
      new AuthzError(403, "Requires ADMIN role or higher in this workspace"),
    );

    const result = await createKnowledgeBaseAction(
      SLUG,
      {},
      formDataOf({ name: "Docs" }),
    );

    expect(result.errorCode).toBe("AUTHORIZATION_FAILED");
    expect(createKnowledgeBaseMock).not.toHaveBeenCalled();
  });

  it("rejects a non-member (cross-workspace) without creating", async () => {
    requireWorkspaceMemberBySlugMock.mockRejectedValue(
      new AuthzError(403, "Not a member of this workspace"),
    );

    const result = await createKnowledgeBaseAction(
      SLUG,
      {},
      formDataOf({ name: "Docs" }),
    );

    expect(result.errorCode).toBe("AUTHORIZATION_FAILED");
    expect(createKnowledgeBaseMock).not.toHaveBeenCalled();
  });

  it("validates the name before touching the guard", async () => {
    const result = await createKnowledgeBaseAction(SLUG, {}, formDataOf({ name: "  " }));
    expect(result.errorCode).toBe("KNOWLEDGE_BASE_NAME_REQUIRED");
    expect(requireWorkspaceMemberBySlugMock).not.toHaveBeenCalled();
  });
});

describe("deleteKnowledgeBaseAction", () => {
  it("requires ADMIN and deletes within the resolved workspace", async () => {
    requireWorkspaceMemberBySlugMock.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      user: { id: "user-1" },
      role: "OWNER",
    });
    deleteKnowledgeBaseMock.mockResolvedValue(true);

    await expect(
      deleteKnowledgeBaseAction(SLUG, KB_ID, {}, new FormData()),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(requireWorkspaceMemberBySlugMock).toHaveBeenCalledWith(SLUG, "ADMIN");
    expect(deleteKnowledgeBaseMock).toHaveBeenCalledWith(WORKSPACE_ID, KB_ID);
    expect(redirectMock).toHaveBeenCalledWith(`/${SLUG}/knowledge-bases`);
  });

  it("rejects insufficient role without deleting", async () => {
    requireWorkspaceMemberBySlugMock.mockRejectedValue(
      new AuthzError(403, "Requires ADMIN role or higher in this workspace"),
    );

    const result = await deleteKnowledgeBaseAction(SLUG, KB_ID, {}, new FormData());

    expect(result.errorCode).toBe("AUTHORIZATION_FAILED");
    expect(deleteKnowledgeBaseMock).not.toHaveBeenCalled();
  });

  it("returns an error when the knowledge base is absent in this workspace", async () => {
    requireWorkspaceMemberBySlugMock.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      user: { id: "user-1" },
      role: "ADMIN",
    });
    deleteKnowledgeBaseMock.mockResolvedValue(false);

    const result = await deleteKnowledgeBaseAction(SLUG, KB_ID, {}, new FormData());

    expect(result.errorCode).toBe("KNOWLEDGE_BASE_NOT_FOUND");
    expect(redirectMock).not.toHaveBeenCalled();
  });
});
