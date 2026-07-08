from functools import lru_cache
from urllib.parse import quote

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Loads from this service's own .env (services/ai/.env) and process env.
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # POSTGRES_* are the single source of truth for the connection.
    postgres_host: str = "localhost"
    postgres_port: int = 5432
    postgres_db: str = "knowledgeops"
    postgres_user: str = "knowledgeops"
    postgres_password: str = "knowledgeops"

    # Optional explicit override (e.g. managed DB in production).
    database_url_override: str | None = Field(default=None, validation_alias="DATABASE_URL")

    # Redis connection URL (required; supports standalone / Sentinel / managed cloud).
    redis_url: str = "redis://localhost:6379"

    # Embedding dimension; must match the web Drizzle schema.
    embedding_dimensions: int = 1536

    # Worker polling interval in seconds.
    worker_poll_interval: float = 2.0

    # AI provider selector for embeddings. "fake" keeps
    # ingestion/retrieval/evaluation fully offline and deterministic (no API
    # key, no network) so the whole pipeline is testable without credentials.
    # Switch to "openrouter" for real embeddings via OpenRouter.
    ai_provider: str = "fake"

    # Embedding model used when ai_provider != "fake".
    embedding_model: str = "qwen/qwen3-embedding-8b"

    # Max texts per embedding API request when batching.
    embedding_batch_size: int = 64

    # Real embedding call tuning (applies to the openrouter provider).
    embedding_timeout_seconds: float = 60.0
    embedding_max_retries: int = 4

    # Shared local directory that holds uploaded source files. The web layer
    # writes the file and records its location in documents.source_metadata
    # (storage_path); the ingestion pipeline reads it back from here.
    file_storage_dir: str = "./data/uploads"

    # Default chunking parameters (characters). Configurable so Phase 7 can
    # evaluate different chunk sizes without code changes.
    chunk_size: int = 1000
    chunk_overlap: int = 200

    # Shared secret guarding the internal v1 endpoints (X-Internal-Token).
    # Web and AI service must agree on this value. Empty disables the check,
    # which is intended only for local/offline tests.
    internal_api_token: str | None = Field(default=None, validation_alias="INTERNAL_API_TOKEN")

    # ----- Retrieval -----
    # Default number of chunks returned by /v1/retrieve when the caller does
    # not specify top_k. Configurable so Phase 7 can sweep this value.
    retrieval_top_k: int = 5

    # ----- Evaluation -----
    # Optional LLM-as-judge for correctness/groundedness. Off by default so the
    # batch evaluation runs fully offline and deterministically in fake mode;
    # when enabled it refines the deterministic approximations using the
    # configured LLM provider.
    evaluation_use_llm_judge: bool = False

    # ----- Answer / LLM -----
    # LLM provider selector, independent from the embedding provider above.
    # "fake" is a deterministic offline LLM (no key, no network) so the answer
    # path is end-to-end testable; "deepseek" calls the real DeepSeek API.
    llm_provider: str = "fake"

    # Minimum cosine similarity a retrieved chunk must reach for the assistant
    # to answer from it. When no chunk clears this bar the assistant refuses
    # instead of fabricating an answer.
    answer_min_score: float = 0.2

    # DeepSeek is OpenAI-compatible, so the openai SDK is reused with a custom
    # base_url. Keys live in services/ai/.env (never committed).
    deepseek_api_key: str | None = None
    deepseek_model: str = "deepseek-chat"
    deepseek_base_url: str = "https://api.deepseek.com"

    # Real LLM call tuning (applies to the deepseek provider).
    llm_temperature: float = 0.2
    llm_max_tokens: int = 1024
    llm_timeout_seconds: float = 60.0
    llm_max_retries: int = 3

    # OpenRouter is OpenAI-compatible, so the openai SDK is reused with a custom
    # base_url. Used only when ai_provider=openrouter; key lives in
    # services/ai/.env (never committed). qwen/qwen3-embedding-8b is native 4096
    # dims with MRL support: vectors are truncated to embedding_dimensions and
    # L2-normalized to match the fixed vector(1536) schema.
    openrouter_api_key: str | None = None
    openrouter_base_url: str = "https://openrouter.ai/api/v1"

    # AI providers (optional until RAG is implemented).
    openai_api_key: str | None = None
    anthropic_api_key: str | None = None
    google_api_key: str | None = None

    @property
    def database_url(self) -> str:
        if self.database_url_override:
            return self.database_url_override
        password = quote(self.postgres_password, safe="")
        return (
            f"postgresql://{self.postgres_user}:{password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    @property
    def sqlalchemy_url(self) -> str:
        # SQLAlchemy + psycopg3 expects the driver in the scheme.
        url = self.database_url
        if url.startswith("postgresql+"):
            return url
        return url.replace("postgresql://", "postgresql+psycopg://", 1)


@lru_cache
def get_settings() -> Settings:
    return Settings()
