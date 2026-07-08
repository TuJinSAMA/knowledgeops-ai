"""Document loaders.

Read a source file by MIME type and extract plain text. Supported types:
  - text/markdown
  - text/plain
  - application/pdf  (via pypdf)

Page boundaries (PDF) are preserved as character offsets in the returned
metadata so callers can map a position back to a source page later. The
current document_chunks schema has no per-chunk metadata column, so this
information is not persisted yet; it is kept available for future use.

All failures raise a DocumentLoadError subclass carrying a stable ``reason``
code so the ingestion job can classify and record why a document failed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

# MIME types this loader understands.
MIME_MARKDOWN = "text/markdown"
MIME_PLAIN = "text/plain"
MIME_PDF = "application/pdf"

SUPPORTED_MIME_TYPES = frozenset({MIME_MARKDOWN, MIME_PLAIN, MIME_PDF})


class DocumentLoadError(Exception):
    """Base class for classifiable document loading failures.

    ``reason`` is a stable, machine-friendly code suitable for storing in a
    job's last_error or a future failure-classification column.
    """

    reason = "DOCUMENT_LOAD_ERROR"


class DocumentNotFoundError(DocumentLoadError):
    reason = "FILE_NOT_FOUND"


class UnsupportedMimeTypeError(DocumentLoadError):
    reason = "UNSUPPORTED_MIME_TYPE"


class EmptyDocumentError(DocumentLoadError):
    reason = "EMPTY_DOCUMENT"


class CorruptDocumentError(DocumentLoadError):
    reason = "CORRUPT_DOCUMENT"


@dataclass(frozen=True)
class PageSpan:
    """Character range [start, end) of one source page within the full text."""

    page_number: int  # 1-based
    char_start: int
    char_end: int


@dataclass(frozen=True)
class LoadedDocument:
    """Extracted plain text plus structural metadata about the source."""

    text: str
    mime_type: str
    metadata: dict = field(default_factory=dict)
    pages: list[PageSpan] = field(default_factory=list)


def load_document(path: str | Path, mime_type: str) -> LoadedDocument:
    """Load ``path`` and extract plain text according to ``mime_type``.

    Raises a DocumentLoadError subclass on missing files, unsupported types,
    empty content, or corrupt files.
    """
    file_path = Path(path)
    if not file_path.is_file():
        raise DocumentNotFoundError(f"File not found: {file_path}")

    if mime_type == MIME_PDF:
        return _load_pdf(file_path)
    if mime_type in (MIME_MARKDOWN, MIME_PLAIN):
        return _load_text(file_path, mime_type)

    raise UnsupportedMimeTypeError(f"Unsupported MIME type: {mime_type!r}")


def _load_text(file_path: Path, mime_type: str) -> LoadedDocument:
    try:
        raw = file_path.read_bytes()
    except OSError as exc:
        raise CorruptDocumentError(f"Could not read file: {exc}") from exc

    # Decode as UTF-8, tolerating stray bytes rather than failing the whole
    # document. Markdown/plain text are treated identically at this layer.
    text = raw.decode("utf-8", errors="replace")
    if not text.strip():
        raise EmptyDocumentError("Document contains no extractable text.")

    return LoadedDocument(
        text=text,
        mime_type=mime_type,
        metadata={"byte_size": len(raw)},
    )


def _load_pdf(file_path: Path) -> LoadedDocument:
    # Imported lazily so non-PDF ingestion paths don't pay the import cost.
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    try:
        reader = PdfReader(str(file_path))
        raw_pages = [page.extract_text() or "" for page in reader.pages]
    except (PdfReadError, ValueError, OSError) as exc:
        raise CorruptDocumentError(f"Could not parse PDF: {exc}") from exc
    except Exception as exc:  # noqa: BLE001 - pypdf raises assorted error types
        raise CorruptDocumentError(f"Could not parse PDF: {exc}") from exc

    parts: list[str] = []
    pages: list[PageSpan] = []
    cursor = 0
    for index, page_text in enumerate(raw_pages):
        normalized = page_text.strip()
        if not normalized:
            continue
        start = cursor
        parts.append(normalized)
        cursor += len(normalized)
        pages.append(PageSpan(page_number=index + 1, char_start=start, char_end=cursor))
        # Page separator (counts toward the running cursor for the next page).
        parts.append("\n\n")
        cursor += 2

    text = "".join(parts).strip()
    if not text:
        raise EmptyDocumentError("PDF contains no extractable text (scanned or empty).")

    return LoadedDocument(
        text=text,
        mime_type=MIME_PDF,
        metadata={"page_count": len(reader.pages)},
        pages=pages,
    )
