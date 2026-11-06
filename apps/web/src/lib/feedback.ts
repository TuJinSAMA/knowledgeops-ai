import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  answerFeedback,
  conversations,
  evaluationCases,
  evaluationDatasets,
  knowledgeBases,
  messages,
  ragTraces,
} from "@/db/schema";

export type FeedbackRating = (typeof answerFeedback.$inferSelect)["rating"];
export type FeedbackReportType = NonNullable<
  (typeof answerFeedback.$inferSelect)["reportType"]
>;
export type FeedbackReviewStatus =
  (typeof answerFeedback.$inferSelect)["reviewStatus"];

export const FEEDBACK_RATINGS: FeedbackRating[] = ["HELPFUL", "NOT_HELPFUL"];
export const FEEDBACK_REPORT_TYPES: FeedbackReportType[] = [
  "WRONG_ANSWER",
  "MISSING_KNOWLEDGE",
  "OTHER",
];
export const FEEDBACK_REVIEW_STATUSES: FeedbackReviewStatus[] = [
  "NEW",
  "PENDING_REVIEW",
  "RESOLVED",
];

// Cap the stored free-text comment so a single feedback row stays bounded.
export const COMMENT_MAX = 2000;

/**
 * Context for an assistant message resolved within a workspace. Used to enforce
 * tenant isolation on feedback submission (a member of workspace A must not be
 * able to attach feedback to workspace B's message) and to link the feedback to
 * the answer's trace server-side rather than trusting a client-supplied id.
 */
export type MessageFeedbackContext = {
  conversationId: string;
  knowledgeBaseId: string;
  traceId: string | null;
};

/**
 * Resolve an assistant message inside a workspace, returning its conversation,
 * knowledge base and (if any) trace. Returns null when the message does not
 * exist or belongs to another workspace (tenant isolation). The join through
 * `conversations` is what binds a message to a workspace.
 */
export async function getMessageFeedbackContext(
  workspaceId: string,
  messageId: string,
): Promise<MessageFeedbackContext | null> {
  const [row] = await db
    .select({
      conversationId: messages.conversationId,
      knowledgeBaseId: conversations.knowledgeBaseId,
      traceId: ragTraces.id,
    })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .leftJoin(ragTraces, eq(ragTraces.messageId, messages.id))
    .where(
      and(
        eq(messages.id, messageId),
        eq(conversations.workspaceId, workspaceId),
      ),
    )
    .limit(1);

  if (!row) {
    return null;
  }
  return {
    conversationId: row.conversationId,
    knowledgeBaseId: row.knowledgeBaseId,
    traceId: row.traceId ?? null,
  };
}

export type UpsertFeedbackParams = {
  workspaceId: string;
  messageId: string;
  userId: string;
  rating: FeedbackRating;
  reportType?: FeedbackReportType | null;
  comment?: string | null;
  traceId?: string | null;
};

export type FeedbackRecord = {
  id: string;
  rating: FeedbackRating;
  reportType: FeedbackReportType | null;
  comment: string | null;
  reviewStatus: FeedbackReviewStatus;
};

/**
 * Insert or update a user's feedback for an answer. Uniqueness on
 * (workspace_id, message_id, user_id) means re-submitting updates the existing
 * row rather than creating a duplicate. The operator-owned review fields
 * (review_status, failure_reason) are intentionally left untouched on update so
 * a later user edit never silently re-opens a resolved item.
 */
export async function upsertFeedback(
  params: UpsertFeedbackParams,
): Promise<FeedbackRecord> {
  const reportType = params.reportType ?? null;
  const comment = params.comment?.trim() ? params.comment.trim() : null;
  const [row] = await db
    .insert(answerFeedback)
    .values({
      workspaceId: params.workspaceId,
      messageId: params.messageId,
      userId: params.userId,
      rating: params.rating,
      reportType,
      comment,
      traceId: params.traceId ?? null,
    })
    .onConflictDoUpdate({
      target: [
        answerFeedback.workspaceId,
        answerFeedback.messageId,
        answerFeedback.userId,
      ],
      set: {
        rating: params.rating,
        reportType,
        comment,
        traceId: params.traceId ?? null,
        updatedAt: new Date(),
      },
    })
    .returning({
      id: answerFeedback.id,
      rating: answerFeedback.rating,
      reportType: answerFeedback.reportType,
      comment: answerFeedback.comment,
      reviewStatus: answerFeedback.reviewStatus,
    });
  return row;
}

export type FeedbackListFilters = {
  knowledgeBaseId?: string | null;
  reviewStatus?: FeedbackReviewStatus | null;
};

export type FeedbackListItem = {
  id: string;
  rating: FeedbackRating;
  reportType: FeedbackReportType | null;
  reviewStatus: FeedbackReviewStatus;
  failureReason: string | null;
  comment: string | null;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  question: string | null;
  conversationTitle: string | null;
  traceId: string | null;
  promotedCaseId: string | null;
  createdAt: Date;
};

/**
 * List feedback in a workspace (most recent first), optionally filtered by
 * knowledge base and/or review status. Scoped by `workspaceId`; the join chain
 * answer_feedback → messages → conversations → knowledge_bases keeps every row
 * inside the tenant.
 */
export async function listFeedback(
  workspaceId: string,
  filters: FeedbackListFilters = {},
  limit = 100,
): Promise<FeedbackListItem[]> {
  const conditions = [eq(answerFeedback.workspaceId, workspaceId)];
  if (filters.knowledgeBaseId) {
    conditions.push(eq(conversations.knowledgeBaseId, filters.knowledgeBaseId));
  }
  if (filters.reviewStatus) {
    conditions.push(eq(answerFeedback.reviewStatus, filters.reviewStatus));
  }

  return db
    .select({
      id: answerFeedback.id,
      rating: answerFeedback.rating,
      reportType: answerFeedback.reportType,
      reviewStatus: answerFeedback.reviewStatus,
      failureReason: answerFeedback.failureReason,
      comment: answerFeedback.comment,
      knowledgeBaseId: conversations.knowledgeBaseId,
      knowledgeBaseName: knowledgeBases.name,
      question: sql<string | null>`coalesce(${ragTraces.query}, ${conversations.title})`,
      conversationTitle: conversations.title,
      traceId: answerFeedback.traceId,
      promotedCaseId: answerFeedback.promotedCaseId,
      createdAt: answerFeedback.createdAt,
    })
    .from(answerFeedback)
    .innerJoin(messages, eq(answerFeedback.messageId, messages.id))
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .innerJoin(
      knowledgeBases,
      eq(conversations.knowledgeBaseId, knowledgeBases.id),
    )
    .leftJoin(ragTraces, eq(answerFeedback.traceId, ragTraces.id))
    .where(and(...conditions))
    .orderBy(desc(answerFeedback.createdAt))
    .limit(limit);
}

export type FeedbackDetail = {
  id: string;
  rating: FeedbackRating;
  reportType: FeedbackReportType | null;
  comment: string | null;
  reviewStatus: FeedbackReviewStatus;
  failureReason: string | null;
  traceId: string | null;
  messageId: string;
  answer: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  question: string | null;
  conversationTitle: string | null;
  promotedCaseId: string | null;
  promotedDatasetId: string | null;
  promotedDatasetName: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Fetch one feedback row with its answer context, scoped to the workspace.
 * Returns null when it does not exist or belongs to another workspace.
 */
export async function getFeedback(
  workspaceId: string,
  feedbackId: string,
): Promise<FeedbackDetail | null> {
  const [row] = await db
    .select({
      id: answerFeedback.id,
      rating: answerFeedback.rating,
      reportType: answerFeedback.reportType,
      comment: answerFeedback.comment,
      reviewStatus: answerFeedback.reviewStatus,
      failureReason: answerFeedback.failureReason,
      traceId: answerFeedback.traceId,
      messageId: answerFeedback.messageId,
      answer: messages.content,
      knowledgeBaseId: conversations.knowledgeBaseId,
      knowledgeBaseName: knowledgeBases.name,
      question: sql<string | null>`coalesce(${ragTraces.query}, ${conversations.title})`,
      conversationTitle: conversations.title,
      promotedCaseId: answerFeedback.promotedCaseId,
      promotedDatasetId: evaluationDatasets.id,
      promotedDatasetName: evaluationDatasets.name,
      createdAt: answerFeedback.createdAt,
      updatedAt: answerFeedback.updatedAt,
    })
    .from(answerFeedback)
    .innerJoin(messages, eq(answerFeedback.messageId, messages.id))
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .innerJoin(
      knowledgeBases,
      eq(conversations.knowledgeBaseId, knowledgeBases.id),
    )
    .leftJoin(ragTraces, eq(answerFeedback.traceId, ragTraces.id))
    .leftJoin(
      evaluationCases,
      eq(answerFeedback.promotedCaseId, evaluationCases.id),
    )
    .leftJoin(
      evaluationDatasets,
      eq(evaluationCases.datasetId, evaluationDatasets.id),
    )
    .where(
      and(
        eq(answerFeedback.id, feedbackId),
        eq(answerFeedback.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export type FeedbackCounts = Record<FeedbackReviewStatus, number>;

/** Count feedback by review status in a workspace (for the ops list header). */
export async function getFeedbackReviewCounts(
  workspaceId: string,
): Promise<FeedbackCounts> {
  const rows = await db
    .select({
      reviewStatus: answerFeedback.reviewStatus,
      count: sql<number>`count(*)`.mapWith(Number),
    })
    .from(answerFeedback)
    .where(eq(answerFeedback.workspaceId, workspaceId))
    .groupBy(answerFeedback.reviewStatus);

  const counts: FeedbackCounts = { NEW: 0, PENDING_REVIEW: 0, RESOLVED: 0 };
  for (const row of rows) {
    counts[row.reviewStatus] = row.count;
  }
  return counts;
}

export type UpdateFeedbackReviewParams = {
  reviewStatus: FeedbackReviewStatus;
  failureReason?: string | null;
};

/**
 * Update the operator-owned review fields on a feedback row. Scoped by
 * `workspaceId` so an operator can never touch another tenant's feedback.
 * Returns true when a row was updated.
 */
export async function updateFeedbackReview(
  workspaceId: string,
  feedbackId: string,
  params: UpdateFeedbackReviewParams,
): Promise<boolean> {
  const failureReason = params.failureReason?.trim()
    ? params.failureReason.trim()
    : null;
  const updated = await db
    .update(answerFeedback)
    .set({
      reviewStatus: params.reviewStatus,
      failureReason,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(answerFeedback.id, feedbackId),
        eq(answerFeedback.workspaceId, workspaceId),
      ),
    )
    .returning({ id: answerFeedback.id });
  return updated.length > 0;
}

export type PromoteFeedbackToCaseParams = {
  datasetId?: string | null;
  newDatasetName?: string | null;
  question: string;
  expectedAnswer?: string | null;
  expectedSourceDocuments?: string[] | null;
  requiredFacts?: string[] | null;
  tags?: string[] | null;
  markResolved?: boolean;
};

export type PromoteFeedbackToCaseResult =
  | { ok: true; caseId: string; datasetId: string; datasetName: string }
  | {
      ok: false;
      reason:
        | "FEEDBACK_NOT_FOUND"
        | "FEEDBACK_ALREADY_PROMOTED"
        | "DATASET_NOT_FOUND"
        | "DATASET_NAME_REQUIRED"
        | "EVALUATION_CASE_QUESTION_REQUIRED";
    };

/**
 * Promote a feedback item into an evaluation case inside an existing or newly
 * created dataset in the same workspace. Runs atomically inside a transaction
 * and links `answer_feedback.promoted_case_id` to the created case.
 */
export async function promoteFeedbackToCase(
  workspaceId: string,
  feedbackId: string,
  params: PromoteFeedbackToCaseParams,
): Promise<PromoteFeedbackToCaseResult> {
  const question = params.question?.trim() ?? "";
  if (!question) {
    return { ok: false, reason: "EVALUATION_CASE_QUESTION_REQUIRED" };
  }

  return db.transaction(async (tx) => {
    const [fb] = await tx
      .select({
        id: answerFeedback.id,
        knowledgeBaseId: conversations.knowledgeBaseId,
        promotedCaseId: answerFeedback.promotedCaseId,
      })
      .from(answerFeedback)
      .innerJoin(messages, eq(answerFeedback.messageId, messages.id))
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(
        and(
          eq(answerFeedback.id, feedbackId),
          eq(answerFeedback.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (!fb) {
      return { ok: false, reason: "FEEDBACK_NOT_FOUND" };
    }
    if (fb.promotedCaseId) {
      return { ok: false, reason: "FEEDBACK_ALREADY_PROMOTED" };
    }

    let targetDatasetId: string;
    let targetDatasetName: string;

    if (params.datasetId && params.datasetId !== "__new__") {
      const [ds] = await tx
        .select({
          id: evaluationDatasets.id,
          name: evaluationDatasets.name,
        })
        .from(evaluationDatasets)
        .where(
          and(
            eq(evaluationDatasets.id, params.datasetId),
            eq(evaluationDatasets.workspaceId, workspaceId),
          ),
        )
        .limit(1);

      if (!ds) {
        return { ok: false, reason: "DATASET_NOT_FOUND" };
      }
      targetDatasetId = ds.id;
      targetDatasetName = ds.name;
    } else {
      const newName = params.newDatasetName?.trim() ?? "";
      if (!newName) {
        return { ok: false, reason: "DATASET_NAME_REQUIRED" };
      }
      const [createdDs] = await tx
        .insert(evaluationDatasets)
        .values({
          workspaceId,
          knowledgeBaseId: fb.knowledgeBaseId,
          name: newName,
          description: null,
        })
        .returning({
          id: evaluationDatasets.id,
          name: evaluationDatasets.name,
        });
      targetDatasetId = createdDs.id;
      targetDatasetName = createdDs.name;
    }

    const [createdCase] = await tx
      .insert(evaluationCases)
      .values({
        datasetId: targetDatasetId,
        question,
        expectedAnswer: params.expectedAnswer?.trim() || null,
        expectedSourceDocuments: params.expectedSourceDocuments ?? null,
        expectedChunks: null,
        requiredFacts: params.requiredFacts ?? null,
        tags: params.tags ?? null,
      })
      .returning({ id: evaluationCases.id });

    await tx
      .update(evaluationDatasets)
      .set({ updatedAt: new Date() })
      .where(eq(evaluationDatasets.id, targetDatasetId));

    await tx
      .update(answerFeedback)
      .set({
        promotedCaseId: createdCase.id,
        ...(params.markResolved ? { reviewStatus: "RESOLVED" as const } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(answerFeedback.id, feedbackId),
          eq(answerFeedback.workspaceId, workspaceId),
        ),
      );

    return {
      ok: true,
      caseId: createdCase.id,
      datasetId: targetDatasetId,
      datasetName: targetDatasetName,
    };
  });
}
