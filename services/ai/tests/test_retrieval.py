"""Retrieval integration tests (fake embeddings, offline).

Covers the two highest-risk properties: strict tenant/kb isolation and correct
top-k ordering/scores. Skipped when no Postgres+pgvector is reachable.
"""

from __future__ import annotations

import pytest

from app.db import session_scope
from app.rag.retrieval import retrieve
from tests.conftest import first_chunk_content

pytestmark = pytest.mark.usefixtures("require_db")

DOC_A = (
    "# Refund Policy\n\n"
    "Customers may request a refund within 30 days of purchase. "
    + ("Refunds are processed to the original payment method within 5 business days. " * 30)
)
DOC_B = (
    "# Onboarding Checklist\n\n"
    "New engineers should set up their laptop and request repository access. "
    + ("Complete the security training before accessing production systems. " * 30)
)


def test_cross_workspace_returns_empty(ingested_kb_factory):
    a = ingested_kb_factory(DOC_A, slug_hint="wsa")
    b = ingested_kb_factory(DOC_B, slug_hint="wsb")

    with session_scope() as session:
        # kb A belongs to workspace A; querying it under workspace B must be empty.
        results = retrieve(
            session,
            workspace_id=b["workspace_id"],
            knowledge_base_id=a["knowledge_base_id"],
            query="refund policy",
            top_k=5,
        )
    assert results == []


def test_cross_kb_returns_empty(ingested_kb_factory):
    a = ingested_kb_factory(DOC_A, slug_hint="wsa")
    b = ingested_kb_factory(DOC_B, slug_hint="wsb")

    with session_scope() as session:
        # kb B belongs to workspace B; querying it under workspace A must be empty.
        results = retrieve(
            session,
            workspace_id=a["workspace_id"],
            knowledge_base_id=b["knowledge_base_id"],
            query="onboarding",
            top_k=5,
        )
    assert results == []


def test_exact_match_scores_highest(ingested_kb_factory):
    a = ingested_kb_factory(DOC_A, slug_hint="wsa")
    query = first_chunk_content(a["document_id"])

    with session_scope() as session:
        results = retrieve(
            session,
            workspace_id=a["workspace_id"],
            knowledge_base_id=a["knowledge_base_id"],
            query=query,
            top_k=5,
        )

    assert results, "expected at least one hit within the same workspace/kb"
    # The chunk identical to the query embeds to the same vector -> cosine ~1.0.
    assert results[0].score == pytest.approx(1.0, abs=1e-6)
    # Every returned chunk belongs to the queried document.
    assert all(r.document_id == a["document_id"] for r in results)
    # Scores are sorted descending.
    scores = [r.score for r in results]
    assert scores == sorted(scores, reverse=True)


def test_top_k_limits_results(ingested_kb_factory):
    a = ingested_kb_factory(DOC_A, slug_hint="wsa")

    with session_scope() as session:
        results = retrieve(
            session,
            workspace_id=a["workspace_id"],
            knowledge_base_id=a["knowledge_base_id"],
            query="refund",
            top_k=2,
        )
    assert len(results) <= 2


def test_score_threshold_filters(ingested_kb_factory):
    a = ingested_kb_factory(DOC_A, slug_hint="wsa")

    with session_scope() as session:
        # An unrelated query against fake embeddings yields ~0 similarity; a high
        # threshold should filter everything out.
        results = retrieve(
            session,
            workspace_id=a["workspace_id"],
            knowledge_base_id=a["knowledge_base_id"],
            query="completely unrelated quantum gardening topic",
            top_k=5,
            score_threshold=0.5,
        )
    assert results == []
