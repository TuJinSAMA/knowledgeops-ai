import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real-shaped AuthzError / QuotaExceededError so the handler's `instanceof`
// branches work while the guard/quota functions themselves are mocked.
const { AuthzError, QuotaExceededError } = vi.hoisted(() => {
  class AuthzError extends Error {
    readonly status: 401 | 403;
    constructor(status: 401 | 403, message: string) {
      super(message);
      this.name = "AuthzError";
      this.status = status;
    }
  }
  class QuotaExceededError extends Error {
    readonly status = 429 as const;
    constructor(message: string) {
      super(message);
      this.name = "QuotaExceededError";
    }
  }
  return { AuthzError, QuotaExceededError };
});

const requireWorkspaceMemberBySlugMock = vi.fn();
vi.mock("@/lib/authz", () => ({
  AuthzError,
  requireWorkspaceMemberBySlug: (...args: unknown[]) =>
    requireWorkspaceMemberBySlugMock(...args),
}));

const assertWithinQuotaMock = vi.fn();
const incrementUsageMock = vi.fn();
vi.mock("@/lib/quota", () => ({
  QuotaExceededError,
  assertWithinQuota: (...args: unknown[]) => assertWithinQuotaMock(...args),
  incrementUsage: (...args: unknown[]) => incrementUsageMock(...args),
}));

const getKnowledgeBaseMock = vi.fn();
vi.mock("@/lib/knowledge-base", () => ({
  getKnowledgeBase: (...args: unknown[]) => getKnowledgeBaseMock(...args),
}));

const createTraceMock = vi.fn();
vi.mock("@/lib/trace", () => ({
  createTrace: (...args: unknown[]) => createTraceMock(...args),
}));

const createConversationMock = vi.fn();
const getConversationMock = vi.fn();
const addMessageMock = vi.fn();
const listMessagesMock = vi.fn();
const getDocumentTitlesMock = vi.fn();
vi.mock("@/lib/conversation", () => ({
  createConversation: (...args: unknown[]) => createConversationMock(...args),
  getConversation: (...args: unknown[]) => getConversationMock(...args),
  addMessage: (...args: unknown[]) => addMessageMock(...args),
  listMessages: (...args: unknown[]) => listMessagesMock(...args),
  getDocumentTitles: (...args: unknown[]) => getDocumentTitlesMock(...args),
}));

vi.mock("@/env", () => ({
  env: { aiServiceUrl: "http://ai.test", internalApiToken: "secret-token" },
}));

import { handleChat } from "./chat";

const SLUG = "acme";
const WORKSPACE_ID = "ws-1";
const USER_ID = "user-1";
const KB_ID = "kb-1";

/** Build a ReadableStream emitting the given SSE text as one chunk. */
function sseBody(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireWorkspaceMemberBySlugMock.mockResolvedValue({
    workspaceId: WORKSPACE_ID,
    user: { id: USER_ID },
    role: "MEMBER",
  });
  assertWithinQuotaMock.mockResolvedValue(undefined);
  getKnowledgeBaseMock.mockResolvedValue({ id: KB_ID, name: "Docs" });
  createConversationMock.mockResolvedValue({ id: "conv-1" });
  addMessageMock.mockResolvedValue({ id: "msg-1" });
  listMessagesMock.mockResolvedValue([]);
  getDocumentTitlesMock.mockResolvedValue(new Map([["doc-1", "Doc One"]]));
  createTraceMock.mockResolvedValue({ id: "trace-1" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleChat authorization & tenant isolation", () => {
  it("rejects an unauthenticated caller with 401 and never calls the AI service", async () => {
    requireWorkspaceMemberBySlugMock.mockRejectedValue(
      new AuthzError(401, "Authentication required"),
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await handleChat(SLUG, { knowledgeBaseId: KB_ID, query: "hi" });

    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(createConversationMock).not.toHaveBeenCalled();
  });

  it("rejects a non-member (cross-workspace) with 403", async () => {
    requireWorkspaceMemberBySlugMock.mockRejectedValue(
      new AuthzError(403, "Not a member of this workspace"),
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await handleChat(SLUG, { knowledgeBaseId: KB_ID, query: "hi" });

    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 404 when the knowledge base is not in this workspace", async () => {
    getKnowledgeBaseMock.mockResolvedValue(null);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await handleChat(SLUG, { knowledgeBaseId: "other", query: "hi" });

    expect(res.status).toBe(404);
    expect(getKnowledgeBaseMock).toHaveBeenCalledWith(WORKSPACE_ID, "other");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 400 when the query is empty", async () => {
    const res = await handleChat(SLUG, { knowledgeBaseId: KB_ID, query: "   " });
    expect(res.status).toBe(400);
    expect(createConversationMock).not.toHaveBeenCalled();
  });
});

describe("handleChat quota enforcement", () => {
  it("returns 429 and creates no conversation when the quota is exhausted", async () => {
    assertWithinQuotaMock.mockRejectedValue(
      new QuotaExceededError("Workspace daily token quota exceeded (10/10)"),
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await handleChat(SLUG, { knowledgeBaseId: KB_ID, query: "hi" });

    expect(res.status).toBe(429);
    expect(createConversationMock).not.toHaveBeenCalled();
    expect(addMessageMock).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("handleChat happy path streaming", () => {
  it("proxies tokens, enriches the done event, persists and increments usage", async () => {
    const upstream =
      'event: token\ndata: {"text": "Hello "}\n\n' +
      'event: token\ndata: {"text": "[1]"}\n\n' +
      "event: done\n" +
      'data: {"answer": "Hello [1]", "refused": false, "model": "fake-llm",' +
      ' "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8},' +
      ' "citations": [{"source_number": 1, "chunk_id": "c-1", "document_id": "doc-1"}],' +
      ' "trace": {"retrieved_chunks": [{"chunk_id": "c-1", "document_id": "doc-1",' +
      ' "chunk_index": 0, "content": "the source text", "token_count": 3, "score": 0.91}]}}\n\n';

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(sseBody(upstream), { status: 200 }),
    );

    const res = await handleChat(SLUG, { knowledgeBaseId: KB_ID, query: "hi" });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("X-Conversation-Id")).toBe("conv-1");

    const out = await readAll(res.body);
    // Tokens are forwarded verbatim.
    expect(out).toContain('event: token');
    expect(out).toContain('"text": "Hello "');
    // The done event is enriched with camelCase citations + snippet + title.
    expect(out).toContain("event: done");
    expect(out).toContain('"documentTitle":"Doc One"');
    expect(out).toContain('"snippet":"the source text"');
    expect(out).toContain('"sourceNumber":1');

    // USER message persisted before the call, ASSISTANT after.
    expect(addMessageMock).toHaveBeenCalledTimes(2);
    expect(addMessageMock).toHaveBeenNthCalledWith(1, {
      conversationId: "conv-1",
      role: "USER",
      content: "hi",
    });
    const assistantCall = addMessageMock.mock.calls[1][0];
    expect(assistantCall.role).toBe("ASSISTANT");
    expect(assistantCall.content).toBe("Hello [1]");
    expect(assistantCall.citations[0]).toMatchObject({
      sourceNumber: 1,
      chunkId: "c-1",
      documentId: "doc-1",
      documentTitle: "Doc One",
      snippet: "the source text",
    });

    // Usage incremented for both daily and monthly windows.
    expect(incrementUsageMock).toHaveBeenCalledWith(WORKSPACE_ID, 8, "daily");
    expect(incrementUsageMock).toHaveBeenCalledWith(WORKSPACE_ID, 8, "monthly");

    // The enriched done carries the trace id so the UI can deep-link.
    expect(out).toContain('"traceId":"trace-1"');
    // And the persisted assistant message id, so the UI can attach feedback.
    expect(out).toContain('"messageId":"msg-1"');

    // Exactly one trace written, scoped to the workspace + assistant message,
    // with retrieval snapshot, model, usage, cost and an end-to-end latency.
    expect(createTraceMock).toHaveBeenCalledTimes(1);
    const trace = createTraceMock.mock.calls[0][0];
    expect(trace.workspaceId).toBe(WORKSPACE_ID);
    expect(trace.conversationId).toBe("conv-1");
    expect(trace.messageId).toBe("msg-1");
    expect(trace.query).toBe("hi");
    expect(trace.model).toBe("fake-llm");
    expect(trace.response).toBe("Hello [1]");
    expect(trace.tokenUsage).toMatchObject({ total_tokens: 8 });
    // fake-llm is priced at 0 in the web price map.
    expect(trace.costEstimate).toBe(0);
    expect(typeof trace.latencyMs).toBe("number");
    expect(trace.retrievedChunks[0]).toMatchObject({
      chunkId: "c-1",
      documentId: "doc-1",
      score: 0.91,
      snippet: "the source text",
    });
    expect(trace.error).toBeNull();

    // The AI service is called with the internal token header.
    const fetchArgs = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>)
      .mock.calls[0];
    expect(fetchArgs[0]).toBe("http://ai.test/v1/answer");
    expect((fetchArgs[1] as RequestInit).headers).toMatchObject({
      "X-Internal-Token": "secret-token",
    });
  });

  it("returns 502 when the AI service responds with a non-ok status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 401 }),
    );

    const res = await handleChat(SLUG, { knowledgeBaseId: KB_ID, query: "hi" });

    expect(res.status).toBe(502);
  });

  it("reuses an existing conversation, forwards prior history, and persists rewrittenQuery", async () => {
    getConversationMock.mockResolvedValue({
      id: "conv-9",
      workspaceId: WORKSPACE_ID,
      knowledgeBaseId: "kb-reused",
    });
    listMessagesMock.mockResolvedValue([
      { id: "m-1", role: "USER", content: "Pro 套餐每月多少钱？" },
      { id: "m-2", role: "ASSISTANT", content: "Pro 套餐每月 ¥899。" },
    ]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        sseBody(
          'event: done\ndata: {"answer": "包含 5 个座席", "rewritten_query": "Pro 套餐包含几个座席？", "trace": {"rewritten_query": "Pro 套餐包含几个座席？"}}\n\n',
        ),
        {
          status: 200,
        },
      ),
    );

    const res = await handleChat(SLUG, {
      conversationId: "conv-9",
      query: "那它包含几个座席？",
    });
    await readAll(res.body);

    expect(res.status).toBe(200);
    expect(getConversationMock).toHaveBeenCalledWith(WORKSPACE_ID, "conv-9");
    expect(createConversationMock).not.toHaveBeenCalled();
    const fetchBody = JSON.parse(
      (
        (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock
          .calls[0][1] as RequestInit
      ).body as string,
    );
    expect(fetchBody.knowledge_base_id).toBe("kb-reused");
    expect(fetchBody.conversation_id).toBe("conv-9");
    expect(fetchBody.history).toEqual([
      { role: "user", content: "Pro 套餐每月多少钱？" },
      { role: "assistant", content: "Pro 套餐每月 ¥899。" },
    ]);
    expect(createTraceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        rewrittenQuery: "Pro 套餐包含几个座席？",
      }),
    );
  });

  it("returns 404 when reusing a conversation from another workspace", async () => {
    getConversationMock.mockResolvedValue(null);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await handleChat(SLUG, {
      conversationId: "conv-x",
      query: "again",
    });

    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("loads and forwards the knowledge base's live ragConfig to POST /v1/answer", async () => {
    getKnowledgeBaseMock.mockResolvedValue({
      id: KB_ID,
      name: "Docs",
      ragConfig: {
        topK: 6,
        retrievalMode: "hybrid",
        minScore: 0.42,
        queryRewrite: true,
        reranker: "heuristic",
        systemPromptAddendum: "Answer in bullet points.",
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(sseBody('event: done\ndata: {"answer": "ok"}\n\n'), {
        status: 200,
      }),
    );

    const res = await handleChat(SLUG, {
      knowledgeBaseId: KB_ID,
      query: "How much is Pro?",
    });
    await readAll(res.body);

    expect(res.status).toBe(200);
    const fetchBody = JSON.parse(
      (
        (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock
          .calls[0][1] as RequestInit
      ).body as string,
    );
    expect(fetchBody.config).toEqual({
      topK: 6,
      retrievalMode: "hybrid",
      minScore: 0.42,
      queryRewrite: true,
      reranker: "heuristic",
      systemPromptAddendum: "Answer in bullet points.",
    });
  });
});

describe("handleChat trace observability", () => {
  it("writes exactly one trace per successful answer", async () => {
    const upstream =
      'event: token\ndata: {"text": "x"}\n\n' +
      "event: done\n" +
      'data: {"answer": "x", "refused": false, "model": "fake-llm",' +
      ' "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},' +
      ' "citations": [], "trace": {"retrieved_chunks": [], "final_context": "ctx",' +
      ' "stage_latency_ms": {"retrieve": 1.5, "generate": 2.5}}}\n\n';
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(sseBody(upstream), { status: 200 }),
    );

    const res = await handleChat(SLUG, { knowledgeBaseId: KB_ID, query: "hi" });
    await readAll(res.body);

    expect(createTraceMock).toHaveBeenCalledTimes(1);
    const trace = createTraceMock.mock.calls[0][0];
    expect(trace.finalContext).toBe("ctx");
    expect(trace.refused).toBe(false);
    expect(trace.stageLatencyMs).toMatchObject({ retrieve: 1.5, generate: 2.5 });
  });

  it("persists refused=true on the trace when the assistant refuses", async () => {
    const upstream =
      'event: done\ndata: {"answer": "资料不足", "refused": true, "model": "fake-llm", "citations": []}\n\n';
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(sseBody(upstream), { status: 200 }),
    );

    const res = await handleChat(SLUG, {
      knowledgeBaseId: KB_ID,
      query: "年假有几天？",
    });
    await readAll(res.body);

    expect(createTraceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        refused: true,
        response: "资料不足",
      }),
    );
  });

  it("records a trace (with error, no assistant message) when the AI stream errors", async () => {
    const upstream = 'event: error\ndata: {"message": "boom"}\n\n';
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(sseBody(upstream), { status: 200 }),
    );

    const res = await handleChat(SLUG, { knowledgeBaseId: KB_ID, query: "hi" });
    const out = await readAll(res.body);

    // The error is forwarded to the client.
    expect(out).toContain("event: error");
    // A trace is still written, capturing the error; no done event.
    expect(out).not.toContain("event: done");
    expect(createTraceMock).toHaveBeenCalledTimes(1);
    const trace = createTraceMock.mock.calls[0][0];
    expect(trace.workspaceId).toBe(WORKSPACE_ID);
    expect(trace.error).toBe("boom");
    expect(trace.messageId ?? null).toBeNull();
    // Only the USER message was persisted (no assistant message on failure).
    expect(addMessageMock).toHaveBeenCalledTimes(1);
    expect(addMessageMock).toHaveBeenCalledWith({
      conversationId: "conv-1",
      role: "USER",
      content: "hi",
    });
  });
});
