"""Unit tests for worker job dispatch (no DB required)."""

from __future__ import annotations

import pytest

from app.worker import dispatch as dispatch_module
from app.worker.dispatch import UnknownJobTypeError, dispatch_job


def test_ingest_document_routes_to_ingestion_handler(monkeypatch):
    calls: list[dict] = []
    monkeypatch.setitem(
        dispatch_module.JOB_HANDLERS,
        "INGEST_DOCUMENT",
        lambda _session, job: calls.append(job),
    )

    job = {"id": "1", "job_type": "INGEST_DOCUMENT", "payload": {"document_id": "d1"}}
    dispatch_job(session=None, job=job)

    assert calls == [job]


def test_missing_job_type_falls_back_to_ingest_document(monkeypatch):
    calls: list[dict] = []
    monkeypatch.setitem(
        dispatch_module.JOB_HANDLERS,
        "INGEST_DOCUMENT",
        lambda _session, job: calls.append(job),
    )

    job = {"id": "1", "payload": {"document_id": "d1"}}
    dispatch_job(session=None, job=job)

    assert calls == [job]


def test_run_evaluation_routes_to_evaluation_handler(monkeypatch):
    calls: list[dict] = []
    monkeypatch.setitem(
        dispatch_module.JOB_HANDLERS,
        "RUN_EVALUATION",
        lambda _session, job: calls.append(job),
    )

    job = {"id": "1", "job_type": "RUN_EVALUATION", "payload": {"evaluation_run_id": "r1"}}
    dispatch_job(session=None, job=job)

    assert calls == [job]


def test_unknown_job_type_raises():
    job = {"id": "1", "job_type": "SOMETHING_ELSE", "payload": {}}
    with pytest.raises(UnknownJobTypeError):
        dispatch_job(session=None, job=job)
