"""Offline unit tests for the answer core: FakeLLM, citation parsing, context."""

from __future__ import annotations

from app.config import get_settings
from app.rag.answer import build_context, build_messages, parse_citations
from app.rag.llm import FakeLLM, get_llm_provider
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
