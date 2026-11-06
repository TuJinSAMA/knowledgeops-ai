"""POST /v1/retrieve — tenant/kb-scoped vector retrieval."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.api.internal_auth import require_internal_token
from app.api.v1.schemas import RetrievedChunkModel, RetrieveRequest, RetrieveResponse
from app.config import get_settings
from app.db import session_scope
from app.rag.retrieval import retrieve

router = APIRouter(prefix="/v1", tags=["retrieval"])


@router.post(
    "/retrieve",
    response_model=RetrieveResponse,
    dependencies=[Depends(require_internal_token)],
)
def retrieve_endpoint(body: RetrieveRequest) -> RetrieveResponse:
    settings = get_settings()
    score_threshold = body.config.get("score_threshold") or body.config.get(
        "scoreThreshold"
    )
    retrieval_mode = (
        body.config.get("retrieval_mode")
        or body.config.get("retrievalMode")
        or "hybrid"
    )
    with session_scope() as session:
        chunks = retrieve(
            session,
            workspace_id=body.workspace_id,
            knowledge_base_id=body.knowledge_base_id,
            query=body.query,
            top_k=body.top_k,
            score_threshold=score_threshold,
            retrieval_mode=retrieval_mode,
            settings=settings,
        )
    return RetrieveResponse(
        chunks=[RetrievedChunkModel(**c.to_dict()) for c in chunks]
    )
