"""RUN_EVALUATION job handler (the batch evaluation executor).

Consumes a ``RUN_EVALUATION`` job carrying ``{ evaluation_run_id }`` (see the
queue contract in docs/mvp-plan.md §3.2), then for every case in the run's
dataset reuses the single RAG core (retrieve + answer) under the run's config,
computes deterministic metrics, writes one ``evaluation_results`` row per case,
and aggregates them into ``evaluation_runs.summary_metrics``.

State machine: PENDING -> RUNNING -> COMPLETED | FAILED.

Idempotency: a re-run first deletes this run's existing ``evaluation_results``
so retries never accumulate duplicate rows.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.evaluation import metrics
from app.rag.answer import AnswerResult, generate_answer
from app.rag.llm import LLMProvider, get_llm_provider

logger = logging.getLogger(__name__)


class EvaluationError(Exception):
    """Raised when an evaluation run cannot be executed."""


def run_evaluation_job(session: Session, job: dict[str, Any]) -> None:
    """Execute the batch evaluation referenced by a RUN_EVALUATION job.

    On failure the run is marked FAILED (with ``finished_at``) and the exception
    re-raised so the worker can apply its retry/fail policy.
    """
    settings = get_settings()
    run_id = _extract_run_id(job)

    run = _fetch_run(session, run_id)
    if run is None:
        raise EvaluationError(f"Evaluation run {run_id} not found.")

    workspace_id = str(run["workspace_id"])
    dataset_id = str(run["dataset_id"])
    config = _as_dict(run["config"])

    knowledge_base_id = _resolve_knowledge_base_id(session, dataset_id, config)

    # Mark RUNNING + started_at and clear any prior results in one committed step
    # so the status is visible and re-runs start from a clean slate (idempotent).
    _begin_run(session, run_id)
    session.commit()

    try:
        cases = _fetch_cases(session, dataset_id)
        provider = get_llm_provider(settings)

        results: list[dict[str, Any]] = []
        for case in cases:
            result = _evaluate_case(
                session,
                workspace_id=workspace_id,
                knowledge_base_id=knowledge_base_id,
                case=case,
                config=config,
                settings=settings,
                provider=provider,
            )
            _insert_result(session, run_id, str(case["id"]), result)
            results.append(result)

        summary = metrics.summarize_results(results)
        _complete_run(session, run_id, summary)
        session.commit()
        logger.info(
            "Evaluation run %s completed over %d cases.", run_id, len(results)
        )
    except Exception as exc:
        session.rollback()
        _fail_run(session, run_id)
        session.commit()
        logger.warning("Evaluation run %s failed: %s", run_id, exc)
        raise


def _evaluate_case(
    session: Session,
    *,
    workspace_id: str,
    knowledge_base_id: str,
    case: dict[str, Any],
    config: dict[str, Any],
    settings: Settings,
    provider: LLMProvider,
) -> dict[str, Any]:
    """Run one case through the RAG core and compute its metrics."""
    question = case["question"]
    answer = generate_answer(
        session,
        workspace_id=workspace_id,
        knowledge_base_id=knowledge_base_id,
        query=question,
        config=config,
        settings=settings,
        provider=provider,
    )

    retrieved_chunk_ids = [c.chunk_id for c in answer.retrieved]
    retrieved_document_ids = [c.document_id for c in answer.retrieved]
    cited_document_ids = [c.document_id for c in answer.citations]

    retrieval_hit = metrics.retrieval_hit_rate(
        retrieved_chunk_ids,
        retrieved_document_ids,
        case.get("expected_chunks"),
        case.get("expected_source_documents"),
    )
    citation_acc = metrics.citation_accuracy(
        cited_document_ids,
        case.get("expected_source_documents"),
    )
    correctness = metrics.correctness_approx(
        answer.answer,
        case.get("expected_answer"),
        case.get("required_facts"),
    )
    groundedness = metrics.groundedness_approx(answer.answer, answer.final_context)

    # Optional LLM-as-judge refinement (off by default; deterministic fallback
    # on any failure so fake/offline mode is unaffected).
    if settings.evaluation_use_llm_judge and not answer.refused:
        judged = _llm_judge_scores(
            provider,
            question=question,
            answer=answer.answer,
            context=answer.final_context,
            expected_answer=case.get("expected_answer"),
        )
        if judged is not None:
            judged_correctness, judged_groundedness = judged
            if judged_correctness is not None:
                correctness = judged_correctness
            if judged_groundedness is not None:
                groundedness = judged_groundedness

    usage = answer.usage
    prompt_tokens = usage.prompt_tokens if usage else None
    completion_tokens = usage.completion_tokens if usage else None
    cost = metrics.estimate_cost(answer.model, prompt_tokens, completion_tokens)
    latency_ms = int(round(sum(answer.stage_latency_ms.values())))

    return {
        "retrieval_hit": retrieval_hit,
        "citation_accuracy": citation_acc,
        "correctness": correctness,
        "groundedness": groundedness,
        "latency_ms": latency_ms,
        "cost_estimate": cost,
        "refused": answer.refused,
        "raw": _build_raw_snapshot(answer),
    }


_JUDGE_SYSTEM_PROMPT = (
    "You are a strict evaluation judge. Given a question, a candidate answer, "
    "the supporting context, and optionally a reference answer, rate the "
    "candidate on two axes from 0.0 to 1.0: correctness (does it match the "
    "reference / answer the question) and groundedness (is every claim "
    "supported by the context). Respond with ONLY a JSON object like "
    '{"correctness": 0.8, "groundedness": 0.9}.'
)


def _llm_judge_scores(
    provider: LLMProvider,
    *,
    question: str,
    answer: str,
    context: str,
    expected_answer: str | None,
) -> tuple[float | None, float | None] | None:
    """Ask the LLM provider to score correctness/groundedness in [0, 1].

    Returns ``None`` (so the caller keeps deterministic scores) on any provider
    or parsing failure. This keeps the optional judge from breaking a run.
    """
    user = (
        f"Question:\n{question}\n\n"
        f"Candidate answer:\n{answer}\n\n"
        f"Context:\n{context}\n\n"
        f"Reference answer:\n{expected_answer or '(none provided)'}\n"
    )
    messages = [
        {"role": "system", "content": _JUDGE_SYSTEM_PROMPT},
        {"role": "user", "content": user},
    ]
    try:
        result = provider.complete(messages)
        match = re.search(r"\{.*\}", result.text, re.DOTALL)
        if not match:
            return None
        parsed = json.loads(match.group(0))
    except Exception as exc:  # noqa: BLE001 - judge is best-effort, never fatal
        logger.warning("LLM judge failed; keeping deterministic scores: %s", exc)
        return None

    return _clamp_score(parsed.get("correctness")), _clamp_score(
        parsed.get("groundedness")
    )


def _clamp_score(value: Any) -> float | None:
    try:
        return round(max(0.0, min(1.0, float(value))), 4)
    except (TypeError, ValueError):
        return None


def _build_raw_snapshot(answer: AnswerResult) -> dict[str, Any]:
    """A bounded retrieval/answer snapshot for debugging (stored in raw jsonb)."""
    return {
        "answer": answer.answer,
        "refused": answer.refused,
        "model": answer.model,
        "citations": [c.to_dict() for c in answer.citations],
        "retrieved": [
            {
                "chunk_id": c.chunk_id,
                "document_id": c.document_id,
                "chunk_index": c.chunk_index,
                "score": c.score,
            }
            for c in answer.retrieved
        ],
        "usage": answer.usage.to_dict() if answer.usage else None,
        "stage_latency_ms": answer.stage_latency_ms,
    }


# ----- Job payload / config helpers -----


def _extract_run_id(job: dict[str, Any]) -> str:
    payload = job.get("payload") or {}
    run_id = payload.get("evaluation_run_id") if isinstance(payload, dict) else None
    if not run_id:
        raise EvaluationError("Job payload has no evaluation_run_id.")
    return str(run_id)


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _resolve_knowledge_base_id(
    session: Session, dataset_id: str, config: dict[str, Any]
) -> str:
    """Pick the knowledge base to evaluate against (config overrides dataset)."""
    kb_id = config.get("knowledge_base_id")
    if not kb_id:
        kb_id = session.execute(
            text(
                "SELECT knowledge_base_id FROM evaluation_datasets WHERE id = :id"
            ),
            {"id": dataset_id},
        ).scalar_one_or_none()
    if not kb_id:
        raise EvaluationError(
            "Evaluation requires a knowledge base; dataset has none and config "
            "did not provide knowledge_base_id."
        )
    return str(kb_id)


# ----- DB access -----


def _fetch_run(session: Session, run_id: str) -> dict[str, Any] | None:
    row = (
        session.execute(
            text(
                "SELECT id, workspace_id, dataset_id, config "
                "FROM evaluation_runs WHERE id = :id"
            ),
            {"id": run_id},
        )
        .mappings()
        .first()
    )
    return dict(row) if row is not None else None


def _fetch_cases(session: Session, dataset_id: str) -> list[dict[str, Any]]:
    rows = (
        session.execute(
            text(
                "SELECT id, question, expected_answer, expected_source_documents, "
                "expected_chunks, required_facts, tags "
                "FROM evaluation_cases WHERE dataset_id = :id ORDER BY created_at"
            ),
            {"id": dataset_id},
        )
        .mappings()
        .all()
    )
    return [dict(row) for row in rows]


def _begin_run(session: Session, run_id: str) -> None:
    session.execute(
        text("DELETE FROM evaluation_results WHERE run_id = :id"),
        {"id": run_id},
    )
    session.execute(
        text(
            "UPDATE evaluation_runs SET status = 'RUNNING', started_at = now(), "
            "finished_at = NULL, summary_metrics = NULL WHERE id = :id"
        ),
        {"id": run_id},
    )


def _complete_run(session: Session, run_id: str, summary: dict[str, Any]) -> None:
    session.execute(
        text(
            "UPDATE evaluation_runs SET status = 'COMPLETED', finished_at = now(), "
            "summary_metrics = CAST(:summary AS jsonb) WHERE id = :id"
        ),
        {"summary": json.dumps(summary), "id": run_id},
    )


def _fail_run(session: Session, run_id: str) -> None:
    session.execute(
        text(
            "UPDATE evaluation_runs SET status = 'FAILED', finished_at = now() "
            "WHERE id = :id"
        ),
        {"id": run_id},
    )


_INSERT_RESULT_SQL = text(
    """
    INSERT INTO evaluation_results (
        run_id, case_id, retrieval_hit, citation_accuracy, correctness,
        groundedness, latency_ms, cost_estimate, raw
    ) VALUES (
        :run_id, :case_id, :retrieval_hit, :citation_accuracy, :correctness,
        :groundedness, :latency_ms, :cost_estimate, CAST(:raw AS jsonb)
    )
    """
)


def _insert_result(
    session: Session, run_id: str, case_id: str, result: dict[str, Any]
) -> None:
    session.execute(
        _INSERT_RESULT_SQL,
        {
            "run_id": run_id,
            "case_id": case_id,
            "retrieval_hit": result["retrieval_hit"],
            "citation_accuracy": result["citation_accuracy"],
            "correctness": result["correctness"],
            "groundedness": result["groundedness"],
            "latency_ms": result["latency_ms"],
            "cost_estimate": result["cost_estimate"],
            "raw": json.dumps(result["raw"]),
        },
    )
