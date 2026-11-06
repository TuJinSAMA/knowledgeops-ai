import { AuthzError, requireWorkspaceMemberBySlug } from "@/lib/authz";
import {
  addMessage,
  createConversation,
  type EnrichedCitation,
  getConversation,
  getDocumentTitles,
  listMessages,
} from "@/lib/conversation";
import { getKnowledgeBase } from "@/lib/knowledge-base";
import { estimateCost } from "@/lib/pricing";
import { assertWithinQuota, incrementUsage, QuotaExceededError } from "@/lib/quota";
import { createTrace } from "@/lib/trace";
import { env } from "@/env";

// Longest stored citation snippet (characters). Keeps message rows bounded
// while still showing enough source text to judge an answer.
const SNIPPET_MAX = 800;

export type ChatRequestBody = {
  knowledgeBaseId?: string;
  query?: string;
  conversationId?: string;
};

// The `done` payload shape emitted by the AI service `POST /v1/answer` SSE
// stream (see services/ai/app/rag/answer.py `AnswerResult.to_dict`). Only the
// fields the web layer consumes are typed.
type AiCitation = {
  source_number: number;
  chunk_id: string;
  document_id: string;
};

type AiRetrievedChunk = {
  chunk_id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  token_count: number | null;
  score: number;
  vector_score?: number | null;
  keyword_score?: number | null;
};

type AiDonePayload = {
  answer?: string;
  citations?: AiCitation[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
  refused?: boolean;
  model?: string;
  rewritten_query?: string | null;
  trace?: {
    rewritten_query?: string | null;
    retrieval_config?: Record<string, unknown> | null;
    retrieved_chunks?: AiRetrievedChunk[];
    final_context?: string;
    model?: string;
    stage_latency_ms?: Record<string, number>;
    token_usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    } | null;
  } | null;
};

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Parse a single SSE block into its event name and JSON-decoded data. */
function parseSseBlock(block: string): { event: string; data: AiDonePayload | null } {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }
  let data: AiDonePayload | null = null;
  if (dataLines.length > 0) {
    try {
      data = JSON.parse(dataLines.join("\n")) as AiDonePayload;
    } catch {
      data = null;
    }
  }
  return { event, data };
}

/**
 * Handle a chat turn end-to-end. The web layer never reimplements retrieval or
 * answering (that single implementation lives in services/ai); it only:
 *   1. authenticates + enforces tenant/role (MEMBER+) and quota,
 *   2. creates/reuses a conversation and persists the USER message,
 *   3. proxies the AI service SSE stream straight through to the browser,
 *   4. on the final `done` event, enriches citations, persists the ASSISTANT
 *      message and increments usage.
 *
 * Returns a streaming `Response` on success, or a JSON error Response with the
 * appropriate status (401/403/404/400/429/502) on failure.
 */
export async function handleChat(
  workspaceSlug: string,
  body: ChatRequestBody,
): Promise<Response> {
  let workspaceId: string;
  let userId: string;
  try {
    const ctx = await requireWorkspaceMemberBySlug(workspaceSlug, "MEMBER");
    workspaceId = ctx.workspaceId;
    userId = ctx.user.id;
  } catch (error) {
    if (error instanceof AuthzError) {
      return jsonError(error.message, error.status);
    }
    throw error;
  }

  const query = body.query?.trim();
  if (!query) {
    return jsonError("Missing 'query'", 400);
  }

  // Quota gate before spending any tokens (and before creating a conversation,
  // so a rejected turn never leaves an empty conversation behind).
  try {
    await assertWithinQuota(workspaceId);
  } catch (error) {
    if (error instanceof QuotaExceededError) {
      return jsonError(error.message, 429);
    }
    throw error;
  }

  // Resolve the conversation + knowledge base. A reused conversation is the
  // source of truth for its knowledge base; a new one needs an explicit kb.
  let conversationId: string;
  let knowledgeBaseId: string;
  let history: Array<{ role: string; content: string }> = [];

  if (body.conversationId) {
    const conversation = await getConversation(workspaceId, body.conversationId);
    if (!conversation) {
      return jsonError("Conversation not found", 404);
    }
    conversationId = conversation.id;
    knowledgeBaseId = conversation.knowledgeBaseId;
    const prior = await listMessages(conversationId);
    history = prior.slice(-6).map((m) => ({
      role: m.role.toLowerCase(),
      content: m.content,
    }));
  } else {
    if (!body.knowledgeBaseId) {
      return jsonError("Missing 'knowledgeBaseId'", 400);
    }
    const kb = await getKnowledgeBase(workspaceId, body.knowledgeBaseId);
    if (!kb) {
      return jsonError("Knowledge base not found", 404);
    }
    knowledgeBaseId = kb.id;
    const created = await createConversation({
      workspaceId,
      knowledgeBaseId,
      userId,
      title: query.slice(0, 80),
    });
    conversationId = created.id;
  }

  // Persist the user's turn before calling the AI service.
  await addMessage({ conversationId, role: "USER", content: query });

  // Retrieval config sent to the AI service (empty = AI service defaults).
  // Recorded verbatim on the trace so a turn is reproducible.
  const retrievalConfig: Record<string, unknown> = {};

  // Call the single RAG answer implementation over internal HTTP. Time the
  // whole AI turn for the trace's end-to-end latency.
  const turnStartedAt = Date.now();
  let upstream: Response;
  try {
    upstream = await fetch(`${env.aiServiceUrl}/v1/answer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.internalApiToken
          ? { "X-Internal-Token": env.internalApiToken }
          : {}),
      },
      body: JSON.stringify({
        workspace_id: workspaceId,
        knowledge_base_id: knowledgeBaseId,
        query,
        history,
        config: retrievalConfig,
        conversation_id: conversationId,
      }),
    });
  } catch {
    return jsonError("AI service is unreachable", 502);
  }

  if (!upstream.ok || !upstream.body) {
    return jsonError(`AI service error (${upstream.status})`, 502);
  }

  const stream = buildProxyStream(upstream.body, {
    workspaceId,
    conversationId,
    query,
    retrievalConfig,
    turnStartedAt,
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Conversation-Id": conversationId,
    },
  });
}

/**
 * Wrap the AI service SSE body in a stream that forwards `token`/`error`
 * events verbatim for live rendering, but intercepts the final `done` event to
 * enrich citations (titles + snippets + scores), persist the assistant message
 * and increment usage, then emits an enriched `done` to the browser.
 */
function buildProxyStream(
  upstream: ReadableStream<Uint8Array>,
  ctx: {
    workspaceId: string;
    conversationId: string;
    query: string;
    retrievalConfig: Record<string, unknown>;
    turnStartedAt: number;
  },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  /** Build the enriched citations (titles + snippet + score) for display. */
  async function enrichCitations(
    captured: AiDonePayload,
  ): Promise<EnrichedCitation[]> {
    const citations = captured.citations ?? [];
    const retrieved = captured.trace?.retrieved_chunks ?? [];
    const byChunk = new Map(retrieved.map((c) => [c.chunk_id, c]));
    const titles = await getDocumentTitles(
      ctx.workspaceId,
      citations.map((c) => c.document_id),
    );
    return citations.map((c) => {
      const chunk = byChunk.get(c.chunk_id);
      return {
        sourceNumber: c.source_number,
        chunkId: c.chunk_id,
        documentId: c.document_id,
        documentTitle: titles.get(c.document_id) ?? null,
        chunkIndex: chunk?.chunk_index ?? null,
        score: chunk?.score ?? null,
        snippet: (chunk?.content ?? "").slice(0, SNIPPET_MAX),
      };
    });
  }

  /** Snapshot the retrieved chunks for the trace's retrieved_chunks column. */
  function traceChunks(captured: AiDonePayload) {
    const retrieved = captured.trace?.retrieved_chunks ?? [];
    return retrieved.map((c) => ({
      chunkId: c.chunk_id,
      documentId: c.document_id,
      chunkIndex: c.chunk_index,
      score: c.score,
      vectorScore: c.vector_score ?? null,
      keywordScore: c.keyword_score ?? null,
      snippet: (c.content ?? "").slice(0, SNIPPET_MAX),
    }));
  }

  /**
   * On a successful `done`: enrich citations, persist the assistant message,
   * increment usage, write a trace row, and return the enriched client payload
   * (carrying the trace id so the UI can deep-link to the debug panel).
   */
  async function finalizeDone(captured: AiDonePayload): Promise<unknown> {
    const enriched = await enrichCitations(captured);

    const assistant = await addMessage({
      conversationId: ctx.conversationId,
      role: "ASSISTANT",
      content: captured.answer ?? "",
      citations: enriched,
    });

    const total = captured.usage?.total_tokens ?? 0;
    if (total > 0) {
      await Promise.all([
        incrementUsage(ctx.workspaceId, total, "daily"),
        incrementUsage(ctx.workspaceId, total, "monthly"),
      ]);
    }

    const model = captured.model ?? captured.trace?.model ?? null;
    const cost = estimateCost(model, captured.usage);
    const rewrittenQuery =
      captured.rewritten_query ?? captured.trace?.rewritten_query ?? null;
    const trace = await createTrace({
      workspaceId: ctx.workspaceId,
      conversationId: ctx.conversationId,
      messageId: assistant.id,
      query: ctx.query,
      rewrittenQuery,
      retrievalConfig: captured.trace?.retrieval_config ?? ctx.retrievalConfig,
      retrievedChunks: traceChunks(captured),
      finalContext: captured.trace?.final_context ?? null,
      model,
      response: captured.answer ?? "",
      tokenUsage: captured.usage ?? null,
      costEstimate: cost,
      latencyMs: Date.now() - ctx.turnStartedAt,
      stageLatencyMs: captured.trace?.stage_latency_ms ?? null,
      error: null,
    });

    return {
      answer: captured.answer ?? "",
      refused: Boolean(captured.refused),
      model,
      usage: captured.usage ?? null,
      citations: enriched,
      conversationId: ctx.conversationId,
      // The persisted assistant message id, so the UI can attach feedback.
      messageId: assistant.id,
      traceId: trace.id,
    };
  }

  /**
   * On a failed turn (AI emitted an `error` event or the stream was
   * interrupted before `done`): still record a trace so the failure is
   * observable. No assistant message is persisted.
   */
  async function finalizeError(message: string): Promise<void> {
    try {
      await createTrace({
        workspaceId: ctx.workspaceId,
        conversationId: ctx.conversationId,
        query: ctx.query,
        retrievalConfig: ctx.retrievalConfig,
        latencyMs: Date.now() - ctx.turnStartedAt,
        error: message,
      });
    } catch {
      // Never let trace bookkeeping break the response.
    }
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader();
      let buffer = "";
      let captured: AiDonePayload | null = null;
      let errorMessage: string | null = null;

      const handleBlock = (block: string): void => {
        const { event, data } = parseSseBlock(block);
        if (event === "done") {
          captured = data;
        } else if (event === "error") {
          errorMessage =
            (data as { message?: string } | null)?.message ?? "Answer failed";
          controller.enqueue(encoder.encode(`${block}\n\n`));
        } else {
          controller.enqueue(encoder.encode(`${block}\n\n`));
        }
      };

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            if (block.trim()) {
              handleBlock(block);
            }
          }
        }
        if (buffer.trim()) {
          handleBlock(buffer);
        }

        if (captured) {
          const clientDone = await finalizeDone(captured);
          controller.enqueue(encoder.encode(sse("done", clientDone)));
        } else if (errorMessage) {
          await finalizeError(errorMessage);
        }
        controller.close();
      } catch {
        await finalizeError("Stream interrupted");
        controller.enqueue(
          encoder.encode(sse("error", { message: "Stream interrupted" })),
        );
        controller.close();
      } finally {
        reader.releaseLock();
      }
    },
  });
}
