"""Deterministic, reproducible evaluation metrics.

These are pure functions so they are unit-testable offline and produce the same
numbers on every machine (no network, no model calls). Each metric returns a
score in ``[0, 1]`` or ``None`` when the case lacks the ground truth needed to
compute it (e.g. no expected sources for citation accuracy). ``None`` means
"not applicable" and is excluded from run-level averages rather than counted as
zero.

Metric definitions (MVP approximations):
  - retrieval hit rate: fraction of expected chunks/documents that retrieval
    actually surfaced.
  - citation accuracy: of the documents the answer cited, the fraction that are
    expected source documents (citation precision).
  - correctness: deterministic approximation combining required-fact coverage
    (do the must-have facts appear in the answer) and token-overlap recall
    against the expected answer. An optional LLM-as-judge can refine this when
    explicitly enabled (see ``run``); it is off by default so fake mode stays
    end-to-end testable.
  - groundedness: fraction of the answer's content tokens that are supported by
    (appear in) the final retrieval context — a hallucination-risk proxy.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence

# Small stopword set: drop the highest-frequency function words so token-overlap
# metrics reflect content terms rather than grammar. Intentionally minimal and
# fixed so scores stay deterministic.
_STOPWORDS = frozenset(
    {
        "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has",
        "have", "in", "is", "it", "its", "of", "on", "or", "that", "the", "to",
        "was", "were", "will", "with", "this", "these", "those", "their", "they",
    }
)

_TOKEN_PATTERN = re.compile(r"[a-z0-9]+")


def normalize_tokens(value: str | None) -> set[str]:
    """Lowercase, split on word characters, and drop stopwords."""
    if not value:
        return set()
    return {
        token
        for token in _TOKEN_PATTERN.findall(value.lower())
        if token not in _STOPWORDS
    }


def _round(value: float) -> float:
    """Clamp to [0, 1] and round to 4 decimals (matches numeric(6,4))."""
    return round(max(0.0, min(1.0, value)), 4)


def retrieval_hit_rate(
    retrieved_chunk_ids: Iterable[str],
    retrieved_document_ids: Iterable[str],
    expected_chunks: Sequence[str] | None,
    expected_source_documents: Sequence[str] | None,
) -> float | None:
    """Fraction of expected chunks/documents that retrieval surfaced.

    Chunk and document expectations are pooled: the denominator is the count of
    distinct expected ids, the numerator the count actually retrieved. Returns
    ``None`` when the case declares no chunk/document expectations.
    """
    expected_chunk_set = {c for c in (expected_chunks or []) if c}
    expected_doc_set = {d for d in (expected_source_documents or []) if d}
    if not expected_chunk_set and not expected_doc_set:
        return None

    retrieved_chunks = set(retrieved_chunk_ids)
    retrieved_docs = set(retrieved_document_ids)

    total = len(expected_chunk_set) + len(expected_doc_set)
    hits = len(expected_chunk_set & retrieved_chunks) + len(
        expected_doc_set & retrieved_docs
    )
    return _round(hits / total)


def citation_accuracy(
    cited_document_ids: Sequence[str],
    expected_source_documents: Sequence[str] | None,
) -> float | None:
    """Citation precision: cited documents that are expected, over all citations.

    Returns ``None`` when the case declares no expected source documents. When
    expectations exist but the answer cited nothing, returns ``0.0`` (it failed
    to cite the required sources).
    """
    expected_doc_set = {d for d in (expected_source_documents or []) if d}
    if not expected_doc_set:
        return None

    cited = list(cited_document_ids)
    if not cited:
        return 0.0

    correct = sum(1 for doc_id in cited if doc_id in expected_doc_set)
    return _round(correct / len(cited))


def correctness_approx(
    answer: str,
    expected_answer: str | None,
    required_facts: Sequence[str] | None,
) -> float | None:
    """Deterministic correctness approximation.

    Averages whichever signals the case provides:
      - required-fact coverage: fraction of required facts present (case-
        insensitive substring) in the answer.
      - expected-answer overlap: fraction of the expected answer's content
        tokens that appear in the answer (recall).
    Returns ``None`` when the case provides neither expected answer nor facts.
    """
    answer_lower = (answer or "").lower()
    scores: list[float] = []

    facts = [f for f in (required_facts or []) if f and f.strip()]
    if facts:
        present = sum(1 for fact in facts if fact.lower() in answer_lower)
        scores.append(present / len(facts))

    if expected_answer and expected_answer.strip():
        expected_tokens = normalize_tokens(expected_answer)
        if expected_tokens:
            answer_tokens = normalize_tokens(answer)
            overlap = len(expected_tokens & answer_tokens) / len(expected_tokens)
            scores.append(overlap)

    if not scores:
        return None
    return _round(sum(scores) / len(scores))


def groundedness_approx(answer: str, context: str | None) -> float | None:
    """Fraction of the answer's content tokens supported by the context.

    Returns ``None`` when there is no context (e.g. a refusal) or the answer has
    no content tokens — there is nothing to ground.
    """
    if not context or not context.strip():
        return None
    answer_tokens = normalize_tokens(answer)
    if not answer_tokens:
        return None
    context_tokens = normalize_tokens(context)
    grounded = len(answer_tokens & context_tokens) / len(answer_tokens)
    return _round(grounded)


# ----- Cost -----

# Minimal price map (USD per 1M tokens: input, output). Kept in step with the
# web side (apps/web/src/lib/pricing.ts). Unknown models return None rather than
# fabricating a cost; the fake LLM is free.
_PRICE_MAP: dict[str, tuple[float, float]] = {
    "deepseek-chat": (0.27, 1.10),
    "fake-llm": (0.0, 0.0),
}


def estimate_cost(
    model: str | None,
    prompt_tokens: int | None,
    completion_tokens: int | None,
) -> float | None:
    """Estimate USD cost from token usage and a per-model price map.

    Returns ``None`` for an unknown model (do not invent a cost). Missing token
    counts are treated as zero.
    """
    if not model:
        return None
    rates = _PRICE_MAP.get(model)
    if rates is None:
        return None
    input_rate, output_rate = rates
    prompt = max(0, prompt_tokens or 0)
    completion = max(0, completion_tokens or 0)
    cost = prompt / 1_000_000 * input_rate + completion / 1_000_000 * output_rate
    return round(cost, 6)


# ----- Aggregation -----

# Per-case metric keys aggregated into a run summary by simple mean over the
# cases where the metric is applicable (not None).
_AVERAGED_METRICS = (
    "retrieval_hit",
    "citation_accuracy",
    "correctness",
    "groundedness",
)


def summarize_results(results: Sequence[dict]) -> dict:
    """Aggregate per-case metric dicts into a run-level summary.

    Each result dict may carry ``retrieval_hit`` / ``citation_accuracy`` /
    ``correctness`` / ``groundedness`` (float or None), ``latency_ms`` (int),
    ``cost_estimate`` (float or None) and ``refused`` (bool). Averages skip
    ``None`` entries so "not applicable" never drags a score toward zero.
    """
    summary: dict[str, float | int] = {"case_count": len(results)}

    for key in _AVERAGED_METRICS:
        values = [
            r[key]
            for r in results
            if r.get(key) is not None
        ]
        if values:
            summary[key] = round(sum(values) / len(values), 4)

    latencies = [r["latency_ms"] for r in results if r.get("latency_ms") is not None]
    if latencies:
        summary["avg_latency_ms"] = round(sum(latencies) / len(latencies), 2)

    costs = [r["cost_estimate"] for r in results if r.get("cost_estimate") is not None]
    if costs:
        summary["total_cost"] = round(sum(costs), 6)

    summary["refused_count"] = sum(1 for r in results if r.get("refused"))
    return summary
