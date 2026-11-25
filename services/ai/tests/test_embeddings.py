import math

import pytest

from app.config import Settings, get_settings
from app.rag.embeddings import (
    EmbeddingError,
    FakeEmbeddings,
    OpenRouterEmbeddings,
    get_embedding_provider,
    truncate_and_normalize,
)

DIM = 1536


def test_fake_embeddings_have_correct_dimension():
    provider = FakeEmbeddings(dimensions=DIM)
    [vector] = provider.embed_texts(["hello"])
    assert len(vector) == DIM


def test_fake_embeddings_are_deterministic():
    provider = FakeEmbeddings(dimensions=DIM)
    first = provider.embed_texts(["the quick brown fox"])
    second = provider.embed_texts(["the quick brown fox"])
    assert first == second


def test_fake_embeddings_differ_per_text():
    provider = FakeEmbeddings(dimensions=DIM)
    a, b = provider.embed_texts(["alpha", "beta"])
    assert a != b


def test_fake_embeddings_are_unit_normalized():
    provider = FakeEmbeddings(dimensions=DIM)
    [vector] = provider.embed_texts(["normalize me"])
    norm = math.sqrt(sum(v * v for v in vector))
    assert math.isclose(norm, 1.0, rel_tol=1e-9)


def test_fake_embeddings_batch_order_preserved():
    provider = FakeEmbeddings(dimensions=DIM)
    texts = ["a", "b", "c"]
    batch = provider.embed_texts(texts)
    assert batch == [provider.embed_texts([t])[0] for t in texts]


def test_dimension_assertion_catches_mismatch():
    provider = FakeEmbeddings(dimensions=4)
    with pytest.raises(EmbeddingError):
        provider._validate([[0.0, 0.0, 0.0]], 1)  # 3 != 4


def test_factory_defaults_to_fake():
    provider = get_embedding_provider(get_settings())
    assert isinstance(provider, FakeEmbeddings)
    assert provider.dimensions == DIM


# ----- truncate_and_normalize (MRL reduction for qwen3-embedding-8b) -----


def test_truncate_keeps_first_n_dims():
    raw = [float(i) for i in range(4096)]  # native qwen dimension
    reduced = truncate_and_normalize(raw, DIM)
    assert len(reduced) == DIM
    # Direction of the first DIM components is preserved (only scaled).
    expected_norm = math.sqrt(sum(float(i) ** 2 for i in range(DIM)))
    assert math.isclose(reduced[3], 3.0 / expected_norm, rel_tol=1e-9)


def test_truncate_result_is_l2_normalized():
    raw = [float(i % 7) - 3 for i in range(4096)]
    reduced = truncate_and_normalize(raw, DIM)
    norm = math.sqrt(sum(v * v for v in reduced))
    assert math.isclose(norm, 1.0, rel_tol=1e-9)


def test_truncate_rejects_too_short_vector():
    with pytest.raises(EmbeddingError):
        truncate_and_normalize([0.1, 0.2, 0.3], DIM)  # 3 < 1536


def test_truncate_rejects_zero_norm():
    with pytest.raises(EmbeddingError):
        truncate_and_normalize([0.0] * (DIM + 100), DIM)


# ----- OpenRouter provider (real path, mocked transport) -----


class _StubEmbeddingItem:
    def __init__(self, index, embedding):
        self.index = index
        self.embedding = embedding


class _StubResponse:
    def __init__(self, data):
        self.data = data


class _StubEmbeddings:
    def __init__(self, recorder):
        self._recorder = recorder

    def create(self, *, model, input):  # noqa: A002 - mirrors OpenAI SDK signature
        self._recorder["model"] = model
        self._recorder["inputs"] = list(input)
        # Return native 4096-dim vectors with index-dependent direction, out of
        # order, to verify reordering and per-vector normalization.
        data = [
            _StubEmbeddingItem(idx, [float((j + idx) % 5) for j in range(4096)])
            for idx in range(len(input))
        ]
        return _StubResponse(list(reversed(data)))


class _StubClient:
    def __init__(self, recorder):
        self.embeddings = _StubEmbeddings(recorder)


def test_openrouter_truncates_normalizes_and_orders(monkeypatch):
    provider = OpenRouterEmbeddings(
        dimensions=DIM,
        model="qwen/qwen3-embedding-8b",
        api_key="test-key",
        base_url="https://openrouter.ai/api/v1",
        batch_size=64,
    )
    recorder: dict = {}
    monkeypatch.setattr(provider, "_client", _StubClient(recorder))

    vectors = provider.embed_texts(["alpha", "beta"])

    assert recorder["model"] == "qwen/qwen3-embedding-8b"
    assert len(vectors) == 2
    for vector in vectors:
        assert len(vector) == DIM
        assert math.isclose(math.sqrt(sum(v * v for v in vector)), 1.0, rel_tol=1e-9)
    # Order is restored from the API `index` field despite reversed response.
    assert vectors[0] != vectors[1]


def test_factory_openrouter_requires_key():
    settings = Settings(ai_provider="openrouter", openrouter_api_key=None)
    with pytest.raises(EmbeddingError):
        get_embedding_provider(settings)


def test_factory_builds_openrouter_when_key_present():
    settings = Settings(ai_provider="openrouter", openrouter_api_key="test-key")
    provider = get_embedding_provider(settings)
    assert isinstance(provider, OpenRouterEmbeddings)
    assert provider.dimensions == DIM
    assert provider.model == "qwen/qwen3-embedding-8b"


def test_openrouter_uses_partial_batch_cache_and_deduplicates(monkeypatch):
    from app.rag import embeddings as emb_mod

    store: dict[str, list[float]] = {}

    def fake_get_cached(texts, *, model, dimensions, redis_url):
        assert redis_url == "redis://test:6379"
        return {
            i: store[t]
            for i, t in enumerate(texts)
            if t in store and len(store[t]) == dimensions
        }

    def fake_set_cached(items, *, model, dimensions, redis_url, ttl=0):
        for text, vec in items:
            store[text] = vec

    monkeypatch.setattr(emb_mod, "get_cached_embeddings_sync", fake_get_cached)
    monkeypatch.setattr(emb_mod, "set_cached_embeddings_sync", fake_set_cached)

    cached_vec = FakeEmbeddings(dimensions=DIM).embed_texts(["cached-doc"])[0]
    store["cached-doc"] = cached_vec

    provider = OpenRouterEmbeddings(
        dimensions=DIM,
        model="qwen/qwen3-embedding-8b",
        api_key="test-key",
        base_url="https://openrouter.ai/api/v1",
        redis_url="redis://test:6379",
    )
    recorder: dict = {}
    monkeypatch.setattr(provider, "_client", _StubClient(recorder))

    vectors = provider.embed_texts(["cached-doc", "fresh-doc", "fresh-doc"])
    assert len(vectors) == 3
    assert vectors[0] == cached_vec
    assert vectors[1] == vectors[2]
    # Only the single unique uncached text hit the upstream API.
    assert recorder["inputs"] == ["fresh-doc"]

    # Second call is 100% served from cache without touching the API.
    recorder.clear()
    second = provider.embed_texts(["cached-doc", "fresh-doc"])
    assert second == [vectors[0], vectors[1]]
    assert "inputs" not in recorder


def test_sync_cache_degrades_gracefully_when_redis_unreachable(monkeypatch):
    from app import cache as cache_mod

    class _BrokenRedis:
        def mget(self, keys):
            raise RuntimeError("redis down")

        def pipeline(self):
            raise RuntimeError("redis down")

    monkeypatch.setattr(cache_mod, "get_sync_redis", lambda url: _BrokenRedis())

    provider = OpenRouterEmbeddings(
        dimensions=DIM,
        model="qwen/qwen3-embedding-8b",
        api_key="test-key",
        base_url="https://openrouter.ai/api/v1",
        redis_url="redis://unreachable:6379",
    )
    recorder: dict = {}
    monkeypatch.setattr(provider, "_client", _StubClient(recorder))

    vectors = provider.embed_texts(["resilient-query"])
    assert len(vectors) == 1
    assert len(vectors[0]) == DIM
    assert recorder["inputs"] == ["resilient-query"]

