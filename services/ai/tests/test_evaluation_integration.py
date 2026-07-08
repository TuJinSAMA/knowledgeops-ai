"""End-to-end batch evaluation test (fake embeddings + fake LLM, offline).

Seeds a real knowledge base, an evaluation dataset + cases, an evaluation run
and its RUN_EVALUATION job, runs the worker handler, and asserts that every
case gets an evaluation_results row, the run is COMPLETED with summary_metrics,
and a re-run is idempotent (no duplicate results). Skipped when no
Postgres+pgvector is reachable.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text

from app.db import session_scope
from app.evaluation.run import run_evaluation_job
from tests.conftest import first_chunk_content

pytestmark = pytest.mark.usefixtures("require_db")

DOC = (
    "# Support Policy\n\n"
    "Premium customers receive 24/7 support with a one-hour response SLA. "
    + ("Standard customers receive support during business hours only. " * 30)
)


def _seed_run(kb: dict[str, str]) -> dict[str, str]:
    """Create a dataset + 2 cases + a PENDING run and its RUN_EVALUATION job."""
    workspace_id = kb["workspace_id"]
    document_id = kb["document_id"]
    dataset_id = str(uuid.uuid4())
    run_id = str(uuid.uuid4())
    job_id = str(uuid.uuid4())
    grounded_case_id = str(uuid.uuid4())
    refused_case_id = str(uuid.uuid4())

    grounded_question = first_chunk_content(document_id)

    with session_scope() as session:
        session.execute(
            text(
                "INSERT INTO evaluation_datasets (id, workspace_id, knowledge_base_id, name) "
                "VALUES (:id, :ws, :kb, :name)"
            ),
            {
                "id": dataset_id,
                "ws": workspace_id,
                "kb": kb["knowledge_base_id"],
                "name": "Support eval",
            },
        )
        # Case 1: a question that retrieves evidence -> grounded, cited answer.
        session.execute(
            text(
                "INSERT INTO evaluation_cases (id, dataset_id, question, expected_answer, "
                "expected_source_documents, required_facts) "
                "VALUES (:id, :ds, :q, :ea, CAST(:docs AS jsonb), CAST(:facts AS jsonb))"
            ),
            {
                "id": grounded_case_id,
                "ds": dataset_id,
                "q": grounded_question,
                "ea": "Premium customers receive 24/7 support.",
                "docs": f'["{document_id}"]',
                "facts": '["Premium"]',
            },
        )
        # Case 2: an unrelated question -> refusal, no evidence.
        session.execute(
            text(
                "INSERT INTO evaluation_cases (id, dataset_id, question) "
                "VALUES (:id, :ds, :q)"
            ),
            {
                "id": refused_case_id,
                "ds": dataset_id,
                "q": "What is the airspeed velocity of an unladen swallow?",
            },
        )
        session.execute(
            text(
                "INSERT INTO evaluation_runs (id, workspace_id, dataset_id, config, status) "
                "VALUES (:id, :ws, :ds, CAST(:config AS jsonb), 'PENDING')"
            ),
            {
                "id": run_id,
                "ws": workspace_id,
                "ds": dataset_id,
                "config": '{"top_k": 5}',
            },
        )
        session.execute(
            text(
                "INSERT INTO ingestion_jobs (id, job_type, payload) "
                "VALUES (:id, 'RUN_EVALUATION', CAST(:payload AS jsonb))"
            ),
            {"id": job_id, "payload": f'{{"evaluation_run_id": "{run_id}"}}'},
        )

    return {
        "run_id": run_id,
        "job_id": job_id,
        "dataset_id": dataset_id,
        "grounded_case_id": grounded_case_id,
        "refused_case_id": refused_case_id,
    }


def _run(run_id: str, job_id: str) -> None:
    job = {
        "id": job_id,
        "job_type": "RUN_EVALUATION",
        "payload": {"evaluation_run_id": run_id},
    }
    with session_scope() as session:
        run_evaluation_job(session, job)


def _result_count(run_id: str) -> int:
    with session_scope() as session:
        return session.execute(
            text("SELECT count(*) FROM evaluation_results WHERE run_id = :id"),
            {"id": run_id},
        ).scalar_one()


def test_batch_evaluation_end_to_end(ingested_kb_factory):
    kb = ingested_kb_factory(DOC, slug_hint="wse")
    seeded = _seed_run(kb)
    run_id = seeded["run_id"]

    _run(run_id, seeded["job_id"])

    with session_scope() as session:
        run_row = (
            session.execute(
                text(
                    "SELECT status, summary_metrics, started_at, finished_at "
                    "FROM evaluation_runs WHERE id = :id"
                ),
                {"id": run_id},
            )
            .mappings()
            .one()
        )
        results = (
            session.execute(
                text(
                    "SELECT case_id, retrieval_hit, citation_accuracy, correctness, "
                    "groundedness, latency_ms, raw FROM evaluation_results "
                    "WHERE run_id = :id"
                ),
                {"id": run_id},
            )
            .mappings()
            .all()
        )

    # Every case produced exactly one result.
    assert len(results) == 2
    by_case = {str(r["case_id"]): r for r in results}
    assert seeded["grounded_case_id"] in by_case
    assert seeded["refused_case_id"] in by_case

    # Run completed with aggregated summary metrics.
    assert run_row["status"] == "COMPLETED"
    assert run_row["started_at"] is not None
    assert run_row["finished_at"] is not None
    summary = run_row["summary_metrics"]
    assert summary is not None
    assert summary["case_count"] == 2
    assert "retrieval_hit" in summary
    assert summary["refused_count"] == 1

    # The grounded case retrieved its expected document and cited it.
    grounded = by_case[seeded["grounded_case_id"]]
    assert grounded["raw"]["refused"] is False
    assert float(grounded["retrieval_hit"]) == 1.0
    assert float(grounded["citation_accuracy"]) == 1.0

    # The refused case has no citations and a refusal snapshot.
    refused = by_case[seeded["refused_case_id"]]
    assert refused["raw"]["refused"] is True

    # Re-running is idempotent: still exactly 2 results, no duplicates.
    _run(run_id, seeded["job_id"])
    assert _result_count(run_id) == 2

    with session_scope() as session:
        status = session.execute(
            text("SELECT status FROM evaluation_runs WHERE id = :id"),
            {"id": run_id},
        ).scalar_one()
    assert status == "COMPLETED"
