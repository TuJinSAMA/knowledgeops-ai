"""Embedding provider abstraction.

Defines a single interface used by every embedding caller (ingestion now,
retrieval/evaluation later) plus two implementations:

  - FakeEmbeddings: deterministic, offline, no API key. Same text -> same
    vector on every machine and run. Used when AI_PROVIDER=fake (the default)
    so the whole pipeline is testable without credentials or network.
  - OpenRouterEmbeddings: real embeddings via OpenRouter's OpenAI-compatible
    endpoint, with batching and retry/backoff. The model
    ``qwen/qwen3-embedding-8b`` is native 4096 dims and supports MRL
    (Matryoshka), so per the official guidance each returned vector is
    truncated to the first ``settings.embedding_dimensions`` (1536) dims and
    then L2-normalized.

Every provider asserts that returned vectors have exactly
``settings.embedding_dimensions`` (1536) dimensions, matching the pgvector
column and the web Drizzle schema.
"""

from __future__ import annotations

import hashlib
import math
import random
import time
from abc import ABC, abstractmethod

from app.config import Settings, get_settings

# Provider identifiers (AI_PROVIDER values).
PROVIDER_FAKE = "fake"
PROVIDER_OPENROUTER = "openrouter"


class EmbeddingError(Exception):
    """Raised when embeddings cannot be produced or have the wrong shape."""


class EmbeddingProvider(ABC):
    """Interface for turning texts into fixed-dimension embedding vectors."""

    def __init__(self, *, dimensions: int, model: str) -> None:
        self.dimensions = dimensions
        self.model = model

    @abstractmethod
    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        """Embed a batch of texts. Returns one vector per input, in order."""

    def _validate(self, vectors: list[list[float]], expected_count: int) -> None:
        if len(vectors) != expected_count:
            raise EmbeddingError(
                f"Expected {expected_count} embeddings, got {len(vectors)}."
            )
        for vector in vectors:
            if len(vector) != self.dimensions:
                raise EmbeddingError(
                    f"Embedding dimension mismatch: expected {self.dimensions}, "
                    f"got {len(vector)}."
                )


class FakeEmbeddings(EmbeddingProvider):
    """Deterministic offline embeddings derived from a hash of the text.

    A unit-normalized vector is generated from a PRNG seeded by the SHA-256 of
    the input text, so cosine similarity is well-defined and identical inputs
    always map to identical vectors across processes and machines.
    """

    def __init__(self, *, dimensions: int, model: str = "fake-embedding") -> None:
        super().__init__(dimensions=dimensions, model=model)

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        vectors = [self._embed_one(text) for text in texts]
        self._validate(vectors, len(texts))
        return vectors

    def _embed_one(self, text: str) -> list[float]:
        seed = int.from_bytes(hashlib.sha256(text.encode("utf-8")).digest()[:8], "big")
        rng = random.Random(seed)
        values = [rng.uniform(-1.0, 1.0) for _ in range(self.dimensions)]
        norm = math.sqrt(sum(v * v for v in values))
        if norm == 0.0:
            # Degenerate (astronomically unlikely); fall back to a fixed unit vector.
            values[0] = 1.0
            norm = 1.0
        return [v / norm for v in values]


def truncate_and_normalize(vector: list[float], dimensions: int) -> list[float]:
    """Reduce a raw embedding to ``dimensions`` dims, MRL-style.

    ``qwen/qwen3-embedding-8b`` returns native 4096-dim vectors and supports
    Matryoshka Representation Learning, so the official reduction is to keep the
    first ``dimensions`` components and L2-normalize the result. Normalizing
    keeps cosine similarity (the metric our HNSW index uses) well-defined.
    """
    if len(vector) < dimensions:
        raise EmbeddingError(
            f"Embedding has {len(vector)} dims, fewer than the required "
            f"{dimensions}; cannot truncate."
        )
    truncated = vector[:dimensions]
    norm = math.sqrt(sum(v * v for v in truncated))
    if norm == 0.0:
        raise EmbeddingError("Embedding has zero norm after truncation.")
    return [v / norm for v in truncated]


class OpenRouterEmbeddings(EmbeddingProvider):
    """Real embeddings via OpenRouter's OpenAI-compatible endpoint.

    Batches inputs, retries transient failures with exponential backoff, and
    truncates + L2-normalizes each vector to ``dimensions`` (MRL) so the result
    matches the fixed vector(1536) schema.
    """

    def __init__(
        self,
        *,
        dimensions: int,
        model: str,
        api_key: str,
        base_url: str,
        batch_size: int = 64,
        timeout: float = 60.0,
        max_retries: int = 4,
    ) -> None:
        super().__init__(dimensions=dimensions, model=model)
        self._batch_size = max(1, batch_size)
        self._max_retries = max(1, max_retries)
        # Imported lazily so the fake path needs neither the SDK nor a key.
        from openai import OpenAI

        self._client = OpenAI(api_key=api_key, base_url=base_url, timeout=timeout)

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        vectors: list[list[float]] = []
        for start in range(0, len(texts), self._batch_size):
            batch = texts[start : start + self._batch_size]
            vectors.extend(self._embed_batch(batch))
        self._validate(vectors, len(texts))
        return vectors

    def _embed_batch(self, batch: list[str]) -> list[list[float]]:
        last_error: Exception | None = None
        for attempt in range(self._max_retries):
            try:
                response = self._client.embeddings.create(
                    model=self.model,
                    input=batch,
                )
                # API preserves input order via the `index` field.
                ordered = sorted(response.data, key=lambda item: item.index)
                # qwen3-embedding-8b is native 4096 dims (MRL): truncate to the
                # configured dimension and L2-normalize to fit the 1536 schema.
                return [
                    truncate_and_normalize(item.embedding, self.dimensions)
                    for item in ordered
                ]
            except EmbeddingError:
                # Shape/normalization errors are deterministic; do not retry.
                raise
            except Exception as exc:  # noqa: BLE001 - retry transient API failures
                last_error = exc
                if attempt == self._max_retries - 1:
                    break
                # Exponential backoff: 0.5s, 1s, 2s, ...
                time.sleep(0.5 * (2**attempt))
        raise EmbeddingError(
            f"OpenRouter embedding request failed: {last_error}"
        ) from last_error


def get_embedding_provider(settings: Settings | None = None) -> EmbeddingProvider:
    """Build the embedding provider selected by ``settings.ai_provider``."""
    settings = settings or get_settings()
    provider = settings.ai_provider.lower()

    if provider == PROVIDER_FAKE:
        return FakeEmbeddings(dimensions=settings.embedding_dimensions)

    if provider == PROVIDER_OPENROUTER:
        if not settings.openrouter_api_key:
            raise EmbeddingError(
                "AI_PROVIDER=openrouter requires OPENROUTER_API_KEY to be set."
            )
        return OpenRouterEmbeddings(
            dimensions=settings.embedding_dimensions,
            model=settings.embedding_model,
            api_key=settings.openrouter_api_key,
            base_url=settings.openrouter_base_url,
            batch_size=settings.embedding_batch_size,
            timeout=settings.embedding_timeout_seconds,
            max_retries=settings.embedding_max_retries,
        )

    raise EmbeddingError(f"Unknown AI_PROVIDER: {settings.ai_provider!r}")
