from __future__ import annotations

from app.rag.answer import generate_answer, normalize_rag_config
from app.rag.llm import FakeLLM
from app.rag.reranker import rerank_chunks
from app.rag.retrieval import RetrievedChunk


def _make_chunk(cid: str, content: str, score: float) -> RetrievedChunk:
    return RetrievedChunk(
        chunk_id=cid,
        document_id="doc-1",
        chunk_index=0,
        content=content,
        token_count=10,
        score=score,
        vector_score=score,
        keyword_score=0.5,
    )


def test_rerank_none_preserves_order_and_slices_top_k():
    chunks = [
        _make_chunk("c1", "alpha", 0.9),
        _make_chunk("c2", "beta", 0.8),
        _make_chunk("c3", "gamma", 0.7),
    ]
    out = rerank_chunks("beta", chunks, reranker="none", top_k=2)
    assert [c.chunk_id for c in out] == ["c1", "c2"]
    assert out[0].rerank_score is None


def test_rerank_heuristic_promotes_exact_phrase_match():
    chunks = [
        _make_chunk("c1", "云席提供丰富的团队协作与工单管理能力。", 0.82),
        _make_chunk(
            "c2",
            "自成功付款之日起 7 天内可申请全额退款，发送邮件至 billing@nimbusdesk.example。",
            0.79,
        ),
    ]
    out = rerank_chunks(
        "7 天内可申请全额退款",
        chunks,
        reranker="heuristic",
        top_k=2,
    )
    assert out[0].chunk_id == "c2"
    assert out[0].rerank_score is not None
    assert out[0].score >= out[1].score


def test_generate_answer_invokes_reranker_and_records_stage_latency(monkeypatch):
    from app.rag import answer as answer_mod

    captured_retrieve = {}

    def fake_retrieve(session, **kwargs):
        captured_retrieve.update(kwargs)
        return [
            _make_chunk("c1", "无关概述内容", 0.81),
            _make_chunk("c2", "Pro 套餐每月 ¥899，包含 5 个座席。", 0.78),
        ]

    monkeypatch.setattr(answer_mod, "retrieve", fake_retrieve)

    cfg = normalize_rag_config({"topK": 1, "reranker": "heuristic"})
    assert cfg["reranker"] == "heuristic"

    res = generate_answer(
        None,
        workspace_id="ws",
        knowledge_base_id="kb",
        query="Pro 套餐包含几个座席？",
        config={"topK": 1, "reranker": "heuristic"},
        provider=FakeLLM(),
    )
    # Candidate pool was expanded before reranking down to topK=1
    assert captured_retrieve["top_k"] >= 3
    assert len(res.retrieved) == 1
    assert res.retrieved[0].chunk_id == "c2"
    assert "rerank" in res.stage_latency_ms
