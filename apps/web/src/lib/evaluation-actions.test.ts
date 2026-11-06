import { beforeEach, describe, expect, it, vi } from "vitest";

// Real-shaped AuthzError so the action's `instanceof AuthzError` branch works,
// while the guard itself is mocked to simulate membership/role outcomes.
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

const createEvaluationDatasetMock = vi.fn();
const deleteEvaluationDatasetMock = vi.fn();
const createEvaluationCaseMock = vi.fn();
const deleteEvaluationCaseMock = vi.fn();
const createEvaluationRunMock = vi.fn();
vi.mock("./evaluation", () => ({
  createEvaluationDataset: (...args: unknown[]) =>
    createEvaluationDatasetMock(...args),
  deleteEvaluationDataset: (...args: unknown[]) =>
    deleteEvaluationDatasetMock(...args),
  createEvaluationCase: (...args: unknown[]) => createEvaluationCaseMock(...args),
  deleteEvaluationCase: (...args: unknown[]) => deleteEvaluationCaseMock(...args),
  createEvaluationRun: (...args: unknown[]) => createEvaluationRunMock(...args),
}));

const recordAuditMock = vi.fn();
vi.mock("./audit", () => ({
  AUDIT_ACTIONS: { EVALUATION_RUN_TRIGGER: "evaluation-run.trigger" },
  recordAudit: (...args: unknown[]) => recordAuditMock(...args),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

class RedirectSignal extends Error {}
const redirectMock = vi.fn((path: string) => {
  throw new RedirectSignal(path);
});
vi.mock("next/navigation", () => ({
  redirect: (path: string) => redirectMock(path),
}));

import {
  createEvaluationCaseAction,
  createEvaluationDatasetAction,
  deleteEvaluationCaseAction,
  deleteEvaluationDatasetAction,
  triggerEvaluationRunAction,
} from "./evaluation-actions";

const SLUG = "acme";
const WORKSPACE_ID = "ws-1";
const DATASET_ID = "ds-1";
const CASE_ID = "case-1";
const RUN_ID = "run-1";

function formDataOf(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) {
    fd.append(k, v);
  }
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireWorkspaceMemberBySlugMock.mockResolvedValue({
    workspaceId: WORKSPACE_ID,
    user: { id: "user-1" },
    role: "ADMIN",
  });
  createEvaluationDatasetMock.mockResolvedValue({ id: DATASET_ID });
  deleteEvaluationDatasetMock.mockResolvedValue(true);
  createEvaluationCaseMock.mockResolvedValue({ id: CASE_ID });
  deleteEvaluationCaseMock.mockResolvedValue(true);
  createEvaluationRunMock.mockResolvedValue({ id: RUN_ID });
});

describe("createEvaluationDatasetAction", () => {
  it("requires ADMIN and creates within the resolved workspace", async () => {
    await expect(
      createEvaluationDatasetAction(
        SLUG,
        {},
        formDataOf({ name: "FAQ set", knowledgeBaseId: "kb-1" }),
      ),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(requireWorkspaceMemberBySlugMock).toHaveBeenCalledWith(SLUG, "ADMIN");
    expect(createEvaluationDatasetMock).toHaveBeenCalledWith(WORKSPACE_ID, {
      name: "FAQ set",
      description: null,
      knowledgeBaseId: "kb-1",
    });
    expect(redirectMock).toHaveBeenCalledWith(
      `/${SLUG}/evaluations/${DATASET_ID}`,
    );
  });

  it("validates the name before touching the guard", async () => {
    const result = await createEvaluationDatasetAction(
      SLUG,
      {},
      formDataOf({ name: "  " }),
    );
    expect(result.errorCode).toBe("DATASET_NAME_REQUIRED");
    expect(requireWorkspaceMemberBySlugMock).not.toHaveBeenCalled();
  });

  it("rejects a caller below ADMIN without creating", async () => {
    requireWorkspaceMemberBySlugMock.mockRejectedValue(
      new AuthzError(403, "Requires ADMIN role or higher in this workspace"),
    );
    const result = await createEvaluationDatasetAction(
      SLUG,
      {},
      formDataOf({ name: "FAQ" }),
    );
    expect(result.errorCode).toBe("AUTHORIZATION_FAILED");
    expect(createEvaluationDatasetMock).not.toHaveBeenCalled();
  });

  it("rejects a non-member (cross-workspace) without creating", async () => {
    requireWorkspaceMemberBySlugMock.mockRejectedValue(
      new AuthzError(403, "Not a member of this workspace"),
    );
    const result = await createEvaluationDatasetAction(
      SLUG,
      {},
      formDataOf({ name: "FAQ" }),
    );
    expect(result.errorCode).toBe("AUTHORIZATION_FAILED");
    expect(createEvaluationDatasetMock).not.toHaveBeenCalled();
  });
});

describe("deleteEvaluationDatasetAction", () => {
  it("requires ADMIN and deletes within the resolved workspace", async () => {
    await expect(
      deleteEvaluationDatasetAction(SLUG, DATASET_ID, {}, new FormData()),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(requireWorkspaceMemberBySlugMock).toHaveBeenCalledWith(SLUG, "ADMIN");
    expect(deleteEvaluationDatasetMock).toHaveBeenCalledWith(
      WORKSPACE_ID,
      DATASET_ID,
    );
    expect(redirectMock).toHaveBeenCalledWith(`/${SLUG}/evaluations`);
  });

  it("returns an error when the dataset is absent in this workspace", async () => {
    deleteEvaluationDatasetMock.mockResolvedValue(false);
    const result = await deleteEvaluationDatasetAction(
      SLUG,
      DATASET_ID,
      {},
      new FormData(),
    );
    expect(result.errorCode).toBe("DATASET_NOT_FOUND");
    expect(redirectMock).not.toHaveBeenCalled();
  });
});

describe("createEvaluationCaseAction", () => {
  it("creates a case scoped to the resolved workspace + dataset", async () => {
    const result = await createEvaluationCaseAction(
      SLUG,
      DATASET_ID,
      {},
      formDataOf({
        question: "How do I reset my password?",
        expectedSourceDocuments: "doc-1\ndoc-2",
        tags: "auth, security",
      }),
    );

    expect(requireWorkspaceMemberBySlugMock).toHaveBeenCalledWith(SLUG, "ADMIN");
    expect(createEvaluationCaseMock).toHaveBeenCalledWith(
      WORKSPACE_ID,
      DATASET_ID,
      expect.objectContaining({
        question: "How do I reset my password?",
        expectedSourceDocuments: ["doc-1", "doc-2"],
        tags: ["auth", "security"],
      }),
    );
    expect(result.errorCode).toBeUndefined();
  });

  it("validates the question before touching the guard", async () => {
    const result = await createEvaluationCaseAction(
      SLUG,
      DATASET_ID,
      {},
      formDataOf({ question: "  " }),
    );
    expect(result.errorCode).toBe("EVALUATION_CASE_QUESTION_REQUIRED");
    expect(requireWorkspaceMemberBySlugMock).not.toHaveBeenCalled();
  });

  it("rejects when the dataset is absent in this workspace", async () => {
    createEvaluationCaseMock.mockResolvedValue(null);
    const result = await createEvaluationCaseAction(
      SLUG,
      DATASET_ID,
      {},
      formDataOf({ question: "Q?" }),
    );
    expect(result.errorCode).toBe("DATASET_NOT_FOUND");
  });

  it("rejects a non-member without writing", async () => {
    requireWorkspaceMemberBySlugMock.mockRejectedValue(
      new AuthzError(403, "Not a member of this workspace"),
    );
    const result = await createEvaluationCaseAction(
      SLUG,
      DATASET_ID,
      {},
      formDataOf({ question: "Q?" }),
    );
    expect(result.errorCode).toBe("AUTHORIZATION_FAILED");
    expect(createEvaluationCaseMock).not.toHaveBeenCalled();
  });
});

describe("deleteEvaluationCaseAction", () => {
  it("deletes a case scoped to the resolved workspace + dataset", async () => {
    const result = await deleteEvaluationCaseAction(
      SLUG,
      DATASET_ID,
      CASE_ID,
      {},
      new FormData(),
    );
    expect(requireWorkspaceMemberBySlugMock).toHaveBeenCalledWith(SLUG, "ADMIN");
    expect(deleteEvaluationCaseMock).toHaveBeenCalledWith(
      WORKSPACE_ID,
      DATASET_ID,
      CASE_ID,
    );
    expect(result.errorCode).toBeUndefined();
  });

  it("returns an error when the case is absent", async () => {
    deleteEvaluationCaseMock.mockResolvedValue(false);
    const result = await deleteEvaluationCaseAction(
      SLUG,
      DATASET_ID,
      CASE_ID,
      {},
      new FormData(),
    );
    expect(result.errorCode).toBe("EVALUATION_CASE_NOT_FOUND");
  });
});

describe("triggerEvaluationRunAction", () => {
  it("requires ADMIN and enqueues a run with the parsed config", async () => {
    await expect(
      triggerEvaluationRunAction(
        SLUG,
        DATASET_ID,
        {},
        formDataOf({
          topK: "8",
          chunkSize: "500",
          promptVersion: "v2",
          retrievalMode: "hybrid",
          queryRewrite: "true",
        }),
      ),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(requireWorkspaceMemberBySlugMock).toHaveBeenCalledWith(SLUG, "ADMIN");
    expect(createEvaluationRunMock).toHaveBeenCalledWith(WORKSPACE_ID, DATASET_ID, {
      topK: 8,
      chunkSize: 500,
      promptVersion: "v2",
      retrievalMode: "hybrid",
      queryRewrite: true,
    });
    expect(redirectMock).toHaveBeenCalledWith(
      `/${SLUG}/evaluations/${DATASET_ID}/runs/${RUN_ID}`,
    );
  });

  it("rejects a caller below ADMIN without enqueuing", async () => {
    requireWorkspaceMemberBySlugMock.mockRejectedValue(
      new AuthzError(403, "Requires ADMIN role or higher in this workspace"),
    );
    const result = await triggerEvaluationRunAction(
      SLUG,
      DATASET_ID,
      {},
      new FormData(),
    );
    expect(result.errorCode).toBe("AUTHORIZATION_FAILED");
    expect(createEvaluationRunMock).not.toHaveBeenCalled();
  });

  it("returns an error when the dataset is absent in this workspace", async () => {
    createEvaluationRunMock.mockResolvedValue(null);
    const result = await triggerEvaluationRunAction(
      SLUG,
      DATASET_ID,
      {},
      new FormData(),
    );
    expect(result.errorCode).toBe("DATASET_NOT_FOUND");
    expect(redirectMock).not.toHaveBeenCalled();
  });
});
