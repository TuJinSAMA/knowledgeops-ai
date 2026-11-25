"""Answer generation core (the single RAG answer implementation).

Pipeline: retrieve -> assemble a numbered-source context -> ask the LLM to
answer using only that context and cite sources by number -> parse citations
-> return the answer plus a retrieval/stage snapshot for tracing. When no
retrieved chunk clears the relevance bar the assistant refuses instead of
fabricating an answer.

Two output modes share all of the above so there is exactly one answer
implementation:
  - ``generate_answer`` returns a complete ``AnswerResult`` (used by tests and
    by future batch evaluation reuse).
  - ``stream_answer_events`` yields SSE-friendly events for the real-time chat
    path, ending with the same structured payload.

The result carries a ``trace`` block (retrieved chunks + scores, final
context, model, per-stage latency, token usage) reserved for the Phase 5 trace
store; this module only produces it, the web layer persists it.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.rag.llm import FakeLLM, LLMProvider, LLMUsage, get_llm_provider
from app.rag.reranker import rerank_chunks
from app.rag.retrieval import RetrievedChunk, retrieve

REFUSAL_MESSAGE = (
    "I don't have enough information in the knowledge base to answer this "
    "question confidently, so I won't guess. Please add relevant documents or "
    "rephrase your question."
)

REFUSAL_MESSAGE_ZH = (
    "当前知识库中没有足够的信息来准确回答该问题，因此我不会猜测。"
    "请补充相关文档或换一种方式提问。"
)

_SYSTEM_PROMPT = (
    "You are an enterprise knowledge assistant. Always answer in the same "
    "language as the user's question. Answer using ONLY the numbered sources "
    "provided in the context, and cite every supported claim with its source "
    "number in square brackets, e.g. [1] or [2]. If the provided sources do "
    "not contain the information needed to answer the question, begin your "
    "response with the exact token [REFUSED], briefly state in the user's "
    "language that the knowledge base does not contain enough information, "
    "and do NOT cite any source numbers. Never invent facts or sources."
)

_CITATION_PATTERN = re.compile(r"\[(\d+)\]")
_CJK_PATTERN = re.compile(r"[\u4e00-\u9fff]")
_REFUSAL_PREFIX_PATTERN = re.compile(r"^\s*\[REFUSED\]\s*:?\s*", re.IGNORECASE)
_MAX_SYSTEM_PROMPT_ADDENDUM_CHARS = 1000
_REFUSAL_FALLBACK_PHRASES: tuple[str, ...] = (
    "i don't have enough information",
    "i do not have enough information",
    "not contain enough information",
    "没有足够的信息",
    "资料不足",
    "未提及",
    "无法从现有资料",
    "无法回答",
)


def get_refusal_message(query: str) -> str:
    """Return a refusal message matching the language of ``query``."""
    if query and _CJK_PATTERN.search(query):
        return REFUSAL_MESSAGE_ZH
    return REFUSAL_MESSAGE


def detect_and_clean_refusal(text: str) -> tuple[str, bool]:
    """Detect whether LLM output is a refusal and strip the sentinel/citations."""
    if not text:
        return "", False
    has_prefix = bool(_REFUSAL_PREFIX_PATTERN.match(text))
    cleaned = _REFUSAL_PREFIX_PATTERN.sub("", text, count=1) if has_prefix else text
    lower = cleaned.lower()
    has_fallback = any(phrase in lower for phrase in _REFUSAL_FALLBACK_PHRASES)
    is_refused = has_prefix or has_fallback
    if is_refused:
        cleaned = re.sub(r"\s*\[\d+\]", "", cleaned).strip()
    return cleaned, is_refused


@dataclass(frozen=True)
class Citation:
    """A resolved citation: source number -> the chunk/document it points to."""

    source_number: int
    chunk_id: str
    document_id: str

    def to_dict(self) -> dict:
        return {
            "source_number": self.source_number,
            "chunk_id": self.chunk_id,
            "document_id": self.document_id,
        }


_REWRITE_SYSTEM_PROMPT = (
    "You are a search query rewriter for an enterprise RAG system. Given the "
    "recent conversation history (if any) and the user's latest question, "
    "resolve any pronouns or references and produce a single standalone, "
    "self-contained search query in the same language as the user's question. "
    "Output ONLY the rewritten search query text, with no quotes or explanation."
)


def normalize_rag_config(config: dict[str, Any] | None) -> dict[str, Any]:
    """Normalize camelCase and snake_case RAG configuration keys."""
    raw = config or {}
    top_k = raw.get("top_k") if raw.get("top_k") is not None else raw.get("topK")
    score_threshold = (
        raw.get("score_threshold")
        if raw.get("score_threshold") is not None
        else raw.get("scoreThreshold")
    )
    min_score = (
        raw.get("min_score")
        if raw.get("min_score") is not None
        else raw.get("minScore")
    )
    retrieval_mode = (
        raw.get("retrieval_mode")
        or raw.get("retrievalMode")
        or "hybrid"
    )
    query_rewrite = (
        raw.get("query_rewrite")
        if raw.get("query_rewrite") is not None
        else raw.get("queryRewrite")
    )
    if isinstance(query_rewrite, str):
        query_rewrite = query_rewrite.strip().lower() in ("true", "1", "yes", "on")
    reranker = str(raw.get("reranker") or "none").strip().lower()
    raw_addendum = (
        raw.get("system_prompt_addendum")
        if raw.get("system_prompt_addendum") is not None
        else raw.get("systemPromptAddendum")
    )
    addendum: str | None = None
    if isinstance(raw_addendum, str) and raw_addendum.strip():
        addendum = raw_addendum.strip()[:_MAX_SYSTEM_PROMPT_ADDENDUM_CHARS]

    return {
        "top_k": top_k,
        "score_threshold": score_threshold,
        "min_score": min_score,
        "retrieval_mode": str(retrieval_mode).strip().lower(),
        "query_rewrite": bool(query_rewrite) if query_rewrite is not None else None,
        "reranker": reranker,
        "system_prompt_addendum": addendum,
    }


def rewrite_query(
    query: str,
    history: list[dict[str, str]] | None,
    provider: LLMProvider,
    settings: Settings | None = None,
) -> str:
    """Rewrite ``query`` into a standalone retrieval query using conversation history."""
    del settings
    clean_query = (query or "").strip()
    if not clean_query:
        return ""

    prior_users = [
        m.get("content", "").strip()
        for m in (history or [])
        if isinstance(m, dict)
        and str(m.get("role", "")).lower() == "user"
        and m.get("content", "").strip()
    ]

    # Deterministic offline path for FakeLLM (or when no real LLM call is needed).
    if isinstance(provider, FakeLLM):
        if prior_users:
            last_user = prior_users[-1]
            if last_user not in clean_query:
                return f"{last_user} {clean_query}"
        return clean_query

    history_lines = []
    for m in (history or [])[-6:]:
        if isinstance(m, dict) and m.get("content"):
            role = str(m.get("role", "user")).upper()
            history_lines.append(f"{role}: {m['content'].strip()}")
    history_block = "\n".join(history_lines) if history_lines else "(none)"

    messages = [
        {"role": "system", "content": _REWRITE_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": (
                f"Conversation history:\n{history_block}\n\n"
                f"Latest question: {clean_query}\n\n"
                "Standalone search query:"
            ),
        },
    ]
    try:
        res = provider.complete(messages)
        candidate = res.text.strip().strip('"').strip("'")
        return candidate if candidate else clean_query
    except Exception:  # noqa: BLE001 - fallback to raw query on rewrite failure
        return clean_query


@dataclass
class AnswerResult:
    answer: str
    citations: list[Citation]
    usage: LLMUsage | None
    refused: bool
    model: str
    retrieved: list[RetrievedChunk] = field(default_factory=list)
    final_context: str = ""
    stage_latency_ms: dict[str, float] = field(default_factory=dict)
    rewritten_query: str | None = None
    retrieval_config: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "answer": self.answer,
            "citations": [c.to_dict() for c in self.citations],
            "usage": self.usage.to_dict() if self.usage else None,
            "refused": self.refused,
            "model": self.model,
            "rewritten_query": self.rewritten_query,
            "trace": {
                "rewritten_query": self.rewritten_query,
                "retrieval_config": self.retrieval_config,
                "retrieved_chunks": [c.to_dict() for c in self.retrieved],
                "final_context": self.final_context,
                "model": self.model,
                "stage_latency_ms": self.stage_latency_ms,
                "token_usage": self.usage.to_dict() if self.usage else None,
            },
        }


@dataclass
class _AnswerPlan:
    """Everything decided before the (optional) LLM call."""

    retrieved: list[RetrievedChunk]
    final_context: str
    messages: list[dict[str, str]]
    refused: bool
    retrieve_latency_ms: float
    rewrite_latency_ms: float | None = None
    rerank_latency_ms: float | None = None
    rewritten_query: str | None = None
    retrieval_config: dict[str, Any] = field(default_factory=dict)


def _plan_answer(
    session: Session,
    *,
    workspace_id: str,
    knowledge_base_id: str,
    query: str,
    history: list[dict[str, str]] | None = None,
    config: dict[str, Any] | None,
    settings: Settings,
    provider: LLMProvider | None = None,
) -> _AnswerPlan:
    norm = normalize_rag_config(config)
    top_k = norm["top_k"]
    effective_top_k = top_k if top_k and top_k > 0 else settings.retrieval_top_k
    score_threshold = norm["score_threshold"]
    min_score = (
        norm["min_score"]
        if norm["min_score"] is not None
        else settings.answer_min_score
    )
    retrieval_mode = norm["retrieval_mode"]
    query_rewrite_flag = norm["query_rewrite"]
    reranker = norm["reranker"]
    use_reranker = reranker not in ("", "none")
    system_prompt_addendum = norm["system_prompt_addendum"]

    should_rewrite = (
        query_rewrite_flag
        if query_rewrite_flag is not None
        else bool(history)
    )

    effective_query = query
    rewritten_query: str | None = None
    rewrite_latency_ms: float | None = None

    if should_rewrite and query and query.strip():
        llm = provider or get_llm_provider(settings)
        rw_started = time.perf_counter()
        rewritten = rewrite_query(query, history, llm, settings)
        rewrite_latency_ms = (time.perf_counter() - rw_started) * 1000
        if rewritten:
            effective_query = rewritten
            rewritten_query = rewritten

    retrieve_k = max(effective_top_k * 3, 12) if use_reranker else effective_top_k
    started = time.perf_counter()
    retrieved = retrieve(
        session,
        workspace_id=workspace_id,
        knowledge_base_id=knowledge_base_id,
        query=effective_query,
        top_k=retrieve_k,
        score_threshold=score_threshold,
        retrieval_mode=retrieval_mode,
        settings=settings,
    )
    retrieve_latency_ms = (time.perf_counter() - started) * 1000

    rerank_latency_ms: float | None = None
    if use_reranker and retrieved:
        rr_llm = (
            provider or get_llm_provider(settings)
            if reranker == "llm"
            else None
        )
        rr_started = time.perf_counter()
        retrieved = rerank_chunks(
            effective_query,
            retrieved,
            reranker=reranker,
            top_k=effective_top_k,
            provider=rr_llm,
        )
        rerank_latency_ms = (time.perf_counter() - rr_started) * 1000

    recorded_config: dict[str, Any] = {
        "top_k": effective_top_k,
        "retrieval_mode": retrieval_mode,
        "min_score": min_score,
        "query_rewrite": bool(should_rewrite),
        "reranker": reranker,
    }
    if system_prompt_addendum:
        recorded_config["system_prompt_addendum"] = system_prompt_addendum

    # Refuse when nothing was retrieved or the best hit is below the bar.
    relevant = [c for c in retrieved if c.score >= min_score]
    if not relevant:
        return _AnswerPlan(
            retrieved=retrieved,
            final_context="",
            messages=[],
            refused=True,
            retrieve_latency_ms=retrieve_latency_ms,
            rewrite_latency_ms=rewrite_latency_ms,
            rerank_latency_ms=rerank_latency_ms,
            rewritten_query=rewritten_query,
            retrieval_config=recorded_config,
        )

    final_context = build_context(relevant)
    messages = build_messages(
        query,
        final_context,
        system_prompt_addendum=system_prompt_addendum,
    )
    return _AnswerPlan(
        retrieved=relevant,
        final_context=final_context,
        messages=messages,
        refused=False,
        retrieve_latency_ms=retrieve_latency_ms,
        rewrite_latency_ms=rewrite_latency_ms,
        rerank_latency_ms=rerank_latency_ms,
        rewritten_query=rewritten_query,
        retrieval_config=recorded_config,
    )


def generate_answer(
    session: Session,
    *,
    workspace_id: str,
    knowledge_base_id: str,
    query: str,
    history: list[dict[str, str]] | None = None,
    config: dict[str, Any] | None = None,
    settings: Settings | None = None,
    provider: LLMProvider | None = None,
) -> AnswerResult:
    """Run the full retrieve -> answer pipeline and return a complete result."""
    settings = settings or get_settings()
    plan = _plan_answer(
        session,
        workspace_id=workspace_id,
        knowledge_base_id=knowledge_base_id,
        query=query,
        history=history,
        config=config,
        settings=settings,
        provider=provider,
    )

    stage_latencies: dict[str, float] = {}
    if plan.rewrite_latency_ms is not None:
        stage_latencies["rewrite"] = plan.rewrite_latency_ms
    stage_latencies["retrieve"] = plan.retrieve_latency_ms
    if plan.rerank_latency_ms is not None:
        stage_latencies["rerank"] = plan.rerank_latency_ms

    if plan.refused:
        refusal_msg = get_refusal_message(query)
        stage_latencies["generate"] = 0.0
        return AnswerResult(
            answer=refusal_msg,
            citations=[],
            usage=None,
            refused=True,
            model=(provider.model if provider else _provider_model(settings)),
            retrieved=plan.retrieved,
            final_context="",
            stage_latency_ms=stage_latencies,
            rewritten_query=plan.rewritten_query,
            retrieval_config=plan.retrieval_config,
        )

    provider = provider or get_llm_provider(settings)
    started = time.perf_counter()
    result = provider.complete(plan.messages)
    stage_latencies["generate"] = (time.perf_counter() - started) * 1000

    cleaned_answer, is_refused = detect_and_clean_refusal(result.text)
    citations = [] if is_refused else parse_citations(cleaned_answer, plan.retrieved)
    return AnswerResult(
        answer=cleaned_answer,
        citations=citations,
        usage=result.usage,
        refused=is_refused,
        model=result.model,
        retrieved=plan.retrieved,
        final_context=plan.final_context,
        stage_latency_ms=stage_latencies,
        rewritten_query=plan.rewritten_query,
        retrieval_config=plan.retrieval_config,
    )


def stream_answer_events(
    session: Session,
    *,
    workspace_id: str,
    knowledge_base_id: str,
    query: str,
    history: list[dict[str, str]] | None = None,
    config: dict[str, Any] | None = None,
    settings: Settings | None = None,
    provider: LLMProvider | None = None,
):
    """Yield ``(event_name, payload)`` tuples for the SSE answer endpoint.

    Events: ``token`` (incremental text), then a final ``done`` carrying the
    full answer, citations, usage and trace snapshot. The same retrieval and
    refusal logic as ``generate_answer`` is reused.
    """
    settings = settings or get_settings()
    plan = _plan_answer(
        session,
        workspace_id=workspace_id,
        knowledge_base_id=knowledge_base_id,
        query=query,
        history=history,
        config=config,
        settings=settings,
        provider=provider,
    )

    stage_latencies: dict[str, float] = {}
    if plan.rewrite_latency_ms is not None:
        stage_latencies["rewrite"] = plan.rewrite_latency_ms
    stage_latencies["retrieve"] = plan.retrieve_latency_ms
    if plan.rerank_latency_ms is not None:
        stage_latencies["rerank"] = plan.rerank_latency_ms

    if plan.refused:
        refusal_msg = get_refusal_message(query)
        stage_latencies["generate"] = 0.0
        yield ("token", {"text": refusal_msg})
        result = AnswerResult(
            answer=refusal_msg,
            citations=[],
            usage=None,
            refused=True,
            model=_provider_model(settings),
            retrieved=plan.retrieved,
            final_context="",
            stage_latency_ms=stage_latencies,
            rewritten_query=plan.rewritten_query,
            retrieval_config=plan.retrieval_config,
        )
        yield ("done", result.to_dict())
        return

    provider = provider or get_llm_provider(settings)
    started = time.perf_counter()
    raw_parts: list[str] = []
    prefix_buf = ""
    prefix_decided = False

    for delta in provider.stream(plan.messages):
        raw_parts.append(delta)
        if not prefix_decided:
            prefix_buf += delta
            trimmed_buf = prefix_buf.lstrip()
            if len(trimmed_buf) >= 12 or "\n" in trimmed_buf:
                prefix_decided = True
                stripped = _REFUSAL_PREFIX_PATTERN.sub("", prefix_buf, count=1)
                if stripped:
                    yield ("token", {"text": stripped})
        else:
            yield ("token", {"text": delta})

    if not prefix_decided and prefix_buf:
        stripped = _REFUSAL_PREFIX_PATTERN.sub("", prefix_buf, count=1)
        if stripped:
            yield ("token", {"text": stripped})

    stage_latencies["generate"] = (time.perf_counter() - started) * 1000

    raw_text = "".join(raw_parts)
    cleaned_text, is_refused = detect_and_clean_refusal(raw_text)
    citations = [] if is_refused else parse_citations(cleaned_text, plan.retrieved)
    result = AnswerResult(
        answer=cleaned_text,
        citations=citations,
        usage=provider.last_usage,
        refused=is_refused,
        model=provider.model,
        retrieved=plan.retrieved,
        final_context=plan.final_context,
        stage_latency_ms=stage_latencies,
        rewritten_query=plan.rewritten_query,
        retrieval_config=plan.retrieval_config,
    )
    yield ("done", result.to_dict())


def build_context(chunks: list[RetrievedChunk]) -> str:
    """Render retrieved chunks as numbered sources for the prompt context."""
    blocks = []
    for i, chunk in enumerate(chunks, start=1):
        blocks.append(f"[{i}] (document {chunk.document_id})\n{chunk.content.strip()}")
    return "\n\n".join(blocks)


def build_messages(
    query: str,
    context: str,
    *,
    system_prompt_addendum: str | None = None,
) -> list[dict[str, str]]:
    clean_addendum = (
        system_prompt_addendum.strip()[:_MAX_SYSTEM_PROMPT_ADDENDUM_CHARS]
        if system_prompt_addendum and system_prompt_addendum.strip()
        else None
    )
    system_content = (
        f"{_SYSTEM_PROMPT}\n\n"
        "Additional instructions for this knowledge base (must NOT override "
        "the source-grounding, [n] citation, or [REFUSED] rules above):\n"
        f"{clean_addendum}"
        if clean_addendum
        else _SYSTEM_PROMPT
    )
    user = (
        f"Context (numbered sources):\n\n{context}\n\n"
        f"Question: {query}\n\n"
        "Answer using only the sources above and cite them by number."
    )
    return [
        {"role": "system", "content": system_content},
        {"role": "user", "content": user},
    ]


def parse_citations(answer: str, chunks: list[RetrievedChunk]) -> list[Citation]:
    """Resolve ``[n]`` markers in the answer to retrieved chunks (1-based).

    Out-of-range markers are ignored; duplicates collapse; order follows first
    appearance in the answer.
    """
    citations: list[Citation] = []
    seen: set[int] = set()
    for match in _CITATION_PATTERN.finditer(answer):
        number = int(match.group(1))
        if number in seen or number < 1 or number > len(chunks):
            continue
        seen.add(number)
        chunk = chunks[number - 1]
        citations.append(
            Citation(
                source_number=number,
                chunk_id=chunk.chunk_id,
                document_id=chunk.document_id,
            )
        )
    return citations


def _provider_model(settings: Settings) -> str:
    """Best-effort model label without building a real client (for refusals)."""
    if settings.llm_provider.lower() == "deepseek":
        return settings.deepseek_model
    return "fake-llm"
