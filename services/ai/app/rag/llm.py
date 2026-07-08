"""LLM provider abstraction for answer generation.

This switch is deliberately independent from the embedding provider
(``AI_PROVIDER``): embeddings stay on FakeEmbeddings because DeepSeek exposes
no embedding API and the pgvector column is fixed at 1536 dims, while the LLM
can be the real DeepSeek model.

Providers:
  - FakeLLM: deterministic, offline, no key. Produces a grounded-looking answer
    that cites the first available source marker so the answer path (citation
    parsing, refusal, SSE) is fully testable without credentials or network.
  - DeepSeekLLM: real answers via DeepSeek's OpenAI-compatible API, reusing the
    installed ``openai`` SDK with a custom base_url, plus timeout and
    retry/backoff.

Both expose the same interface so the RAG core has a single answer
implementation regardless of provider:
  - ``complete(messages)`` -> full ``LLMResult`` (used by the non-streaming
    core and by future evaluation reuse).
  - ``stream(messages)`` -> iterator of text deltas for SSE; after the iterator
    is exhausted, ``last_usage`` holds the token usage for that call.
"""

from __future__ import annotations

import time
from abc import ABC, abstractmethod
from collections.abc import Iterator
from dataclasses import dataclass

from app.config import Settings, get_settings
from app.rag.chunking import estimate_tokens

PROVIDER_FAKE = "fake"
PROVIDER_DEEPSEEK = "deepseek"

ChatMessage = dict[str, str]


class LLMError(Exception):
    """Raised when an LLM completion cannot be produced."""


@dataclass(frozen=True)
class LLMUsage:
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int

    def to_dict(self) -> dict:
        return {
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": self.total_tokens,
        }


@dataclass(frozen=True)
class LLMResult:
    text: str
    usage: LLMUsage
    model: str


class LLMProvider(ABC):
    """Interface for chat-style text generation."""

    def __init__(self, *, model: str) -> None:
        self.model = model
        # Populated after stream() is consumed so callers can record usage.
        self.last_usage: LLMUsage | None = None

    @abstractmethod
    def complete(self, messages: list[ChatMessage]) -> LLMResult:
        """Return a full completion with token usage."""

    @abstractmethod
    def stream(self, messages: list[ChatMessage]) -> Iterator[str]:
        """Yield text deltas; sets ``last_usage`` once the stream completes."""

    @staticmethod
    def _estimate_usage(messages: list[ChatMessage], completion: str) -> LLMUsage:
        prompt_tokens = sum(estimate_tokens(m.get("content", "")) for m in messages)
        completion_tokens = estimate_tokens(completion)
        return LLMUsage(
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=prompt_tokens + completion_tokens,
        )


class FakeLLM(LLMProvider):
    """Deterministic offline LLM used for tests and no-key environments.

    It produces a short, grounded answer that cites the lowest-numbered source
    marker present in the prompt (always ``[1]`` for our context format), so the
    citation parser has something concrete and reproducible to resolve.
    """

    def __init__(self, *, model: str = "fake-llm") -> None:
        super().__init__(model=model)

    def complete(self, messages: list[ChatMessage]) -> LLMResult:
        text = self._render(messages)
        usage = self._estimate_usage(messages, text)
        self.last_usage = usage
        return LLMResult(text=text, usage=usage, model=self.model)

    def stream(self, messages: list[ChatMessage]) -> Iterator[str]:
        text = self._render(messages)
        self.last_usage = self._estimate_usage(messages, text)
        # Emit word-by-word so the SSE path is exercised deterministically.
        yield from _split_for_stream(text)

    def _render(self, messages: list[ChatMessage]) -> str:
        user = next(
            (m.get("content", "") for m in reversed(messages) if m.get("role") == "user"),
            "",
        )
        source_number = _first_source_number(user)
        return (
            "Based on the provided knowledge base, here is the answer to your "
            f"question. The relevant information is documented in the cited "
            f"source [{source_number}]."
        )


class DeepSeekLLM(LLMProvider):
    """Real answers via DeepSeek's OpenAI-compatible API."""

    def __init__(
        self,
        *,
        model: str,
        api_key: str,
        base_url: str,
        temperature: float = 0.2,
        max_tokens: int = 1024,
        timeout: float = 60.0,
        max_retries: int = 3,
    ) -> None:
        super().__init__(model=model)
        self._temperature = temperature
        self._max_tokens = max_tokens
        self._max_retries = max(1, max_retries)
        # Imported lazily so the fake path needs neither the SDK nor a key.
        from openai import OpenAI

        self._client = OpenAI(api_key=api_key, base_url=base_url, timeout=timeout)

    def complete(self, messages: list[ChatMessage]) -> LLMResult:
        response = self._call(lambda: self._client.chat.completions.create(
            model=self.model,
            messages=messages,
            temperature=self._temperature,
            max_tokens=self._max_tokens,
        ))
        text = response.choices[0].message.content or ""
        usage = self._usage_from_response(response, messages, text)
        self.last_usage = usage
        return LLMResult(text=text, usage=usage, model=self.model)

    def stream(self, messages: list[ChatMessage]) -> Iterator[str]:
        stream = self._call(lambda: self._client.chat.completions.create(
            model=self.model,
            messages=messages,
            temperature=self._temperature,
            max_tokens=self._max_tokens,
            stream=True,
            stream_options={"include_usage": True},
        ))
        parts: list[str] = []
        api_usage = None
        for chunk in stream:
            if chunk.usage is not None:
                api_usage = chunk.usage
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta.content
            if delta:
                parts.append(delta)
                yield delta
        full = "".join(parts)
        if api_usage is not None:
            self.last_usage = LLMUsage(
                prompt_tokens=api_usage.prompt_tokens,
                completion_tokens=api_usage.completion_tokens,
                total_tokens=api_usage.total_tokens,
            )
        else:
            self.last_usage = self._estimate_usage(messages, full)

    def _usage_from_response(self, response, messages, text) -> LLMUsage:
        usage = getattr(response, "usage", None)
        if usage is not None:
            return LLMUsage(
                prompt_tokens=usage.prompt_tokens,
                completion_tokens=usage.completion_tokens,
                total_tokens=usage.total_tokens,
            )
        return self._estimate_usage(messages, text)

    def _call(self, fn):
        last_error: Exception | None = None
        for attempt in range(self._max_retries):
            try:
                return fn()
            except Exception as exc:  # noqa: BLE001 - retry transient API failures
                last_error = exc
                if attempt == self._max_retries - 1:
                    break
                time.sleep(0.5 * (2**attempt))
        raise LLMError(f"DeepSeek request failed: {last_error}") from last_error


def get_llm_provider(settings: Settings | None = None) -> LLMProvider:
    """Build the LLM provider selected by ``settings.llm_provider``."""
    settings = settings or get_settings()
    provider = settings.llm_provider.lower()

    if provider == PROVIDER_FAKE:
        return FakeLLM()

    if provider == PROVIDER_DEEPSEEK:
        if not settings.deepseek_api_key:
            raise LLMError("LLM_PROVIDER=deepseek requires DEEPSEEK_API_KEY to be set.")
        return DeepSeekLLM(
            model=settings.deepseek_model,
            api_key=settings.deepseek_api_key,
            base_url=settings.deepseek_base_url,
            temperature=settings.llm_temperature,
            max_tokens=settings.llm_max_tokens,
            timeout=settings.llm_timeout_seconds,
            max_retries=settings.llm_max_retries,
        )

    raise LLMError(f"Unknown LLM_PROVIDER: {settings.llm_provider!r}")


def _first_source_number(text: str) -> int:
    """Return the lowest source marker number ([n]) in ``text``, or 1."""
    import re

    numbers = [int(m) for m in re.findall(r"\[(\d+)\]", text)]
    return min(numbers) if numbers else 1


def _split_for_stream(text: str) -> list[str]:
    """Split text into space-preserving tokens for deterministic SSE streaming."""
    import re

    return re.findall(r"\S+\s*", text) or ([text] if text else [])
