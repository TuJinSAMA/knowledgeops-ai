import logging
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.health import router as health_router
from app.cache import close_redis, init_redis
from app.config import get_settings

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    settings = get_settings()
    await init_redis(settings.redis_url)
    yield
    await close_redis()


app = FastAPI(
    title="Hameo KnowledgeOps AI Service",
    version="0.1.0",
    description=(
        "Single RAG / retrieval / answer + evaluation implementation. "
        "Called in real time by the web app and reused by the worker."
    ),
    lifespan=lifespan,
)

app.include_router(health_router)


@app.get("/")
def root() -> dict[str, str]:
    return {"service": "knowledgeops-ai", "status": "ok"}
