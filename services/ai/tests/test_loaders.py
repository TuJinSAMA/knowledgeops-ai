import pytest

from app.rag.loaders import (
    CorruptDocumentError,
    DocumentNotFoundError,
    EmptyDocumentError,
    UnsupportedMimeTypeError,
    load_document,
)


def make_minimal_pdf(body_text: str) -> bytes:
    """Assemble a minimal, valid single-page PDF containing ``body_text``."""
    content = b"BT /F1 24 Tf 100 700 Td (" + body_text.encode("latin-1") + b") Tj ET"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, obj in enumerate(objects, start=1):
        offsets.append(len(out))
        out += str(i).encode() + b" 0 obj\n" + obj + b"\nendobj\n"
    xref_pos = len(out)
    size = len(objects) + 1
    out += b"xref\n0 " + str(size).encode() + b"\n0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += b"trailer\n<< /Size " + str(size).encode() + b" /Root 1 0 R >>\n"
    out += b"startxref\n" + str(xref_pos).encode() + b"\n%%EOF"
    return bytes(out)


def test_load_markdown(tmp_path):
    path = tmp_path / "doc.md"
    path.write_text("# Title\n\nSome **markdown** body.", encoding="utf-8")
    loaded = load_document(path, "text/markdown")
    assert "markdown" in loaded.text
    assert loaded.mime_type == "text/markdown"


def test_load_plain_text(tmp_path):
    path = tmp_path / "doc.txt"
    path.write_text("plain text content", encoding="utf-8")
    loaded = load_document(path, "text/plain")
    assert loaded.text == "plain text content"


def test_load_pdf(tmp_path):
    path = tmp_path / "doc.pdf"
    path.write_bytes(make_minimal_pdf("Hello World"))
    loaded = load_document(path, "application/pdf")
    assert "Hello" in loaded.text
    assert loaded.metadata["page_count"] == 1
    assert loaded.pages and loaded.pages[0].page_number == 1


def test_missing_file_raises(tmp_path):
    with pytest.raises(DocumentNotFoundError):
        load_document(tmp_path / "nope.txt", "text/plain")


def test_unsupported_mime_raises(tmp_path):
    path = tmp_path / "doc.bin"
    path.write_bytes(b"data")
    with pytest.raises(UnsupportedMimeTypeError):
        load_document(path, "application/octet-stream")


def test_empty_text_file_raises(tmp_path):
    path = tmp_path / "empty.txt"
    path.write_text("   \n  ", encoding="utf-8")
    with pytest.raises(EmptyDocumentError):
        load_document(path, "text/plain")


def test_corrupt_pdf_raises(tmp_path):
    path = tmp_path / "broken.pdf"
    path.write_bytes(b"%PDF-1.4\nthis is not a real pdf body")
    with pytest.raises(CorruptDocumentError):
        load_document(path, "application/pdf")


def test_classifiable_error_reason_codes(tmp_path):
    path = tmp_path / "empty.md"
    path.write_text("", encoding="utf-8")
    try:
        load_document(path, "text/markdown")
    except EmptyDocumentError as exc:
        assert exc.reason == "EMPTY_DOCUMENT"
    else:
        pytest.fail("expected EmptyDocumentError")
