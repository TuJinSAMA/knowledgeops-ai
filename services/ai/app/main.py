from fastapi import FastAPI

from app.api.health import router as health_router

app = FastAPI(
    title="Hameo KnowledgeOps AI Service",
    version="0.1.0",
    description=(
        "Single RAG / retrieval / answer + evaluation implementation. "
        "Called in real time by the web app and reused by the worker."
    ),
)

app.include_router(health_router)


@app.get("/")
def root() -> dict[str, str]:
    return {"service": "knowledgeops-ai", "status": "ok"}
