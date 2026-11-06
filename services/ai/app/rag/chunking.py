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

import re
from dataclasses import dataclass

# Ordered from coarsest to finest. The empty string is the final fallback and
# forces a hard character split when a single fragment still exceeds the size.
_SEPARATORS: tuple[str, ...] = ("\n\n", "\n", ". ", " ", "")
_CJK_CHAR_PATTERN = re.compile(r"[\u4e00-\u9fff]")
_HEADING_LINE_PATTERN = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.MULTILINE)


@dataclass(frozen=True)
class TextChunk:
    """A single chunk: text, its 0-based order index, and an estimated token count."""

    content: str
    index: int
    token_count: int


def estimate_tokens(text: str) -> int:
    """Rough token estimate (~1 token per CJK char, ~4 chars per token for ASCII/other).

    This is a heuristic, not a tokenizer; it avoids a heavyweight dependency
    while giving a reasonable figure for cost/length budgeting across both
    English and Chinese text. At least 1 for any non-empty text.
    """
    if not text:
        return 0
    cjk_count = len(_CJK_CHAR_PATTERN.findall(text))
    non_cjk_count = len(text) - cjk_count
    return max(1, cjk_count + round(non_cjk_count / 4))


def chunk_text(
    text: str,
    *,
    chunk_size: int,
    chunk_overlap: int,
    document_title: str | None = None,
) -> list[TextChunk]:
    """Split ``text`` into overlapping chunks of at most ``chunk_size`` chars.

    When ``document_title`` or Markdown headings (``#``..``######``) are present,
    prepends a compact contextual breadcrumb header to chunks so each chunk
    retains its document and section provenance.

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

    title = document_title.strip() if document_title and document_title.strip() else None
    has_headings = bool(_HEADING_LINE_PATTERN.search(text))

    # Reserve space for the contextual header when title/headings are used.
    max_header_reserve = min(chunk_size // 3, 80) if (title or has_headings) else 0
    body_size = max(1, chunk_size - max_header_reserve)
    effective_overlap = min(chunk_overlap, max(0, body_size - 1))

    fragments = _split_recursive(text, body_size, _SEPARATORS)
    merged = _merge_fragments(fragments, body_size, effective_overlap)

    if not title and not has_headings:
        return [
            TextChunk(content=content, index=i, token_count=estimate_tokens(content))
            for i, content in enumerate(merged)
        ]

    enriched = _attach_context_headers(merged, title, chunk_size)
    return [
        TextChunk(content=content, index=i, token_count=estimate_tokens(content))
        for i, content in enumerate(enriched)
    ]


def _attach_context_headers(
    chunks: list[str],
    document_title: str | None,
    chunk_size: int,
) -> list[str]:
    """Track Markdown heading hierarchy across chunks and prepend a context header."""
    heading_stack: dict[int, str] = {}
    out: list[str] = []

    for chunk in chunks:
        # Snapshot active headings at the start of the chunk, and update with any
        # headings that appear inside this chunk.
        for match in _HEADING_LINE_PATTERN.finditer(chunk):
            level = len(match.group(1))
            heading_text = match.group(2).strip()
            heading_stack[level] = heading_text
            for deeper in [k for k in heading_stack if k > level]:
                del heading_stack[deeper]

        breadcrumb = " > ".join(
            heading_stack[k] for k in sorted(heading_stack.keys())
        )
        parts: list[str] = []
        if document_title:
            parts.append(f"Document: {document_title}")
        if breadcrumb:
            parts.append(f"Section: {breadcrumb}")

        if parts:
            header = f"[{' | '.join(parts)}]\n"
            out.append(header + chunk)
        else:
            out.append(chunk)

    return out


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
