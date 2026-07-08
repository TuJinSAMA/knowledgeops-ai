"""Internal-token auth tests for the v1 endpoints.

The auth dependency runs before the route body, so a missing/invalid token is
rejected with 401 without ever touching the database. TestClient is used
without its lifespan context so Redis is not required.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app

RETRIEVE_BODY = {
    "workspace_id": "00000000-0000-0000-0000-000000000000",
    "knowledge_base_id": "00000000-0000-0000-0000-000000000000",
    "query": "hello",
}


@pytest.fixture
def token_env(monkeypatch):
    """Configure a shared internal token and reset the settings cache around it."""
    monkeypatch.setenv("INTERNAL_API_TOKEN", "test-secret")
    get_settings.cache_clear()
    yield "test-secret"
    get_settings.cache_clear()


def test_missing_token_returns_401(token_env):
    client = TestClient(app)
    resp = client.post("/v1/retrieve", json=RETRIEVE_BODY)
    assert resp.status_code == 401


def test_wrong_token_returns_401(token_env):
    client = TestClient(app)
    resp = client.post(
        "/v1/retrieve",
        json=RETRIEVE_BODY,
        headers={"X-Internal-Token": "wrong"},
    )
    assert resp.status_code == 401


def test_answer_missing_token_returns_401(token_env):
    client = TestClient(app)
    resp = client.post(
        "/v1/answer",
        json=RETRIEVE_BODY,
    )
    assert resp.status_code == 401
