import { and, asc, eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import {
  conversations,
  documents,
  knowledgeBases,
  messages,
} from "@/db/schema";

export type MessageRole = (typeof messages.$inferSelect)["role"];

/**
 * An assistant citation enriched for display. Source numbers map back to the
 * `[n]` markers in the answer; the snippet/title/score come from the retrieval
 * snapshot returned by the AI service so a stored message renders without
 * re-querying the AI layer.
 */
export type EnrichedCitation = {
  sourceNumber: number;
  chunkId: string;
  documentId: string;
  documentTitle: string | null;
  chunkIndex: number | null;
  score: number | null;
  snippet: string;
};

/**
 * Create a new conversation in a workspace, scoped to one knowledge base and
 * the asking user. Callers must have already passed the membership guard and
 * verified the knowledge base belongs to `workspaceId`.
 */
export async function createConversation(params: {
  workspaceId: string;
  knowledgeBaseId: string;
  userId: string;
  title?: string | null;
}): Promise<{ id: string }> {
  const [row] = await db
    .insert(conversations)
    .values({
      workspaceId: params.workspaceId,
      knowledgeBaseId: params.knowledgeBaseId,
      userId: params.userId,
      title: params.title ?? null,
    })
    .returning({ id: conversations.id });
  return { id: row.id };
}

export type ConversationRow = typeof conversations.$inferSelect;

/**
 * Fetch a conversation by id, scoped to its workspace (tenant isolation).
 * Returns null when it does not exist or belongs to another workspace.
 */
export async function getConversation(
  workspaceId: string,
  conversationId: string,
): Promise<ConversationRow | null> {
  const [row] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Append a message to a conversation and bump its updated_at. */
export async function addMessage(params: {
  conversationId: string;
  role: MessageRole;
  content: string;
  citations?: EnrichedCitation[] | null;
}): Promise<{ id: string }> {
  const [row] = await db
    .insert(messages)
    .values({
      conversationId: params.conversationId,
      role: params.role,
      content: params.content,
      citations: params.citations ?? null,
    })
    .returning({ id: messages.id });

  await db
    .update(conversations)
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, params.conversationId));

  return { id: row.id };
}

/** List messages in a conversation in chronological order (for history UI). */
export async function listMessages(
  conversationId: string,
): Promise<(typeof messages.$inferSelect)[]> {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));
}

/**
 * Resolve document titles for a set of document ids within a workspace. The
 * join through `knowledge_bases` enforces tenant isolation so a caller can
 * never read another workspace's document titles.
 */
export async function getDocumentTitles(
  workspaceId: string,
  documentIds: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(documentIds)];
  if (unique.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .innerJoin(
      knowledgeBases,
      eq(documents.knowledgeBaseId, knowledgeBases.id),
    )
    .where(
      and(
        eq(knowledgeBases.workspaceId, workspaceId),
        inArray(documents.id, unique),
      ),
    );
  return new Map(rows.map((row) => [row.id, row.title]));
}
