"""Shared pytest fixtures.

The integration test needs a live Postgres with the pgvector extension and the
project schema applied (run `pnpm db:migrate` from apps/web first). When no DB
is reachable, the integration test is skipped so the pure-function unit tests
still run offline.
"""

from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import text

# Force deterministic offline fake providers during tests even when a developer's
# local services/ai/.env configures real providers (e.g. for manual QA).
os.environ["AI_PROVIDER"] = "fake"
os.environ["LLM_PROVIDER"] = "fake"


def _database_available() -> bool:
    try:
        from app.db import engine

        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
            # Confirm the tables this pipeline writes to exist.
            conn.execute(text("SELECT 1 FROM document_chunks LIMIT 0"))
        return True
    except Exception:  # noqa: BLE001 - any failure means "skip integration"
        return False


@pytest.fixture(scope="session")
def db_available() -> bool:
    return _database_available()


@pytest.fixture
def require_db(db_available: bool) -> None:
    if not db_available:
        pytest.skip("Postgres not reachable / schema not applied; skipping integration test.")


@pytest.fixture
def ingested_kb_factory(tmp_path):
    """Factory that builds a workspace -> kb -> document and ingests it.

    Returns a callable ``make(text, *, slug_hint='ws')`` -> dict with
    ``workspace_id`` / ``knowledge_base_id`` / ``document_id``. Uses the real
    ingestion pipeline (fake embeddings, offline) so retrieved chunks match
    production behavior. All created workspaces are cascade-deleted on teardown.
    """
    from app.db import session_scope
    from app.rag.ingestion import process_ingestion_job

    created_workspaces: list[str] = []

    def make(text_body: str, *, slug_hint: str = "ws") -> dict[str, str]:
        workspace_id = str(uuid.uuid4())
        kb_id = str(uuid.uuid4())
        document_id = str(uuid.uuid4())
        job_id = str(uuid.uuid4())

        source_file = tmp_path / f"{document_id}.md"
        source_file.write_text(text_body, encoding="utf-8")

        with session_scope() as session:
            session.execute(
                text("INSERT INTO workspaces (id, name, slug) VALUES (:id, :name, :slug)"),
                {"id": workspace_id, "name": "Test WS", "slug": f"{slug_hint}-{workspace_id[:8]}"},
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
                    "title": "Doc",
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

        job = {"id": job_id, "document_id": document_id, "payload": {"document_id": document_id}}
        with session_scope() as session:
            process_ingestion_job(session, job)

        created_workspaces.append(workspace_id)
        return {
            "workspace_id": workspace_id,
            "knowledge_base_id": kb_id,
            "document_id": document_id,
        }

    yield make

    with session_scope() as session:
        for workspace_id in created_workspaces:
            session.execute(
                text("DELETE FROM workspaces WHERE id = :id"), {"id": workspace_id}
            )


def first_chunk_content(document_id: str) -> str:
    """Return the content of a document's first chunk (for exact-match queries)."""
    from app.db import session_scope

    with session_scope() as session:
        return session.execute(
            text(
                "SELECT content FROM document_chunks "
                "WHERE document_id = :id ORDER BY chunk_index LIMIT 1"
            ),
            {"id": document_id},
        ).scalar_one()
