"""Unit tests for the deterministic evaluation metrics (no DB, offline)."""

from __future__ import annotations

from app.evaluation import metrics

# ----- retrieval_hit_rate -----


def test_retrieval_hit_rate_none_without_expectations():
    assert metrics.retrieval_hit_rate(["c1"], ["d1"], None, None) is None
    assert metrics.retrieval_hit_rate(["c1"], ["d1"], [], []) is None


def test_retrieval_hit_rate_pools_chunks_and_documents():
    # 1 of 2 expected chunks + 1 of 1 expected doc retrieved -> 2/3.
    score = metrics.retrieval_hit_rate(
        retrieved_chunk_ids=["c1", "c9"],
        retrieved_document_ids=["d1"],
        expected_chunks=["c1", "c2"],
        expected_source_documents=["d1"],
    )
    assert score == round(2 / 3, 4)


def test_retrieval_hit_rate_full_and_zero():
    assert (
        metrics.retrieval_hit_rate(["c1"], ["d1"], ["c1"], ["d1"]) == 1.0
    )
    assert metrics.retrieval_hit_rate([], [], ["c1"], ["d1"]) == 0.0


# ----- citation_accuracy -----


def test_citation_accuracy_none_without_expected_docs():
    assert metrics.citation_accuracy(["d1"], None) is None


def test_citation_accuracy_zero_when_no_citations_but_expected():
    assert metrics.citation_accuracy([], ["d1"]) == 0.0


def test_citation_accuracy_precision():
    # 1 of 2 cited docs are expected -> 0.5.
    assert metrics.citation_accuracy(["d1", "dX"], ["d1", "d2"]) == 0.5
    assert metrics.citation_accuracy(["d1", "d2"], ["d1", "d2"]) == 1.0


# ----- correctness_approx -----


def test_correctness_none_without_signals():
    assert metrics.correctness_approx("anything", None, None) is None
    assert metrics.correctness_approx("anything", "   ", []) is None


def test_correctness_required_facts_coverage():
    answer = "The SLA is one hour for premium customers."
    score = metrics.correctness_approx(answer, None, ["one hour", "premium", "missing"])
    assert score == round(2 / 3, 4)


def test_correctness_expected_answer_overlap():
    score = metrics.correctness_approx(
        "premium customers get one hour support",
        "premium customers receive one hour support sla",
        None,
    )
    # expected content tokens: premium, customers, receive, one, hour, support, sla
    # present in answer: premium, customers, one, hour, support -> 5/7
    assert score == round(5 / 7, 4)


def test_correctness_averages_both_signals():
    # facts: 1/1 = 1.0; overlap partial -> average between.
    score = metrics.correctness_approx(
        "alpha beta",
        "alpha gamma",
        ["alpha"],
    )
    # facts=1.0; overlap: expected {alpha,gamma}, answer {alpha,beta} -> 1/2.
    assert score == round((1.0 + 0.5) / 2, 4)


# ----- groundedness_approx -----


def test_groundedness_none_without_context():
    assert metrics.groundedness_approx("answer", "") is None
    assert metrics.groundedness_approx("answer", None) is None


def test_groundedness_fraction_supported():
    # answer content tokens: premium, support, moon (3); supported: premium, support
    score = metrics.groundedness_approx(
        "premium support moon",
        "premium customers receive support",
    )
    assert score == round(2 / 3, 4)


# ----- estimate_cost -----


def test_estimate_cost_unknown_model_is_none():
    assert metrics.estimate_cost("mystery-model", 100, 100) is None
    assert metrics.estimate_cost(None, 100, 100) is None


def test_estimate_cost_fake_is_zero():
    assert metrics.estimate_cost("fake-llm", 1000, 1000) == 0.0


def test_estimate_cost_deepseek_linear():
    cost = metrics.estimate_cost("deepseek-chat", 1_000_000, 1_000_000)
    assert cost == round(0.27 + 1.10, 6)


def test_estimate_cost_missing_tokens_treated_as_zero():
    assert metrics.estimate_cost("deepseek-chat", None, None) == 0.0


# ----- summarize_results -----


def test_summarize_skips_none_and_aggregates():
    results = [
        {
            "retrieval_hit": 1.0,
            "citation_accuracy": None,
            "correctness": 0.5,
            "groundedness": 0.8,
            "latency_ms": 10,
            "cost_estimate": 0.0,
            "refused": False,
        },
        {
            "retrieval_hit": 0.0,
            "citation_accuracy": 1.0,
            "correctness": None,
            "groundedness": 0.4,
            "latency_ms": 30,
            "cost_estimate": None,
            "refused": True,
        },
    ]
    summary = metrics.summarize_results(results)
    assert summary["case_count"] == 2
    assert summary["retrieval_hit"] == 0.5
    # citation_accuracy averages only the one non-None value.
    assert summary["citation_accuracy"] == 1.0
    assert summary["correctness"] == 0.5
    assert summary["groundedness"] == round((0.8 + 0.4) / 2, 4)
    assert summary["avg_latency_ms"] == 20
    assert summary["total_cost"] == 0.0
    assert summary["refused_count"] == 1


def test_summarize_empty():
    summary = metrics.summarize_results([])
    assert summary["case_count"] == 0
    assert summary["refused_count"] == 0
    assert "retrieval_hit" not in summary
