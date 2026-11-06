"""Pluggable second-stage reranker for retrieved chunks.

Supports three modes:
  - ``"none"`` (or empty): no-op, preserves retrieval order and slices ``top_k``.
  - ``"heuristic"``: deterministic cross-feature scorer combining lexical term &
    bigram coverage, contiguous phrase bonus, and first-stage retrieval score.
  - ``"llm"``: uses the configured LLM provider to score candidate relevance in
    ``[0, 1]`` and blends with the heuristic score (falling back deterministically
    when running with ``FakeLLM`` or on any provider/parse error).
"""

from __future__ import annotations

import json
import re
from dataclasses import replace

from app.rag.llm import FakeLLM, LLMProvider
from app.rag.retrieval import RetrievedChunk, compute_keyword_score

_RERANK_SYSTEM_PROMPT = (
    "You are a precision relevance reranker for an enterprise RAG system. "
    "Given a query and numbered candidate passages, score each passage's "
    "relevance to answering the query on a scale from 0.0 to 1.0. "
    'Respond with ONLY a JSON object like {"scores": [0.95, 0.20, ...]}.'
)

_CLEAN_QUERY_PATTERN = re.compile(r"[^\w\u4e00-\u9fff]+")


def _phrase_bonus(query: str, content: str) -> float:
    """Return a contiguous phrase match bonus in [0.0, 1.0]."""
    if not query or not content:
        return 0.0
    q_clean = _CLEAN_QUERY_PATTERN.sub(" ", query.lower()).strip()
    c_lower = content.lower()
    if len(q_clean) >= 3 and q_clean in c_lower:
        return 1.0
    # Check contiguous substrings in whitespace-stripped CJK/mixed text
    compact_q = re.sub(r"\s+", "", q_clean)
    compact_c = re.sub(r"\s+", "", _CLEAN_QUERY_PATTERN.sub(" ", c_lower))
    if len(compact_q) >= 3:
        for window in (6, 4, 3):
            if len(compact_q) >= window:
                for i in range(len(compact_q) - window + 1):
                    sub = compact_q[i : i + window]
                    if sub in compact_c:
                        if window >= 6:
                            return 0.8
                        return 0.6 if window >= 4 else 0.4
    return 0.0


def _heuristic_score(query: str, chunk: RetrievedChunk) -> float:
    kw = compute_keyword_score(query, chunk.content)
    phrase = _phrase_bonus(query, chunk.content)
    base = max(0.0, min(1.0, chunk.score))
    combined = 0.45 * base + 0.35 * kw + 0.20 * phrase
    return round(min(1.0, max(0.0, combined)), 6)


def _llm_scores(
    query: str,
    chunks: list[RetrievedChunk],
    provider: LLMProvider,
) -> list[float] | None:
    if isinstance(provider, FakeLLM) or not chunks:
        return None
    numbered = "\n\n".join(
        f"[{i + 1}] {c.content[:500]}" for i, c in enumerate(chunks)
    )
    messages = [
        {"role": "system", "content": _RERANK_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": f"Query: {query}\n\nCandidates:\n{numbered}",
        },
    ]
    try:
        res = provider.complete(messages)
        match = re.search(r"\{.*\}", res.text, re.DOTALL)
        if not match:
            return None
        parsed = json.loads(match.group(0))
        raw_scores = parsed.get("scores")
        if not isinstance(raw_scores, list) or len(raw_scores) != len(chunks):
            return None
        return [round(max(0.0, min(1.0, float(s))), 6) for s in raw_scores]
    except Exception:  # noqa: BLE001
        return None


def rerank_chunks(
    query: str,
    chunks: list[RetrievedChunk],
    *,
    reranker: str | None,
    top_k: int,
    provider: LLMProvider | None = None,
) -> list[RetrievedChunk]:
    """Re-score and re-order ``chunks`` according to ``reranker``, returning ``top_k``."""
    effective_top_k = max(1, top_k)
    mode = (reranker or "none").strip().lower()
    if mode in ("", "none") or not chunks:
        return list(chunks[:effective_top_k])

    heuristics = [_heuristic_score(query, c) for c in chunks]
    final_scores = heuristics

    if mode == "llm" and provider is not None:
        llm_vals = _llm_scores(query, chunks, provider)
        if llm_vals is not None:
            final_scores = [
                round(0.7 * l_val + 0.3 * h_val, 6)
                for l_val, h_val in zip(llm_vals, heuristics, strict=True)
            ]

    rescored = [
        replace(chunk, score=r_score, rerank_score=r_score)
        for chunk, r_score in zip(chunks, final_scores, strict=True)
    ]
    rescored.sort(
        key=lambda c: (c.rerank_score or 0.0, c.vector_score or 0.0),
        reverse=True,
    )
    return rescored[:effective_top_k]
