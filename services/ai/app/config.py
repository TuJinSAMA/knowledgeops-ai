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
