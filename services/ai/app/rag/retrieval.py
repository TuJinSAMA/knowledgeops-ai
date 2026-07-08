"""Retrieval core (the single RAG retrieval implementation).

Embeds a query and runs a pgvector cosine top-k search over document_chunks,
strictly scoped to one workspace and one knowledge base. The same function is
used by the real-time chat answer path and by future batch evaluation, so the
numbers an evaluation reports always reflect what production actually does.

Tenant isolation is enforced in SQL by joining chunks -> documents ->
knowledge_bases and filtering on both workspace_id and knowledge_base_id, so a
query can never read another workspace's or another knowledge base's chunks.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.rag.embeddings import get_embedding_provider


@dataclass(frozen=True)
class RetrievedChunk:
    """One retrieval hit: the chunk, its source document, and its score."""

    chunk_id: str
    document_id: str
    chunk_index: int
    content: str
    token_count: int | None
    # Cosine similarity in [-1, 1]; higher is more relevant (1.0 = identical).
    score: float

    def to_dict(self) -> dict:
        return asdict(self)


# Cosine distance operator (<=>) ordering; similarity = 1 - distance. Joins up
# to knowledge_bases so both workspace and kb filters apply to every row.
_RETRIEVE_SQL = text(
    """
    SELECT
        dc.id::text          AS chunk_id,
        dc.document_id::text AS document_id,
        dc.chunk_index       AS chunk_index,
        dc.content           AS content,
        dc.token_count       AS token_count,
        1 - (dc.embedding <=> CAST(:query_embedding AS vector)) AS score
    FROM document_chunks dc
    JOIN documents d        ON d.id = dc.document_id
    JOIN knowledge_bases kb ON kb.id = d.knowledge_base_id
    WHERE kb.workspace_id = :workspace_id
      AND kb.id = :knowledge_base_id
      AND dc.embedding IS NOT NULL
    ORDER BY dc.embedding <=> CAST(:query_embedding AS vector)
    LIMIT :top_k
    """
)


def retrieve(
    session: Session,
    *,
    workspace_id: str,
    knowledge_base_id: str,
    query: str,
    top_k: int | None = None,
    score_threshold: float | None = None,
    settings: Settings | None = None,
) -> list[RetrievedChunk]:
    """Return the top-k most similar chunks for ``query`` within one kb.

    Results are ordered by descending cosine similarity. ``score_threshold``,
    when given, drops hits below that similarity. Tenant/kb isolation is
    enforced in SQL, so a cross-workspace or cross-kb query returns ``[]``.
    """
    settings = settings or get_settings()
    if not query or not query.strip():
        return []

    effective_top_k = top_k if top_k and top_k > 0 else settings.retrieval_top_k

    provider = get_embedding_provider(settings)
    [query_embedding] = provider.embed_texts([query])

    rows = (
        session.execute(
            _RETRIEVE_SQL,
            {
                "query_embedding": _to_pgvector(query_embedding),
                "workspace_id": workspace_id,
                "knowledge_base_id": knowledge_base_id,
                "top_k": effective_top_k,
            },
        )
        .mappings()
        .all()
    )

    chunks = [
        RetrievedChunk(
            chunk_id=row["chunk_id"],
            document_id=row["document_id"],
            chunk_index=row["chunk_index"],
            content=row["content"],
            token_count=row["token_count"],
            score=float(row["score"]),
        )
        for row in rows
    ]

    if score_threshold is not None:
        chunks = [c for c in chunks if c.score >= score_threshold]

    return chunks


def _to_pgvector(embedding: list[float]) -> str:
    """Format a float vector as a pgvector text literal: ``[v1,v2,...]``."""
    return "[" + ",".join(f"{value:.8g}" for value in embedding) + "]"
