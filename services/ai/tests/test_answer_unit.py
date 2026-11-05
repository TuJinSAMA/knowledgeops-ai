"""Offline unit tests for the answer core: FakeLLM, citation parsing, context."""

from __future__ import annotations

from app.config import get_settings
from app.rag.answer import (
    REFUSAL_MESSAGE,
    REFUSAL_MESSAGE_ZH,
    build_context,
    build_messages,
    detect_and_clean_refusal,
    generate_answer,
    get_refusal_message,
    parse_citations,
    stream_answer_events,
)
from app.rag.llm import FakeLLM, LLMResult, LLMUsage, get_llm_provider
from app.rag.retrieval import RetrievedChunk


def _chunk(chunk_id: str, document_id: str, index: int, content: str) -> RetrievedChunk:
    return RetrievedChunk(
        chunk_id=chunk_id,
        document_id=document_id,
        chunk_index=index,
        content=content,
        token_count=10,
        score=0.9,
    )


def test_fake_llm_is_deterministic_and_cites():
    llm = FakeLLM()
    messages = build_messages("What is the refund window?", build_context([
        _chunk("c1", "d1", 0, "Refunds within 30 days."),
    ]))
    first = llm.complete(messages)
    second = llm.complete(messages)
    assert first.text == second.text
    assert "[1]" in first.text
    assert first.usage.total_tokens > 0


def test_fake_llm_stream_concatenates_to_complete():
    llm = FakeLLM()
    messages = build_messages("q", build_context([_chunk("c1", "d1", 0, "body")]))
    streamed = "".join(llm.stream(messages))
    assert streamed == llm.complete(messages).text
    assert llm.last_usage is not None


def test_factory_defaults_to_fake_llm():
    provider = get_llm_provider(get_settings())
    assert isinstance(provider, FakeLLM)


def test_parse_citations_resolves_and_ignores_out_of_range():
    chunks = [
        _chunk("c1", "d1", 0, "alpha"),
        _chunk("c2", "d2", 1, "beta"),
    ]
    citations = parse_citations("See [1] and [2], not [5]. Again [1].", chunks)
    assert [c.source_number for c in citations] == [1, 2]
    assert citations[0].chunk_id == "c1"
    assert citations[0].document_id == "d1"
    assert citations[1].chunk_id == "c2"


def test_parse_citations_empty_when_no_markers():
    chunks = [_chunk("c1", "d1", 0, "alpha")]
    assert parse_citations("No citations here.", chunks) == []


def test_build_context_numbers_sources():
    context = build_context([
        _chunk("c1", "d1", 0, "first source body"),
        _chunk("c2", "d2", 1, "second source body"),
    ])
    assert "[1]" in context
    assert "[2]" in context
    assert "first source body" in context


class _StubRefusalLLM:
    model = "stub-llm"
    last_usage = LLMUsage(prompt_tokens=10, completion_tokens=8, total_tokens=18)

    def __init__(self, response_text: str):
        self._text = response_text

    def complete(self, messages):
        return LLMResult(text=self._text, usage=self.last_usage, model=self.model)

    def stream(self, messages):
        for ch in self._text:
            yield ch


def test_get_refusal_message_matches_query_language():
    assert get_refusal_message("What is the SLA?") == REFUSAL_MESSAGE
    assert get_refusal_message("年假有多少天？") == REFUSAL_MESSAGE_ZH


def test_detect_and_clean_refusal_handles_sentinel_and_fallback_phrases():
    cleaned, refused = detect_and_clean_refusal("[REFUSED] 现有资料未提及年假制度 [1][2]。")
    assert refused is True
    assert not cleaned.startswith("[REFUSED]")
    assert "现有资料未提及年假制度" in cleaned

    _, en_refused = detect_and_clean_refusal(
        "I don't have enough information to answer that [1]."
    )
    assert en_refused is True

    _, normal = detect_and_clean_refusal("Pro 套餐每月 ¥899，包含 5 个座席 [1]。")
    assert normal is False


def test_stream_and_generate_strip_refusal_sentinel_and_clear_citations(monkeypatch):
    from app.rag import answer as answer_mod

    monkeypatch.setattr(
        answer_mod,
        "retrieve",
        lambda *a, **kw: [_chunk("c1", "d1", 0, "unrelated pricing doc")],
    )
    llm = _StubRefusalLLM("[REFUSED] 抱歉，现有资料中没有关于年假的信息 [1]。")

    res = generate_answer(
        None,
        workspace_id="ws",
        knowledge_base_id="kb",
        query="年假有多少天？",
        provider=llm,
    )
    assert res.refused is True
    assert res.citations == []
    assert "[REFUSED]" not in res.answer

    events = list(
        stream_answer_events(
            None,
            workspace_id="ws",
            knowledge_base_id="kb",
            query="年假有多少天？",
            provider=llm,
        )
    )
    streamed_tokens = "".join(p["text"] for name, p in events if name == "token")
    done_payload = [p for name, p in events if name == "done"][0]
    assert "[REFUSED]" not in streamed_tokens
    assert done_payload["refused"] is True
    assert done_payload["citations"] == []
