from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.db import engine

router = APIRouter()


@router.get("/health")
def health() -> JSONResponse:
    checks: dict[str, dict[str, object]] = {}

    try:
        with engine.connect() as conn:
            version = conn.execute(
                text("SELECT extversion FROM pg_extension WHERE extname = 'vector'")
            ).scalar()
        checks["database"] = {"ok": True, "detail": "connected"}
        checks["pgvector"] = (
            {"ok": True, "detail": f"v{version}"}
            if version
            else {"ok": False, "detail": "extension not installed"}
        )
    except Exception as exc:  # noqa: BLE001 - surface any connectivity error
        checks["database"] = {"ok": False, "detail": str(exc)}

    ok = all(c["ok"] for c in checks.values())
    return JSONResponse(
        content={"ok": ok, "checks": checks},
        status_code=200 if ok else 503,
    )
