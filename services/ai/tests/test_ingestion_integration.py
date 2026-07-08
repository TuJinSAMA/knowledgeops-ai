"""End-to-end ingestion integration test (fake provider, offline).

Builds a minimal knowledge base fixture (workspace -> knowledge_base ->
document + local file + ingestion job), runs process_ingestion_job, and
asserts chunks land with 1536-dim embeddings, the document is INGESTED, and a
re-run is idempotent (no duplicate chunks). Skipped when no DB is reachable.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text

from app.db import session_scope
from app.rag.ingestion import process_ingestion_job
from app.rag.loaders import DocumentNotFoundError

pytestmark = pytest.mark.usefixtures("require_db")

SAMPLE_TEXT = (
    "# Onboarding Guide\n\n"
    "Hameo KnowledgeOps AI helps teams operate trustworthy RAG assistants.\n\n"
    + ("This sentence provides enough body text to produce several chunks. " * 40)
)


@pytest.fixture
def ingestion_fixture(tmp_path):
    """Create the workspace/kb/document/file/job rows; clean up afterwards."""
    workspace_id = str(uuid.uuid4())
    kb_id = str(uuid.uuid4())
    document_id = str(uuid.uuid4())
    job_id = str(uuid.uuid4())

    source_file = tmp_path / "guide.md"
    source_file.write_text(SAMPLE_TEXT, encoding="utf-8")

    with session_scope() as session:
        session.execute(
            text("INSERT INTO workspaces (id, name, slug) VALUES (:id, :name, :slug)"),
            {"id": workspace_id, "name": "Test WS", "slug": f"ws-{workspace_id[:8]}"},
        )
        session.execute(
            text(
                "INSERT INTO knowledge_bases (id, workspace_id, name) "
                "VALUES (:id, :ws, :name)"
            ),
            {"id": kb_id, "ws": workspace_id, "name": "Test KB"},
        )
        session.execute(
            text(
                "INSERT INTO documents (id, knowledge_base_id, title, mime_type, "
                "source_metadata, status) "
                "VALUES (:id, :kb, :title, :mime, CAST(:meta AS jsonb), 'PENDING')"
            ),
            {
                "id": document_id,
                "kb": kb_id,
                "title": "Guide",
                "mime": "text/markdown",
                "meta": f'{{"storage_path": "{source_file}"}}',
            },
        )
        session.execute(
            text(
                "INSERT INTO ingestion_jobs (id, document_id, payload) "
                "VALUES (:id, :doc, CAST(:payload AS jsonb))"
            ),
            {
                "id": job_id,
                "doc": document_id,
                "payload": f'{{"document_id": "{document_id}"}}',
            },
        )

    job = {
        "id": job_id,
        "document_id": document_id,
        "payload": {"document_id": document_id},
        "attempts": 1,
        "max_attempts": 3,
    }

    yield {"workspace_id": workspace_id, "document_id": document_id, "job": job}

    # Cascade-delete the whole fixture via the workspace.
    with session_scope() as session:
        session.execute(
            text("DELETE FROM workspaces WHERE id = :id"), {"id": workspace_id}
        )


def _chunk_stats(document_id: str) -> dict:
    with session_scope() as session:
        rows = (
            session.execute(
                text(
                    "SELECT chunk_index, token_count, vector_dims(embedding) AS dims "
                    "FROM document_chunks WHERE document_id = :id ORDER BY chunk_index"
                ),
                {"id": document_id},
            )
            .mappings()
            .all()
        )
        status = session.execute(
            text("SELECT status FROM documents WHERE id = :id"), {"id": document_id}
        ).scalar_one()
    return {"rows": [dict(r) for r in rows], "status": status}


def test_end_to_end_ingestion_and_idempotency(ingestion_fixture):
    document_id = ingestion_fixture["document_id"]
    job = ingestion_fixture["job"]

    with session_scope() as session:
        process_ingestion_job(session, job)

    first = _chunk_stats(document_id)
    assert first["status"] == "INGESTED"
    assert len(first["rows"]) >= 1
    for row in first["rows"]:
        assert row["dims"] == 1536
        assert row["token_count"] >= 1
    assert [r["chunk_index"] for r in first["rows"]] == list(range(len(first["rows"])))

    # Re-run (simulating a retry) must not create duplicate chunks.
    with session_scope() as session:
        process_ingestion_job(session, job)

    second = _chunk_stats(document_id)
    assert second["status"] == "INGESTED"
    assert len(second["rows"]) == len(first["rows"])


def test_failed_load_marks_document_failed(ingestion_fixture):
    document_id = ingestion_fixture["document_id"]
    job = ingestion_fixture["job"]

    # Point the document at a non-existent file to force a load failure.
    with session_scope() as session:
        session.execute(
            text(
                "UPDATE documents SET source_metadata = "
                "CAST(:meta AS jsonb) WHERE id = :id"
            ),
            {"meta": '{"storage_path": "/nonexistent/missing-file.md"}', "id": document_id},
        )

    with session_scope() as session, pytest.raises(DocumentNotFoundError):
        process_ingestion_job(session, job)

    with session_scope() as session:
        status = session.execute(
            text("SELECT status FROM documents WHERE id = :id"), {"id": document_id}
        ).scalar_one()
    assert status == "FAILED"
