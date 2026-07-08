"""Deterministic text chunking.

A lightweight, project-owned recursive splitter (no heavyweight dependency).
It splits text on natural boundaries (paragraphs, lines, sentences, words)
and packs the pieces into chunks no larger than ``chunk_size`` characters,
carrying ``chunk_overlap`` characters of context between adjacent chunks.

Properties this guarantees, because the RAG/evaluation core depends on them:
  - Deterministic & reproducible: same input + params -> identical chunks.
  - Pure function: no I/O, no global state.
  - Configurable size/overlap so Phase 7 can evaluate different chunk sizes.
"""

from __future__ import annotations

from dataclasses import dataclass

# Ordered from coarsest to finest. The empty string is the final fallback and
# forces a hard character split when a single fragment still exceeds the size.
_SEPARATORS: tuple[str, ...] = ("\n\n", "\n", ". ", " ", "")


@dataclass(frozen=True)
class TextChunk:
    """A single chunk: text, its 0-based order index, and an estimated token count."""

    content: str
    index: int
    token_count: int


def estimate_tokens(text: str) -> int:
    """Rough token estimate (~4 characters per token for English-like text).

    This is a heuristic, not a tokenizer; it avoids a heavyweight dependency
    while giving a reasonable figure for cost/length budgeting. At least 1 for
    any non-empty text.
    """
    if not text:
        return 0
    return max(1, round(len(text) / 4))


def chunk_text(
    text: str,
    *,
    chunk_size: int,
    chunk_overlap: int,
) -> list[TextChunk]:
    """Split ``text`` into overlapping chunks of at most ``chunk_size`` chars.

    Returns chunks in document order with contiguous 0-based indices. Returns
    an empty list for empty/whitespace-only input.
    """
    if chunk_size <= 0:
        raise ValueError("chunk_size must be positive")
    if chunk_overlap < 0:
        raise ValueError("chunk_overlap must be non-negative")
    if chunk_overlap >= chunk_size:
        raise ValueError("chunk_overlap must be smaller than chunk_size")

    if not text.strip():
        return []

    fragments = _split_recursive(text, chunk_size, _SEPARATORS)
    merged = _merge_fragments(fragments, chunk_size, chunk_overlap)

    return [
        TextChunk(content=content, index=i, token_count=estimate_tokens(content))
        for i, content in enumerate(merged)
    ]


def _split_recursive(text: str, chunk_size: int, separators: tuple[str, ...]) -> list[str]:
    """Break text into fragments each <= chunk_size using the first usable separator."""
    if len(text) <= chunk_size:
        return [text] if text else []

    separator = separators[0]
    rest = separators[1:]

    if separator == "":
        # Hard split: slice into fixed-size pieces as a last resort.
        return [text[i : i + chunk_size] for i in range(0, len(text), chunk_size)]

    pieces = text.split(separator)
    fragments: list[str] = []
    for i, piece in enumerate(pieces):
        # Re-attach the separator we split on (except after the last piece) so
        # concatenation stays faithful to the original text.
        restored = piece + separator if i < len(pieces) - 1 else piece
        if not restored:
            continue
        if len(restored) <= chunk_size:
            fragments.append(restored)
        else:
            fragments.extend(_split_recursive(restored, chunk_size, rest))
    return fragments


def _merge_fragments(fragments: list[str], chunk_size: int, chunk_overlap: int) -> list[str]:
    """Greedily pack fragments into chunks <= chunk_size, adding overlap context."""
    chunks: list[str] = []
    current = ""

    for fragment in fragments:
        if not current:
            current = fragment
        elif len(current) + len(fragment) <= chunk_size:
            current += fragment
        else:
            chunks.append(current)
            tail = _overlap_tail(current, chunk_overlap)
            current = tail + fragment if len(tail) + len(fragment) <= chunk_size else fragment

    if current:
        chunks.append(current)

    return chunks


def _overlap_tail(text: str, chunk_overlap: int) -> str:
    """Return up to the last ``chunk_overlap`` characters of ``text``."""
    if chunk_overlap <= 0 or not text:
        return ""
    return text[-chunk_overlap:]
