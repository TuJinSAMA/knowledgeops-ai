"""Document ingestion pipeline.

Single implementation of: load -> chunk -> embed -> persist document_chunks ->
mark the document INGESTED. Invoked by the background worker for each
INGEST_DOCUMENT job.

Document status machine (kept in step with the job lifecycle):
    PENDING -> PROCESSING -> INGESTED | FAILED

Idempotency: a re-run (retry) deletes the document's existing chunks before
inserting new ones, so retries never leave duplicate chunks. Heavy, failure-
prone work (file read, chunking, embedding) happens before any chunk write,
so a failure cannot leave a half-written chunk set behind.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import get_settings
from app.rag.chunking import chunk_text
from app.rag.embeddings import get_embedding_provider
from app.rag.loaders import DocumentLoadError, load_document

logger = logging.getLogger(__name__)


class IngestionError(Exception):
    """Raised when a job cannot be ingested for a non-loader reason."""


def process_ingestion_job(session: Session, job: dict[str, Any]) -> None:
    """Run the ingestion pipeline for one job.

    ``job`` is the claimed row mapping; the target document id comes from the
    job payload (``payload.document_id``) with a fallback to the legacy
    ``document_id`` column. On failure the document is marked FAILED and the
    exception is re-raised so the worker can apply its retry policy.
    """
    settings = get_settings()
    document_id = _extract_document_id(job)

    document = _fetch_document(session, document_id)
    if document is None:
        raise IngestionError(f"Document {document_id} not found.")

    # Mark PROCESSING in its own transaction so the status is visible while the
    # (potentially slow) work runs and is not rolled back by a later failure.
    _set_document_status(session, document_id, "PROCESSING")
    session.commit()

    try:
        loaded = _load(document, settings.file_storage_dir)
        chunks = chunk_text(
            loaded.text,
            chunk_size=settings.chunk_size,
            chunk_overlap=settings.chunk_overlap,
            document_title=document.get("title"),
        )
        if not chunks:
            raise IngestionError("No chunks produced from document text.")

        provider = get_embedding_provider(settings)
        embeddings = provider.embed_texts([chunk.content for chunk in chunks])

        # Persist atomically: clear old chunks first (idempotent re-run), then
        # bulk insert, then flip status. No failure-prone work in between.
        _replace_chunks(session, document_id, chunks, embeddings)
        _set_document_status(session, document_id, "INGESTED")
        session.commit()
        logger.info("Ingested document %s into %d chunks.", document_id, len(chunks))
    except Exception as exc:
        session.rollback()
        _set_document_status(session, document_id, "FAILED")
        session.commit()
        reason = getattr(exc, "reason", exc.__class__.__name__)
        logger.warning("Ingestion failed for document %s (%s): %s", document_id, reason, exc)
        raise


def _extract_document_id(job: dict[str, Any]) -> str:
    payload = job.get("payload") or {}
    document_id = payload.get("document_id") if isinstance(payload, dict) else None
    document_id = document_id or job.get("document_id")
    if not document_id:
        raise IngestionError("Job has no document_id in payload or column.")
    return str(document_id)


def _fetch_document(session: Session, document_id: str) -> dict[str, Any] | None:
    row = (
        session.execute(
            text(
                "SELECT id, title, mime_type, source_metadata "
                "FROM documents WHERE id = :id"
            ),
            {"id": document_id},
        )
        .mappings()
        .first()
    )
    return dict(row) if row is not None else None


def _load(document: dict[str, Any], storage_root: str):
    metadata = document.get("source_metadata") or {}
    if not isinstance(metadata, dict):
        raise IngestionError("documents.source_metadata is not an object.")

    storage_path = metadata.get("storage_path")
    if not storage_path:
        raise IngestionError("documents.source_metadata.storage_path is missing.")

    file_path = _resolve_storage_path(storage_root, str(storage_path))
    try:
        return load_document(file_path, document["mime_type"])
    except DocumentLoadError:
        raise
    except Exception as exc:  # noqa: BLE001 - normalize unexpected read errors
        raise IngestionError(f"Failed to load document: {exc}") from exc


def _resolve_storage_path(storage_root: str, storage_path: str) -> Path:
    """Resolve a stored path against the storage root, guarding against escape."""
    candidate = Path(storage_path)
    if candidate.is_absolute():
        return candidate

    root = Path(storage_root).resolve()
    resolved = (root / candidate).resolve()
    # Prevent path traversal (e.g. "../../etc/passwd") out of the storage root.
    if root not in resolved.parents and resolved != root:
        raise IngestionError(f"Resolved storage path escapes storage root: {storage_path}")
    return resolved


_INSERT_CHUNK_SQL = text(
    """
    INSERT INTO document_chunks (document_id, chunk_index, content, embedding, token_count)
    VALUES (:document_id, :chunk_index, :content, CAST(:embedding AS vector), :token_count)
    """
)


def _replace_chunks(
    session: Session,
    document_id: str,
    chunks,
    embeddings: list[list[float]],
) -> None:
    session.execute(
        text("DELETE FROM document_chunks WHERE document_id = :id"),
        {"id": document_id},
    )
    rows = [
        {
            "document_id": document_id,
            "chunk_index": chunk.index,
            "content": chunk.content,
            "embedding": _to_pgvector(embedding),
            "token_count": chunk.token_count,
        }
        for chunk, embedding in zip(chunks, embeddings, strict=True)
    ]
    session.execute(_INSERT_CHUNK_SQL, rows)


def _to_pgvector(embedding: list[float]) -> str:
    """Format a float vector as a pgvector text literal: ``[v1,v2,...]``."""
    return "[" + ",".join(f"{value:.8g}" for value in embedding) + "]"


def _set_document_status(session: Session, document_id: str, status: str) -> None:
    session.execute(
        text("UPDATE documents SET status = :status, updated_at = now() WHERE id = :id"),
        {"status": status, "id": document_id},
    )
