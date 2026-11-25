"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

import { FeedbackControls } from "@/components/chat/FeedbackControls";

type KnowledgeBaseOption = {
  id: string;
  name: string;
};

type Citation = {
  sourceNumber: number;
  chunkId: string;
  documentId: string;
  documentTitle: string | null;
  chunkIndex: number | null;
  score: number | null;
  snippet: string;
};

type ChatMessage = {
  id: string;
  role: "USER" | "ASSISTANT";
  content: string;
  citations: Citation[];
  refused: boolean;
  streaming: boolean;
  error: string | null;
  traceId: string | null;
  // The persisted assistant message id, needed to attach feedback.
  messageId: string | null;
};

type DonePayload = {
  answer?: string;
  refused?: boolean;
  citations?: Citation[];
  traceId?: string | null;
  messageId?: string | null;
};

let messageCounter = 0;
function nextId(): string {
  messageCounter += 1;
  return `m${messageCounter}-${Date.now()}`;
}

/** Parse newly arrived SSE text into complete event blocks. */
function drainBlocks(buffer: string): { blocks: string[]; rest: string } {
  const blocks: string[] = [];
  let rest = buffer;
  let idx: number;
  while ((idx = rest.indexOf("\n\n")) !== -1) {
    const block = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    if (block.trim()) {
      blocks.push(block);
    }
  }
  return { blocks, rest };
}

function parseBlock(block: string): { event: string; data: unknown } {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  let data: unknown = null;
  if (dataLines.length > 0) {
    try {
      data = JSON.parse(dataLines.join("\n"));
    } catch {
      data = null;
    }
  }
  return { event, data };
}

export function ChatPanel({
  chatEndpoint,
  traceBasePath,
  knowledgeBasesBasePath,
  workspaceSlug,
  knowledgeBases,
}: {
  chatEndpoint: string;
  // Base path for trace deep-links, e.g. `/en/acme/traces`. A trace id is appended.
  traceBasePath: string;
  // Base path for document/chunk deep-links, e.g. `/en/acme/knowledge-bases`.
  knowledgeBasesBasePath: string;
  // Workspace slug, used when submitting answer feedback.
  workspaceSlug: string;
  knowledgeBases: KnowledgeBaseOption[];
}) {
  const t = useTranslations("chat");
  const [selectedKbId, setSelectedKbId] = useState(
    knowledgeBases[0]?.id ?? "",
  );
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const patchMessage = useCallback(
    (id: string, patch: Partial<ChatMessage>) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, ...patch } : m)),
      );
    },
    [],
  );

  const send = useCallback(async () => {
    const query = input.trim();
    if (!query || sending || !selectedKbId) {
      return;
    }
    setInput("");
    setSending(true);

    const userMessage: ChatMessage = {
      id: nextId(),
      role: "USER",
      content: query,
      citations: [],
      refused: false,
      streaming: false,
      error: null,
      traceId: null,
      messageId: null,
    };
    const assistantId = nextId();
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "ASSISTANT",
      content: "",
      citations: [],
      refused: false,
      streaming: true,
      error: null,
      traceId: null,
      messageId: null,
    };
    setMessages((prev) => [...prev, userMessage, assistantMessage]);

    try {
      const res = await fetch(chatEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          knowledgeBaseId: selectedKbId,
          query,
          conversationId,
        }),
      });

      const cid = res.headers.get("X-Conversation-Id");
      if (cid) {
        setConversationId(cid);
      }

      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        patchMessage(assistantId, {
          streaming: false,
          error: data.error ?? t("requestFailed", { status: res.status }),
        });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let text = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const { blocks, rest } = drainBlocks(buffer);
        buffer = rest;
        for (const block of blocks) {
          const { event, data } = parseBlock(block);
          if (event === "token") {
            const delta = (data as { text?: string } | null)?.text ?? "";
            text += delta;
            patchMessage(assistantId, { content: text });
          } else if (event === "done") {
            const payload = (data as DonePayload | null) ?? {};
            patchMessage(assistantId, {
              content: payload.answer ?? text,
              citations: payload.citations ?? [],
              refused: Boolean(payload.refused),
              streaming: false,
              traceId: payload.traceId ?? null,
              messageId: payload.messageId ?? null,
            });
          } else if (event === "error") {
            const msg = (data as { message?: string } | null)?.message;
            patchMessage(assistantId, {
              streaming: false,
              error: msg ?? t("answerFailed"),
            });
          }
        }
      }
      patchMessage(assistantId, { streaming: false });
    } catch {
      patchMessage(assistantId, {
        streaming: false,
        error: t("networkError"),
      });
    } finally {
      setSending(false);
    }
  }, [
    input,
    sending,
    selectedKbId,
    conversationId,
    chatEndpoint,
    patchMessage,
    t,
  ]);

  if (knowledgeBases.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-neutral-300 p-6 text-sm text-neutral-500 dark:border-neutral-700">
        {t("needKnowledgeBase")}
      </p>
    );
  }

  return (
    <div className="flex h-[70vh] flex-col rounded-lg border border-neutral-200 dark:border-neutral-800">
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <label htmlFor="kb-select" className="text-sm text-neutral-500">
          {t("knowledgeBase")}
        </label>
        <select
          id="kb-select"
          value={selectedKbId}
          disabled={conversationId !== null}
          onChange={(e) => setSelectedKbId(e.target.value)}
          className="rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm outline-none disabled:opacity-60 dark:border-neutral-700"
        >
          {knowledgeBases.map((kb) => (
            <option key={kb.id} value={kb.id}>
              {kb.name}
            </option>
          ))}
        </select>
        {conversationId !== null && (
          <button
            type="button"
            onClick={() => {
              setConversationId(null);
              setMessages([]);
            }}
            className="ml-auto text-xs text-neutral-500 underline-offset-4 hover:underline"
          >
            {t("newConversation")}
          </button>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <p className="text-sm text-neutral-500">
            {t("emptyConversation")}
          </p>
        ) : (
          messages.map((m) => (
            <MessageBubble
              key={m.id}
              message={m}
              knowledgeBaseId={selectedKbId}
              traceBasePath={traceBasePath}
              knowledgeBasesBasePath={knowledgeBasesBasePath}
              workspaceSlug={workspaceSlug}
            />
          ))
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        className="flex items-end gap-2 border-t border-neutral-200 px-4 py-3 dark:border-neutral-800"
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={1}
          placeholder={t("inputPlaceholder")}
          className="min-h-[40px] flex-1 resize-none rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:focus:border-neutral-200"
        />
        <button
          type="submit"
          disabled={sending || !input.trim()}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-60 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {sending ? "…" : t("send")}
        </button>
      </form>
    </div>
  );
}

function MessageBubble({
  message,
  knowledgeBaseId,
  traceBasePath,
  knowledgeBasesBasePath,
  workspaceSlug,
}: {
  message: ChatMessage;
  knowledgeBaseId: string;
  traceBasePath: string;
  knowledgeBasesBasePath: string;
  workspaceSlug: string;
}) {
  const t = useTranslations("chat");
  const isUser = message.role === "USER";
  return (
    <div className={isUser ? "flex justify-end" : "flex justify-start"}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
          isUser
            ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
            : "bg-neutral-100 text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100"
        }`}
      >
        {message.content ? (
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        ) : message.streaming ? (
          <p className="text-neutral-400">{t("thinking")}</p>
        ) : null}

        {message.error && (
          <p className="mt-1 text-red-600 dark:text-red-400">{message.error}</p>
        )}

        {!isUser && message.refused && (
          <span className="mt-2 inline-block rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            {t("lowConfidence")}
          </span>
        )}

        {!isUser && message.citations.length > 0 && (
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-neutral-500 hover:underline">
              {t("sources", { count: message.citations.length })}
            </summary>
            <ul className="mt-2 space-y-2">
              {message.citations.map((c) => {
                const chunkHref =
                  knowledgeBaseId && c.documentTitle
                    ? `${knowledgeBasesBasePath}/${knowledgeBaseId}/documents/${c.documentId}${
                        c.chunkIndex != null ? `#chunk-${c.chunkIndex}` : ""
                      }`
                    : null;
                return (
                  <li
                    key={c.chunkId}
                    className="rounded-md border border-neutral-200 bg-white p-2 text-xs dark:border-neutral-800 dark:bg-neutral-950"
                  >
                    <div className="flex items-center justify-between gap-2">
                      {chunkHref ? (
                        <Link
                          href={chunkHref}
                          className="font-medium underline-offset-4 hover:underline"
                        >
                          [{c.sourceNumber}] {c.documentTitle}
                          {c.chunkIndex != null ? ` · #${c.chunkIndex}` : ""}
                        </Link>
                      ) : (
                        <span className="font-medium">
                          [{c.sourceNumber}] {c.documentTitle ?? c.documentId}
                        </span>
                      )}
                      {typeof c.score === "number" && (
                        <span className="text-neutral-400">
                          {t("score", { score: c.score.toFixed(3) })}
                        </span>
                      )}
                    </div>
                    {c.snippet && (
                      <p className="mt-1 whitespace-pre-wrap text-neutral-600 dark:text-neutral-400">
                        {c.snippet}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </details>
        )}

        {!isUser && !message.streaming && !message.error && (
          <div className="mt-2 space-y-2">
            <div className="flex items-center gap-2">
              {message.messageId && (
                <FeedbackControls
                  workspaceSlug={workspaceSlug}
                  messageId={message.messageId}
                />
              )}
              {message.traceId && (
                <Link
                  href={`${traceBasePath}/${message.traceId}`}
                  className="ml-auto rounded border border-neutral-200 px-1.5 py-0.5 text-xs text-neutral-500 underline-offset-4 hover:underline dark:border-neutral-800"
                >
                  {t("viewTrace")}
                </Link>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
