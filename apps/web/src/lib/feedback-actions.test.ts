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

const getMessageFeedbackContextMock = vi.fn();
const upsertFeedbackMock = vi.fn();
const updateFeedbackReviewMock = vi.fn();
const promoteFeedbackToCaseMock = vi.fn();
// Keep the real enum constants (used for validation) but mock the DB-backed
// functions so these tests never touch a database.
vi.mock("./feedback", () => ({
  COMMENT_MAX: 2000,
  FEEDBACK_RATINGS: ["HELPFUL", "NOT_HELPFUL"],
  FEEDBACK_REPORT_TYPES: ["WRONG_ANSWER", "MISSING_KNOWLEDGE", "OTHER"],
  FEEDBACK_REVIEW_STATUSES: ["NEW", "PENDING_REVIEW", "RESOLVED"],
  getMessageFeedbackContext: (...args: unknown[]) =>
    getMessageFeedbackContextMock(...args),
  upsertFeedback: (...args: unknown[]) => upsertFeedbackMock(...args),
  updateFeedbackReview: (...args: unknown[]) => updateFeedbackReviewMock(...args),
  promoteFeedbackToCase: (...args: unknown[]) => promoteFeedbackToCaseMock(...args),
}));

const recordAuditMock = vi.fn();
vi.mock("./audit", () => ({
  AUDIT_ACTIONS: { FEEDBACK_PROMOTE_CASE: "feedback.promote-case" },
  recordAudit: (...args: unknown[]) => recordAuditMock(...args),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  promoteFeedbackToCaseAction,
  submitFeedbackAction,
  updateFeedbackReviewAction,
} from "./feedback-actions";

const SLUG = "acme";
const WORKSPACE_ID = "ws-1";
const USER_ID = "user-1";
const MESSAGE_ID = "msg-1";
const FEEDBACK_ID = "fb-1";

function reviewFormData(entries: Record<string, string>): FormData {
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
    user: { id: USER_ID },
    role: "MEMBER",
  });
  getMessageFeedbackContextMock.mockResolvedValue({
    conversationId: "conv-1",
    knowledgeBaseId: "kb-1",
    traceId: "trace-1",
  });
  upsertFeedbackMock.mockResolvedValue({
    id: FEEDBACK_ID,
    rating: "HELPFUL",
    reportType: null,
    comment: null,
    reviewStatus: "NEW",
  });
  updateFeedbackReviewMock.mockResolvedValue(true);
});

describe("submitFeedbackAction", () => {
  it("lets a member submit feedback scoped to the resolved workspace + user", async () => {
    const result = await submitFeedbackAction({
      workspaceSlug: SLUG,
      messageId: MESSAGE_ID,
      rating: "HELPFUL",
    });

    expect(requireWorkspaceMemberBySlugMock).toHaveBeenCalledWith(SLUG, "MEMBER");
    // Tenant isolation: the message is verified to belong to this workspace,
    // and the trace id is resolved server-side (not trusted from the client).
    expect(getMessageFeedbackContextMock).toHaveBeenCalledWith(
      WORKSPACE_ID,
      MESSAGE_ID,
    );
    expect(upsertFeedbackMock).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      messageId: MESSAGE_ID,
      userId: USER_ID,
      rating: "HELPFUL",
      reportType: null,
      comment: null,
      traceId: "trace-1",
    });
    expect(result.feedback?.id).toBe(FEEDBACK_ID);
  });

  it("upserts on a repeat submission for the same message (no duplicate path)", async () => {
    // First submission (helpful), then a detailed not-helpful report. The
    // action always calls upsertFeedback; uniqueness is enforced in the DB.
    await submitFeedbackAction({
      workspaceSlug: SLUG,
      messageId: MESSAGE_ID,
      rating: "HELPFUL",
    });
    await submitFeedbackAction({
      workspaceSlug: SLUG,
      messageId: MESSAGE_ID,
      rating: "NOT_HELPFUL",
      reportType: "WRONG_ANSWER",
      comment: "  it cited the wrong doc  ",
    });

    expect(upsertFeedbackMock).toHaveBeenCalledTimes(2);
    expect(upsertFeedbackMock).toHaveBeenLastCalledWith({
      workspaceId: WORKSPACE_ID,
      messageId: MESSAGE_ID,
      userId: USER_ID,
      rating: "NOT_HELPFUL",
      reportType: "WRONG_ANSWER",
      comment: "it cited the wrong doc",
      traceId: "trace-1",
    });
  });

  it("rejects a non-member (cross-workspace) without writing", async () => {
    requireWorkspaceMemberBySlugMock.mockRejectedValue(
      new AuthzError(403, "Not a member of this workspace"),
    );

    const result = await submitFeedbackAction({
      workspaceSlug: SLUG,
      messageId: MESSAGE_ID,
      rating: "HELPFUL",
    });

    expect(result.errorCode).toBe("AUTHORIZATION_FAILED");
    expect(upsertFeedbackMock).not.toHaveBeenCalled();
  });

  it("rejects feedback on a message from another workspace", async () => {
    // Member of this workspace, but the message resolves to no row in it.
    getMessageFeedbackContextMock.mockResolvedValue(null);

    const result = await submitFeedbackAction({
      workspaceSlug: SLUG,
      messageId: "msg-from-other-ws",
      rating: "HELPFUL",
    });

    expect(result.errorCode).toBe("FEEDBACK_ANSWER_NOT_FOUND");
    expect(upsertFeedbackMock).not.toHaveBeenCalled();
  });

  it("validates the rating before touching the guard", async () => {
    const result = await submitFeedbackAction({
      workspaceSlug: SLUG,
      messageId: MESSAGE_ID,
      rating: "MAYBE" as never,
    });

    expect(result.errorCode).toBe("FEEDBACK_RATING_INVALID");
    expect(requireWorkspaceMemberBySlugMock).not.toHaveBeenCalled();
  });
});

describe("updateFeedbackReviewAction", () => {
  it("requires ADMIN and updates within the resolved workspace", async () => {
    requireWorkspaceMemberBySlugMock.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      user: { id: USER_ID },
      role: "ADMIN",
    });

    const result = await updateFeedbackReviewAction(
      SLUG,
      FEEDBACK_ID,
      {},
      reviewFormData({
        reviewStatus: "RESOLVED",
        failureReason: "retrieval miss",
      }),
    );

    expect(requireWorkspaceMemberBySlugMock).toHaveBeenCalledWith(SLUG, "ADMIN");
    expect(updateFeedbackReviewMock).toHaveBeenCalledWith(
      WORKSPACE_ID,
      FEEDBACK_ID,
      { reviewStatus: "RESOLVED", failureReason: "retrieval miss" },
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a caller whose role is below ADMIN without updating", async () => {
    requireWorkspaceMemberBySlugMock.mockRejectedValue(
      new AuthzError(403, "Requires ADMIN role or higher in this workspace"),
    );

    const result = await updateFeedbackReviewAction(
      SLUG,
      FEEDBACK_ID,
      {},
      reviewFormData({ reviewStatus: "RESOLVED" }),
    );

    expect(result.errorCode).toBe("AUTHORIZATION_FAILED");
    expect(updateFeedbackReviewMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid review status before touching the guard", async () => {
    const result = await updateFeedbackReviewAction(
      SLUG,
      FEEDBACK_ID,
      {},
      reviewFormData({ reviewStatus: "DONE" }),
    );

    expect(result.errorCode).toBe("FEEDBACK_REVIEW_STATUS_INVALID");
    expect(requireWorkspaceMemberBySlugMock).not.toHaveBeenCalled();
  });

  it("returns an error when the feedback is absent in this workspace", async () => {
    requireWorkspaceMemberBySlugMock.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      user: { id: USER_ID },
      role: "ADMIN",
    });
    updateFeedbackReviewMock.mockResolvedValue(false);

    const result = await updateFeedbackReviewAction(
      SLUG,
      FEEDBACK_ID,
      {},
      reviewFormData({ reviewStatus: "RESOLVED" }),
    );

    expect(result.errorCode).toBe("FEEDBACK_NOT_FOUND");
  });
});

describe("promoteFeedbackToCaseAction", () => {
  beforeEach(() => {
    requireWorkspaceMemberBySlugMock.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      user: { id: USER_ID },
      role: "ADMIN",
    });
    promoteFeedbackToCaseMock.mockResolvedValue({
      ok: true,
      caseId: "case-1",
      datasetId: "ds-1",
      datasetName: "Regression Set",
    });
  });

  it("requires ADMIN, promotes feedback to case, and records an audit log entry", async () => {
    const result = await promoteFeedbackToCaseAction(
      SLUG,
      FEEDBACK_ID,
      {},
      reviewFormData({
        datasetId: "ds-1",
        question: "How do I apply for a refund?",
        expectedAnswer: "Email billing@nimbusdesk.example within 7 days",
        requiredFacts: "7 days\nbilling@nimbusdesk.example",
        expectedSourceDocuments: "doc-1",
        tags: "from-feedback, wrong-answer",
        markResolved: "on",
      }),
    );

    expect(requireWorkspaceMemberBySlugMock).toHaveBeenCalledWith(SLUG, "ADMIN");
    expect(promoteFeedbackToCaseMock).toHaveBeenCalledWith(
      WORKSPACE_ID,
      FEEDBACK_ID,
      {
        datasetId: "ds-1",
        newDatasetName: null,
        question: "How do I apply for a refund?",
        expectedAnswer: "Email billing@nimbusdesk.example within 7 days",
        requiredFacts: ["7 days", "billing@nimbusdesk.example"],
        expectedSourceDocuments: ["doc-1"],
        tags: ["from-feedback", "wrong-answer"],
        markResolved: true,
      },
    );
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        actorId: USER_ID,
        action: "feedback.promote-case",
        target: { type: "evaluation_case", id: "case-1" },
      }),
    );
    expect(result).toEqual({
      ok: true,
      caseId: "case-1",
      datasetId: "ds-1",
      datasetName: "Regression Set",
    });
  });

  it("rejects a caller below ADMIN without promoting", async () => {
    requireWorkspaceMemberBySlugMock.mockRejectedValue(
      new AuthzError(403, "Requires ADMIN role or higher"),
    );

    const result = await promoteFeedbackToCaseAction(
      SLUG,
      FEEDBACK_ID,
      {},
      reviewFormData({ datasetId: "ds-1", question: "Q?" }),
    );

    expect(result.errorCode).toBe("AUTHORIZATION_FAILED");
    expect(promoteFeedbackToCaseMock).not.toHaveBeenCalled();
    expect(recordAuditMock).not.toHaveBeenCalled();
  });

  it("maps domain failure reasons to errorCode without recording audit", async () => {
    promoteFeedbackToCaseMock.mockResolvedValue({
      ok: false,
      reason: "FEEDBACK_ALREADY_PROMOTED",
    });

    const result = await promoteFeedbackToCaseAction(
      SLUG,
      FEEDBACK_ID,
      {},
      reviewFormData({ datasetId: "ds-1", question: "Q?" }),
    );

    expect(result.errorCode).toBe("FEEDBACK_ALREADY_PROMOTED");
    expect(recordAuditMock).not.toHaveBeenCalled();
  });
});
