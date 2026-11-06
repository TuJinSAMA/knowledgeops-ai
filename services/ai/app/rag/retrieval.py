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

import re
from dataclasses import asdict, dataclass

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.evaluation.metrics import normalize_tokens
from app.rag.embeddings import get_embedding_provider

_LITERAL_TOKEN_PATTERN = re.compile(r"[a-z0-9_.@-]{3,}", re.IGNORECASE)


@dataclass(frozen=True)
class RetrievedChunk:
    """One retrieval hit: the chunk, its source document, and its score."""

    chunk_id: str
    document_id: str
    chunk_index: int
    content: str
    token_count: int | None
    # Calibrated relevance score in [-1, 1]; higher is more relevant (1.0 = identical).
    score: float
    vector_score: float | None = None
    keyword_score: float | None = None

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


_KEYWORD_CANDIDATES_SQL = text(
    """
    SELECT
        dc.id::text          AS chunk_id,
        dc.document_id::text AS document_id,
        dc.chunk_index       AS chunk_index,
        dc.content           AS content,
        dc.token_count       AS token_count
    FROM document_chunks dc
    JOIN documents d        ON d.id = dc.document_id
    JOIN knowledge_bases kb ON kb.id = d.knowledge_base_id
    WHERE kb.workspace_id = :workspace_id
      AND kb.id = :knowledge_base_id
    ORDER BY dc.created_at, dc.chunk_index
    LIMIT :candidate_limit
    """
)


def compute_keyword_score(query: str, content: str) -> float:
    """Compute lexical term & literal coverage of ``query`` in ``content`` in [0, 1]."""
    if not query or not content:
        return 0.0
    q_tokens = normalize_tokens(query)
    literals = {m.lower() for m in _LITERAL_TOKEN_PATTERN.findall(query)}
    all_terms = q_tokens | literals
    if not all_terms:
        return 0.0

    c_tokens = normalize_tokens(content)
    content_lower = content.lower()
    matched = sum(
        1
        for term in all_terms
        if term in c_tokens or (len(term) >= 2 and term in content_lower)
    )
    return round(matched / len(all_terms), 6)


def fuse_hybrid_results(
    vector_hits: list[RetrievedChunk],
    keyword_hits: list[RetrievedChunk],
    *,
    top_k: int,
    rrf_k: int = 60,
) -> list[RetrievedChunk]:
    """Combine vector and keyword hits via Reciprocal Rank Fusion (RRF).

    Preserves a calibrated ``score`` in [-1, 1] (with 1.0 for exact vector+keyword
    matches) while ranking candidates that surface in both branches higher via RRF.
    """
    vec_rank: dict[str, int] = {
        c.chunk_id: idx for idx, c in enumerate(vector_hits, start=1)
    }
    vec_by_id: dict[str, RetrievedChunk] = {c.chunk_id: c for c in vector_hits}

    pos_kw = [c for c in keyword_hits if (c.keyword_score or c.score) > 0]
    kw_rank: dict[str, int] = {
        c.chunk_id: idx for idx, c in enumerate(pos_kw, start=1)
    }
    kw_by_id: dict[str, RetrievedChunk] = {c.chunk_id: c for c in pos_kw}

    all_ids = list(dict.fromkeys([*vec_by_id.keys(), *kw_by_id.keys()]))
    scored: list[tuple[float, float, RetrievedChunk]] = []

    for cid in all_ids:
        v_hit = vec_by_id.get(cid)
        k_hit = kw_by_id.get(cid)
        base = v_hit or k_hit
        assert base is not None

        v_score = (
            v_hit.vector_score
            if v_hit and v_hit.vector_score is not None
            else (v_hit.score if v_hit else None)
        )
        k_score = (
            k_hit.keyword_score
            if k_hit and k_hit.keyword_score is not None
            else (k_hit.score if k_hit else 0.0)
        )

        rrf = 0.0
        if cid in vec_rank:
            rrf += 1.0 / (rrf_k + vec_rank[cid])
        if cid in kw_rank:
            rrf += 1.0 / (rrf_k + kw_rank[cid])

        if v_score is not None and k_score and k_score > 0:
            if v_score >= 0.999999 and k_score >= 0.999999:
                calibrated = 1.0
            else:
                calibrated = min(1.0, max(v_score, 0.75 * v_score + 0.25 * k_score))
        elif v_score is not None:
            calibrated = v_score
        else:
            calibrated = 0.5 * (k_score or 0.0)

        scored.append(
            (
                rrf,
                calibrated,
                RetrievedChunk(
                    chunk_id=base.chunk_id,
                    document_id=base.document_id,
                    chunk_index=base.chunk_index,
                    content=base.content,
                    token_count=base.token_count,
                    score=float(calibrated),
                    vector_score=float(v_score) if v_score is not None else None,
                    keyword_score=float(k_score) if k_score is not None else 0.0,
                ),
            )
        )

    scored.sort(key=lambda item: (item[0], item[1]), reverse=True)
    # Enforce monotonic non-increasing calibrated scores along the RRF order so
    # downstream callers see consistent score ordering.
    results: list[RetrievedChunk] = []
    prev_score: float | None = None
    for _, _, chunk in scored[:top_k]:
        adj_score = (
            min(chunk.score, prev_score)
            if prev_score is not None and chunk.score > prev_score
            else chunk.score
        )
        prev_score = adj_score
        results.append(
            RetrievedChunk(
                chunk_id=chunk.chunk_id,
                document_id=chunk.document_id,
                chunk_index=chunk.chunk_index,
                content=chunk.content,
                token_count=chunk.token_count,
                score=adj_score,
                vector_score=chunk.vector_score,
                keyword_score=chunk.keyword_score,
            )
        )
    return results


def retrieve(
    session: Session,
    *,
    workspace_id: str,
    knowledge_base_id: str,
    query: str,
    top_k: int | None = None,
    score_threshold: float | None = None,
    retrieval_mode: str = "hybrid",
    settings: Settings | None = None,
) -> list[RetrievedChunk]:
    """Return the top-k most relevant chunks for ``query`` within one kb.

    Supports ``retrieval_mode`` in ``{"hybrid", "vector", "keyword"}``.
    Tenant/kb isolation is enforced in SQL, so a cross-workspace or cross-kb
    query returns ``[]``.
    """
    settings = settings or get_settings()
    if not query or not query.strip():
        return []

    effective_top_k = top_k if top_k and top_k > 0 else settings.retrieval_top_k
    mode = (retrieval_mode or "hybrid").strip().lower()
    candidate_pool = max(effective_top_k * 4, 20)

    vector_hits: list[RetrievedChunk] = []
    if mode in ("vector", "hybrid"):
        provider = get_embedding_provider(settings)
        [query_embedding] = provider.embed_texts([query])
        rows = (
            session.execute(
                _RETRIEVE_SQL,
                {
                    "query_embedding": _to_pgvector(query_embedding),
                    "workspace_id": workspace_id,
                    "knowledge_base_id": knowledge_base_id,
                    "top_k": candidate_pool if mode == "hybrid" else effective_top_k,
                },
            )
            .mappings()
            .all()
        )
        vector_hits = [
            RetrievedChunk(
                chunk_id=row["chunk_id"],
                document_id=row["document_id"],
                chunk_index=row["chunk_index"],
                content=row["content"],
                token_count=row["token_count"],
                score=float(row["score"]),
                vector_score=float(row["score"]),
                keyword_score=compute_keyword_score(query, row["content"]),
            )
            for row in rows
        ]

    if mode == "vector":
        chunks = vector_hits[:effective_top_k]
    else:
        kw_rows = (
            session.execute(
                _KEYWORD_CANDIDATES_SQL,
                {
                    "workspace_id": workspace_id,
                    "knowledge_base_id": knowledge_base_id,
                    "candidate_limit": 500,
                },
            )
            .mappings()
            .all()
        )
        keyword_hits = []
        for row in kw_rows:
            kw_score = compute_keyword_score(query, row["content"])
            if kw_score > 0:
                keyword_hits.append(
                    RetrievedChunk(
                        chunk_id=row["chunk_id"],
                        document_id=row["document_id"],
                        chunk_index=row["chunk_index"],
                        content=row["content"],
                        token_count=row["token_count"],
                        score=kw_score,
                        vector_score=None,
                        keyword_score=kw_score,
                    )
                )
        keyword_hits.sort(
            key=lambda c: (c.keyword_score or 0.0, -c.chunk_index), reverse=True
        )

        if mode == "keyword":
            chunks = keyword_hits[:effective_top_k]
        else:
            chunks = fuse_hybrid_results(
                vector_hits,
                keyword_hits[:candidate_pool],
                top_k=effective_top_k,
            )

    if score_threshold is not None:
        chunks = [c for c in chunks if c.score >= score_threshold]

    return chunks


def _to_pgvector(embedding: list[float]) -> str:
    """Format a float vector as a pgvector text literal: ``[v1,v2,...]``."""
    return "[" + ",".join(f"{value:.8g}" for value in embedding) + "]"
