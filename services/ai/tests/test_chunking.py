from app.rag.chunking import chunk_text, estimate_tokens


def test_empty_and_whitespace_input_yields_no_chunks():
    assert chunk_text("", chunk_size=100, chunk_overlap=10) == []
    assert chunk_text("   \n\t  ", chunk_size=100, chunk_overlap=10) == []


def test_short_text_is_a_single_chunk():
    chunks = chunk_text("hello world", chunk_size=100, chunk_overlap=10)
    assert len(chunks) == 1
    assert chunks[0].content == "hello world"
    assert chunks[0].index == 0
    assert chunks[0].token_count >= 1


def test_chunks_respect_size_and_are_indexed_in_order():
    text = "word " * 500  # 2500 chars
    chunks = chunk_text(text, chunk_size=200, chunk_overlap=20)
    assert len(chunks) > 1
    assert [c.index for c in chunks] == list(range(len(chunks)))
    for chunk in chunks:
        assert len(chunk.content) <= 200


def test_chunking_is_deterministic():
    text = "Paragraph one.\n\nParagraph two is a bit longer.\n\n" + ("data " * 100)
    a = chunk_text(text, chunk_size=120, chunk_overlap=30)
    b = chunk_text(text, chunk_size=120, chunk_overlap=30)
    assert [c.content for c in a] == [c.content for c in b]


def test_overlap_carries_context_between_chunks():
    text = "abcdefghij " * 50
    chunks = chunk_text(text, chunk_size=100, chunk_overlap=30)
    assert len(chunks) >= 2
    # Consecutive chunks should share some trailing/leading content.
    overlap_found = any(
        chunks[i].content[-10:] in chunks[i + 1].content for i in range(len(chunks) - 1)
    )
    assert overlap_found


def test_very_long_unbroken_token_is_hard_split():
    text = "x" * 1000
    chunks = chunk_text(text, chunk_size=100, chunk_overlap=0)
    assert len(chunks) == 10
    assert all(len(c.content) == 100 for c in chunks)
    assert "".join(c.content for c in chunks) == text


def test_estimate_tokens():
    assert estimate_tokens("") == 0
    assert estimate_tokens("a") == 1
    assert estimate_tokens("a" * 40) == 10


def test_estimate_tokens_counts_cjk_characters():
    # 11 Chinese characters -> 11 tokens (not 11 / 4 = 3)
    assert estimate_tokens("云席客服知识库问答系统") == 11
    # Mixed: 4 Chinese chars (4) + 8 ASCII chars (8 / 4 = 2) -> 6
    assert estimate_tokens("云席产品abcd1234") == 6


def test_invalid_params_raise():
    import pytest

    with pytest.raises(ValueError):
        chunk_text("x", chunk_size=0, chunk_overlap=0)
    with pytest.raises(ValueError):
        chunk_text("x", chunk_size=100, chunk_overlap=100)
    with pytest.raises(ValueError):
        chunk_text("x", chunk_size=100, chunk_overlap=-1)


def test_contextual_chunking_injects_document_and_section_breadcrumb():
    md = (
        "# 退订与退款政策\n\n"
        "## 全额退款窗口\n\n"
        "自成功付款之日起 7 天内，可申请全额退款。\n\n"
        "## 如何申请\n\n"
        "发送邮件至 billing@nimbusdesk.example 申请退款。"
    )
    chunks = chunk_text(
        md,
        chunk_size=90,
        chunk_overlap=0,
        document_title="03-refund-policy.md",
    )
    assert len(chunks) >= 2
    assert all(len(c.content) <= 90 for c in chunks)
    assert any("03-refund-policy.md" in c.content for c in chunks)
    # Later chunk under '## 如何申请' carries the section context
    apply_chunks = [c for c in chunks if "billing@nimbusdesk.example" in c.content]
    assert apply_chunks
    assert "退订与退款政策" in apply_chunks[0].content
