"""Request/response models for the v1 internal API (mvp-plan §3.1)."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class RetrieveRequest(BaseModel):
    workspace_id: str
    knowledge_base_id: str
    query: str
    top_k: int | None = Field(default=None, ge=1, le=100)
    config: dict[str, Any] = Field(default_factory=dict)


class RetrievedChunkModel(BaseModel):
    chunk_id: str
    document_id: str
    chunk_index: int
    content: str
    token_count: int | None
    score: float
    vector_score: float | None = None
    keyword_score: float | None = None
    rerank_score: float | None = None


class RetrieveResponse(BaseModel):
    chunks: list[RetrievedChunkModel]


class AnswerRequest(BaseModel):
    workspace_id: str
    knowledge_base_id: str
    query: str
    config: dict[str, Any] = Field(default_factory=dict)
    conversation_id: str | None = None
    history: list[dict[str, str]] | None = None
