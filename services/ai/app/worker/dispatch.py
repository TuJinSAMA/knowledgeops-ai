"""Job dispatch by ``job_type``.

The queue table (``ingestion_jobs``) is generic: each row carries a
``job_type`` and the worker routes it to the matching handler. Type-specific
parameters travel in the job ``payload`` rather than dedicated columns.

Handlers share the signature ``(session, job) -> None`` and raise on failure so
the worker can apply its retry / fail policy uniformly.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from sqlalchemy.orm import Session

from app.evaluation.run import run_evaluation_job
from app.rag.ingestion import process_ingestion_job

JobHandler = Callable[[Session, dict[str, Any]], None]

DEFAULT_JOB_TYPE = "INGEST_DOCUMENT"


class UnknownJobTypeError(Exception):
    """Raised when a job has a ``job_type`` with no registered handler."""


# Registry: job_type -> handler. Add new background task types here.
JOB_HANDLERS: dict[str, JobHandler] = {
    "INGEST_DOCUMENT": process_ingestion_job,
    "RUN_EVALUATION": run_evaluation_job,
}


def dispatch_job(session: Session, job: dict[str, Any]) -> None:
    """Route a claimed job to its handler based on ``job_type``.

    Falls back to ``INGEST_DOCUMENT`` when the column is absent (defensive; the
    schema defaults it NOT NULL). Raises ``UnknownJobTypeError`` for an
    unrecognized type so the worker records it as a failure.
    """
    job_type = job.get("job_type") or DEFAULT_JOB_TYPE
    handler = JOB_HANDLERS.get(job_type)
    if handler is None:
        raise UnknownJobTypeError(f"No handler registered for job_type {job_type!r}.")
    handler(session, job)
