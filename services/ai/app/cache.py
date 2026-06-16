"""
Redis cache utilities for the AI service.

Provides a typed get/set interface for caching expensive operations:
  - embedding vectors (keyed by text + model)
  - LLM responses (keyed by query + config hash)

Keys are always namespaced under `knowledgeops:` to avoid collisions when
sharing a Redis instance. All errors are caught and surfaced as cache misses
so that a Redis outage does not break the request path.
"""

import hashlib
import json
import logging
from collections.abc import Awaitable, Callable
from typing import Any

import redis.asyncio as aioredis

logger = logging.getLogger(__name__)

_redis_client: aioredis.Redis | None = None

KEY_PREFIX = "knowledgeops"

# Default TTLs (seconds).
TTL_EMBEDDING = 60 * 60 * 24 * 7  # 7 days — embeddings rarely change
TTL_LLM_RESPONSE = 60 * 60  # 1 hour — responses may become stale faster


def get_redis() -> aioredis.Redis:
    """Return the shared async Redis client. Must call init_redis() first."""
    if _redis_client is None:
        raise RuntimeError("Redis client has not been initialised. Call init_redis() at startup.")
    return _redis_client


async def init_redis(url: str) -> None:
    """Initialise the async Redis connection pool. Call once at app startup."""
    global _redis_client  # noqa: PLW0603
    _redis_client = aioredis.from_url(
        url,
        encoding="utf-8",
        decode_responses=True,
        socket_connect_timeout=3,
        socket_timeout=3,
    )
    # Eagerly verify connectivity so startup fails fast on misconfiguration.
    await _redis_client.ping()
    logger.info("[redis] connected to %s", url.split("@")[-1])


async def close_redis() -> None:
    """Gracefully close the Redis connection pool at shutdown."""
    global _redis_client  # noqa: PLW0603
    if _redis_client is not None:
        await _redis_client.aclose()
        _redis_client = None
        logger.info("[redis] connection closed")


def _build_key(*parts: str) -> str:
    return f"{KEY_PREFIX}:" + ":".join(parts)


def _hash(*values: Any) -> str:
    """Produce a short stable hash from arbitrary values for use as a cache key."""
    payload = json.dumps(values, sort_keys=True, default=str).encode()
    return hashlib.sha256(payload).hexdigest()[:16]


async def get_cached(key: str) -> str | None:
    """Return a cached string value or None on miss / error."""
    try:
        return await get_redis().get(key)
    except Exception as exc:  # noqa: BLE001
        logger.warning("[cache] get failed for key=%s: %s", key, exc)
        return None


async def set_cached(key: str, value: str, ttl: int) -> None:
    """Write a string value to the cache with the given TTL in seconds."""
    try:
        await get_redis().setex(key, ttl, value)
    except Exception as exc:  # noqa: BLE001
        logger.warning("[cache] set failed for key=%s: %s", key, exc)


async def delete_cached(key: str) -> None:
    """Delete a cached entry (best-effort)."""
    try:
        await get_redis().delete(key)
    except Exception as exc:  # noqa: BLE001
        logger.warning("[cache] delete failed for key=%s: %s", key, exc)


# ---------------------------------------------------------------------------
# Domain-specific cache helpers
# ---------------------------------------------------------------------------


def embedding_cache_key(text: str, model: str) -> str:
    return _build_key("embedding", model, _hash(text))


def llm_response_cache_key(query: str, config: dict[str, Any]) -> str:
    return _build_key("llm", _hash(query, config))


async def get_cached_embedding(text: str, model: str) -> list[float] | None:
    """Return a cached embedding vector or None on miss."""
    key = embedding_cache_key(text, model)
    raw = await get_cached(key)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


async def set_cached_embedding(
    text: str,
    model: str,
    embedding: list[float],
    ttl: int = TTL_EMBEDDING,
) -> None:
    key = embedding_cache_key(text, model)
    await set_cached(key, json.dumps(embedding), ttl)


async def get_cached_llm_response(
    query: str,
    config: dict[str, Any],
) -> dict[str, Any] | None:
    """Return a cached LLM response dict or None on miss."""
    key = llm_response_cache_key(query, config)
    raw = await get_cached(key)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


async def set_cached_llm_response(
    query: str,
    config: dict[str, Any],
    response: dict[str, Any],
    ttl: int = TTL_LLM_RESPONSE,
) -> None:
    key = llm_response_cache_key(query, config)
    await set_cached(key, json.dumps(response), ttl)


async def cached[T](
    key: str,
    fn: Callable[[], Awaitable[T]],
    ttl: int,
    deserialize: Callable[[str], T],
    serialize: Callable[[T], str] = json.dumps,
) -> T:
    """
    Generic cache-aside helper.

    Fetches ``key`` from Redis; on miss calls ``fn()``, caches the result,
    and returns it. Falls back to calling ``fn()`` directly when Redis errors.
    """
    raw = await get_cached(key)
    if raw is not None:
        try:
            return deserialize(raw)
        except Exception:  # noqa: BLE001
            pass  # treat a corrupt cached value as a miss

    value = await fn()
    try:
        await set_cached(key, serialize(value), ttl)
    except Exception:  # noqa: BLE001
        pass
    return value
