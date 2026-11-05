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
from app.rag.llm import LLMProvider, LLMUsage, get_llm_provider
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
_REFUSAL_FALLBACK_PHRASES: tuple[str, ...] = (
    "i don't have enough information",
    "i do not have enough information",
    "not contain enough information",
    "没有足够的信息",
    "资料不足",
    "未提及",
    "无法从现有资料",
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

    def to_dict(self) -> dict:
        return {
            "answer": self.answer,
            "citations": [c.to_dict() for c in self.citations],
            "usage": self.usage.to_dict() if self.usage else None,
            "refused": self.refused,
            "model": self.model,
            "trace": {
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


def _plan_answer(
    session: Session,
    *,
    workspace_id: str,
    knowledge_base_id: str,
    query: str,
    config: dict[str, Any] | None,
    settings: Settings,
) -> _AnswerPlan:
    config = config or {}
    top_k = config.get("top_k")
    score_threshold = config.get("score_threshold")
    min_score = config.get("min_score", settings.answer_min_score)

    started = time.perf_counter()
    retrieved = retrieve(
        session,
        workspace_id=workspace_id,
        knowledge_base_id=knowledge_base_id,
        query=query,
        top_k=top_k,
        score_threshold=score_threshold,
        settings=settings,
    )
    retrieve_latency_ms = (time.perf_counter() - started) * 1000

    # Refuse when nothing was retrieved or the best hit is below the bar.
    relevant = [c for c in retrieved if c.score >= min_score]
    if not relevant:
        return _AnswerPlan(
            retrieved=retrieved,
            final_context="",
            messages=[],
            refused=True,
            retrieve_latency_ms=retrieve_latency_ms,
        )

    final_context = build_context(relevant)
    messages = build_messages(query, final_context)
    return _AnswerPlan(
        retrieved=relevant,
        final_context=final_context,
        messages=messages,
        refused=False,
        retrieve_latency_ms=retrieve_latency_ms,
    )


def generate_answer(
    session: Session,
    *,
    workspace_id: str,
    knowledge_base_id: str,
    query: str,
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
        config=config,
        settings=settings,
    )

    if plan.refused:
        refusal_msg = get_refusal_message(query)
        return AnswerResult(
            answer=refusal_msg,
            citations=[],
            usage=None,
            refused=True,
            model=(provider.model if provider else _provider_model(settings)),
            retrieved=plan.retrieved,
            final_context="",
            stage_latency_ms={"retrieve": plan.retrieve_latency_ms, "generate": 0.0},
        )

    provider = provider or get_llm_provider(settings)
    started = time.perf_counter()
    result = provider.complete(plan.messages)
    generate_latency_ms = (time.perf_counter() - started) * 1000

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
        stage_latency_ms={
            "retrieve": plan.retrieve_latency_ms,
            "generate": generate_latency_ms,
        },
    )


def stream_answer_events(
    session: Session,
    *,
    workspace_id: str,
    knowledge_base_id: str,
    query: str,
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
        config=config,
        settings=settings,
    )

    if plan.refused:
        refusal_msg = get_refusal_message(query)
        yield ("token", {"text": refusal_msg})
        result = AnswerResult(
            answer=refusal_msg,
            citations=[],
            usage=None,
            refused=True,
            model=_provider_model(settings),
            retrieved=plan.retrieved,
            final_context="",
            stage_latency_ms={"retrieve": plan.retrieve_latency_ms, "generate": 0.0},
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
            if len(prefix_buf) >= 12 or "\n" in prefix_buf:
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

    generate_latency_ms = (time.perf_counter() - started) * 1000

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
        stage_latency_ms={
            "retrieve": plan.retrieve_latency_ms,
            "generate": generate_latency_ms,
        },
    )
    yield ("done", result.to_dict())


def build_context(chunks: list[RetrievedChunk]) -> str:
    """Render retrieved chunks as numbered sources for the prompt context."""
    blocks = []
    for i, chunk in enumerate(chunks, start=1):
        blocks.append(f"[{i}] (document {chunk.document_id})\n{chunk.content.strip()}")
    return "\n\n".join(blocks)


def build_messages(query: str, context: str) -> list[dict[str, str]]:
    user = (
        f"Context (numbered sources):\n\n{context}\n\n"
        f"Question: {query}\n\n"
        "Answer using only the sources above and cite them by number."
    )
    return [
        {"role": "system", "content": _SYSTEM_PROMPT},
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
