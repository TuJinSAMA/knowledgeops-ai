"""Answer end-to-end integration tests (fake embeddings + fake LLM, offline).

Verifies the two core guarantees: a grounded answer with checkable citations
when evidence exists, and an explicit refusal (no fabrication) when it doesn't.
Skipped when no Postgres+pgvector is reachable.
"""

from __future__ import annotations

import pytest

from app.db import session_scope
from app.rag.answer import REFUSAL_MESSAGE, generate_answer, stream_answer_events
from tests.conftest import first_chunk_content

pytestmark = pytest.mark.usefixtures("require_db")

DOC = (
    "# Support Policy\n\n"
    "Premium customers receive 24/7 support with a one-hour response SLA. "
    + ("Standard customers receive support during business hours only. " * 30)
)


def test_answer_with_evidence_has_checkable_citations(ingested_kb_factory):
    kb = ingested_kb_factory(DOC, slug_hint="wsa")
    # Use an exact chunk as the query so it embeds to a perfectly-matching vector.
    query = first_chunk_content(kb["document_id"])

    with session_scope() as session:
        result = generate_answer(
            session,
            workspace_id=kb["workspace_id"],
            knowledge_base_id=kb["knowledge_base_id"],
            query=query,
        )

    assert result.refused is False
    assert result.citations, "expected at least one citation"
    retrieved_ids = {c.chunk_id for c in result.retrieved}
    for citation in result.citations:
        assert citation.chunk_id in retrieved_ids
        assert citation.document_id == kb["document_id"]
    assert result.usage is not None
    assert result.usage.total_tokens > 0
    # Trace snapshot for Phase 5 is populated.
    assert result.final_context
    assert "retrieve" in result.stage_latency_ms


def test_answer_refuses_without_evidence(ingested_kb_factory):
    kb = ingested_kb_factory(DOC, slug_hint="wsa")

    with session_scope() as session:
        result = generate_answer(
            session,
            workspace_id=kb["workspace_id"],
            knowledge_base_id=kb["knowledge_base_id"],
            query="What is the airspeed velocity of an unladen swallow?",
        )

    assert result.refused is True
    assert result.answer == REFUSAL_MESSAGE
    assert result.citations == []


def test_answer_refuses_on_empty_cross_tenant(ingested_kb_factory):
    a = ingested_kb_factory(DOC, slug_hint="wsa")
    b = ingested_kb_factory(DOC, slug_hint="wsb")

    with session_scope() as session:
        # kb A under workspace B has no visible chunks -> refusal.
        result = generate_answer(
            session,
            workspace_id=b["workspace_id"],
            knowledge_base_id=a["knowledge_base_id"],
            query=first_chunk_content(a["document_id"]),
        )
    assert result.refused is True
    assert result.answer == REFUSAL_MESSAGE


def test_stream_answer_events_emit_tokens_then_done(ingested_kb_factory):
    kb = ingested_kb_factory(DOC, slug_hint="wsa")
    query = first_chunk_content(kb["document_id"])

    events = []
    with session_scope() as session:
        for event, payload in stream_answer_events(
            session,
            workspace_id=kb["workspace_id"],
            knowledge_base_id=kb["knowledge_base_id"],
            query=query,
        ):
            events.append((event, payload))

    names = [e for e, _ in events]
    assert names[-1] == "done"
    assert "token" in names
    done_payload = events[-1][1]
    streamed = "".join(p["text"] for e, p in events if e == "token")
    assert streamed == done_payload["answer"]
    assert done_payload["refused"] is False
    assert done_payload["citations"]
    assert done_payload["trace"]["final_context"]
