"""POST /v1/answer — SSE streaming RAG answer with citations and refusal.

Streams Server-Sent Events:
  - ``event: token`` with ``{"text": "..."}`` for each incremental delta.
  - ``event: done`` with the full answer, citations, usage and trace snapshot.
  - ``event: error`` with ``{"message": "..."}`` if generation fails mid-stream.

The DB session is held open for the whole stream so retrieval and (for real
providers) lazy access stay valid until the final event.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterator

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from app.api.internal_auth import require_internal_token
from app.api.v1.schemas import AnswerRequest
from app.config import get_settings
from app.db import session_scope
from app.rag.answer import stream_answer_events

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1", tags=["answer"])


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _event_stream(body: AnswerRequest) -> Iterator[str]:
    settings = get_settings()
    try:
        with session_scope() as session:
            for event, payload in stream_answer_events(
                session,
                workspace_id=body.workspace_id,
                knowledge_base_id=body.knowledge_base_id,
                query=body.query,
                config=body.config,
                settings=settings,
            ):
                yield _sse(event, payload)
    except Exception as exc:  # noqa: BLE001 - surface as an SSE error event
        logger.exception("Answer streaming failed")
        yield _sse("error", {"message": str(exc)})


@router.post("/answer", dependencies=[Depends(require_internal_token)])
def answer_endpoint(body: AnswerRequest) -> StreamingResponse:
    return StreamingResponse(
        _event_stream(body),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
