"""Internal authentication for the v1 endpoints.

The web layer calls the AI service over internal HTTP with a shared secret in
the ``X-Internal-Token`` header (see mvp-plan §3.1). Every v1 route depends on
``require_internal_token``; a missing or mismatched token returns 401.

If ``settings.internal_api_token`` is unset the check is skipped. That is meant
only for local/offline development and tests; production must configure the
token on both sides.
"""

from __future__ import annotations

from fastapi import Header, HTTPException, status

from app.config import get_settings

INTERNAL_TOKEN_HEADER = "X-Internal-Token"


async def require_internal_token(
    x_internal_token: str | None = Header(default=None, alias=INTERNAL_TOKEN_HEADER),
) -> None:
    settings = get_settings()
    expected = settings.internal_api_token
    if not expected:
        # No shared secret configured: allow (local/offline mode).
        return
    if not x_internal_token or x_internal_token != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid internal token.",
        )
