# Module 2B Design: Pluggable Reranker, Per-Run LLM Judge & Automated Failure Attribution

- **Date:** 2026-11-06
- **Size:** Core RAG reranking & evaluation diagnostics upgrade across `services/ai` and `apps/web` (no database schema migration required; uses existing `evaluation_runs.config`, `evaluation_runs.summary_metrics`, and `evaluation_results.raw` JSONB columns).

---

## 1. Intent & Why

To complete the transition from a 2023 basic RAG chatbot to a 2026 enterprise RAG quality platform, two capabilities are essential:
1. **Second-stage Reranking (`reranker.py`):** First-stage retrieval (even Hybrid RRF) scores chunks coarsely. A pluggable second-stage reranker (`none` | `heuristic` | `llm`) re-scores the candidate pool before slicing to `top_k`, recording `rerank_score` and `stage_latency_ms["rerank"]`.
2. **Automated Failure Attribution & Per-Run LLM-as-a-Judge (`evaluation/metrics.py`, `evaluation/run.py`):** When an evaluation run finishes, operators shouldn't have to manually guess *why* a case failed. Classifying every case outcome into an actionable root-cause category (`PASS`, `UNEXPECTED_REFUSAL`, `RETRIEVAL_MISS`, `BAD_CITATION`, `HALLUCINATION_RISK`, `INCOMPLETE_ANSWER`) and allowing per-run `useLlmJudge` (with structured `judge_rationale`) turns raw numbers into an actionable diagnostic report.

---

## 2. Goals & Non-Goals

### Goals
- **Pluggable Reranker (`services/ai/app/rag/reranker.py`, `answer.py`, `retrieval.py`):**
  - Add `rerank_chunks(query: str, chunks: list[RetrievedChunk], *, reranker: str | None, top_k: int, provider: LLMProvider | None = None) -> list[RetrievedChunk]`.
  - Support `reranker` modes:
    - `"none"` (or empty): no-op, slices `chunks[:top_k]`.
    - `"heuristic"`: deterministic cross-feature reranker combining exact phrase/bigram proximity, token coverage, and dense similarity to promote chunks where query terms appear contiguously or in high density.
    - `"llm"`: uses the configured LLM provider (or deterministic heuristic fallback when `provider` is `FakeLLM`) to score candidate chunks in `[0, 1]` and re-order them.
  - Record `rerank_score: float | None = None` on `RetrievedChunk` and `stage_latency_ms["rerank"]` in `AnswerResult` when a reranker is active.
  - When a reranker is active in `_plan_answer`, fetch a wider candidate pool (`max(top_k * 3, 12)`) from `retrieve(...)` and pass it through `rerank_chunks(..., top_k=top_k)`.
- **Automated Failure Attribution (`services/ai/app/evaluation/metrics.py`, `evaluation/run.py`):**
  - Implement `classify_case_failure(...) -> str` returning one of:
    - `"UNEXPECTED_REFUSAL"`: `refused is True` when the case expects an answer or required facts / source docs.
    - `"RETRIEVAL_MISS"`: `retrieval_hit is not None and retrieval_hit < 0.5`.
    - `"BAD_CITATION"`: `citation_accuracy is not None and citation_accuracy < 0.5`.
    - `"HALLUCINATION_RISK"`: `groundedness is not None and groundedness < 0.5`.
    - `"INCOMPLETE_ANSWER"`: `correctness is not None and correctness < 0.6`.
    - `"PASS"`: all applicable checks cleared.
  - Store `failure_category` and optional `judge_rationale` in `evaluation_results.raw`, and aggregate `failure_counts: dict[str, int]` in `evaluation_runs.summary_metrics`.
- **Per-Run LLM-as-a-Judge (`services/ai/app/evaluation/run.py`):**
  - Honor `config.get("use_llm_judge")` / `config.get("useLlmJudge")` (falling back to `settings.evaluation_use_llm_judge`).
  - Extend `_llm_judge_scores` to return `(correctness, groundedness, rationale)` from JSON `{"correctness": float, "groundedness": float, "rationale": str}`.
- **Web UI Controls & Diagnostic Report (`TriggerEvaluationRunForm.tsx`, `evaluations/[datasetId]/runs/[runId]/page.tsx`):**
  - Upgrade `reranker` in `TriggerEvaluationRunForm.tsx` to a select dropdown (`none` / `heuristic` / `llm`) and add a `Use LLM-as-a-judge` checkbox (`useLlmJudge`).
  - On the Evaluation Run Detail page (`/evaluations/[datasetId]/runs/[runId]`), display the run-level `failure_counts` breakdown badges and add a **Diagnosis (`诊断结论`)** column + expandable answer/rationale preview on each case row.

### Non-Goals
- External third-party reranker API keys (must work out of the box with existing providers and offline tests).
