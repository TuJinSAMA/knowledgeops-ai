# Module 2B: Pluggable Reranker, Per-Run LLM Judge & Automated Failure Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add second-stage pluggable reranking (`none` | `heuristic` | `llm`), per-run LLM-as-a-Judge (`useLlmJudge` with `judge_rationale`), and automated per-case failure root-cause classification (`PASS`, `UNEXPECTED_REFUSAL`, `RETRIEVAL_MISS`, `BAD_CITATION`, `HALLUCINATION_RISK`, `INCOMPLETE_ANSWER`) with diagnostic visualization in the Evaluation Run UI.

**Architecture:** `services/ai/app/rag/reranker.py` implements `rerank_chunks` and is invoked inside `_plan_answer` in `answer.py` when `config.reranker` is active (expanding the initial retrieval candidate pool before reranking down to `top_k` and recording `rerank_score` on `RetrievedChunk` and `stage_latency_ms["rerank"]`). `services/ai/app/evaluation/metrics.py` implements `classify_case_failure` and aggregates `failure_counts` in `summarize_results`, while `services/ai/app/evaluation/run.py` honors per-run `useLlmJudge` and records `failure_category` and `judge_rationale` in `evaluation_results.raw`. `apps/web` exposes `reranker` and `useLlmJudge` controls on `TriggerEvaluationRunForm.tsx` and renders run-level failure distribution badges plus per-case diagnosis badges and expandable answer/rationale details on `/[locale]/[workspaceSlug]/evaluations/[datasetId]/runs/[runId]`.

**Tech Stack:** Python 3.12 (FastAPI, SQLAlchemy, Pytest), Next.js 16 (TypeScript, `next-intl`, Vitest).

**Spec:** [`docs/superpowers/specs/2026-11-06-reranker-and-failure-attribution-2b-design.md`](../specs/2026-11-06-reranker-and-failure-attribution-2b-design.md)

## Global Constraints

- Single RAG implementation rule: `_plan_answer` in `services/ai/app/rag/answer.py` must run `rerank_chunks` for both real-time chat (`/v1/answer`) and batch evaluation (`run_evaluation_job`).
- Offline determinism: `FakeLLM` and `heuristic` reranker must run 100% offline with zero network calls; `uv run pytest` and `pnpm --filter @knowledgeops/web test` must pass offline.
- Translation parity: `apps/web/messages/en.json` and `apps/web/messages/zh.json` must remain in 100% key parity.

## Review Focus

- Reranker candidate pool expansion: when `reranker` is `"heuristic"` or `"llm"`, `_plan_answer` must fetch a wider candidate pool (`max(effective_top_k * 3, 12)`) from `retrieve(...)` before `rerank_chunks` slices back to `effective_top_k`; otherwise reranking can only shuffle already-truncated top-k hits.
- Refusal expectation vs. unexpected refusal in `classify_case_failure`: when a case is an intentional refusal test case (no `expected_answer`, no `required_facts`, and no `expected_source_documents`, or `tags` contains `"refuse"`), `refused=True` must be classified as `"PASS"`, whereas `refused=False` on an explicit `"refuse"`-tagged case with no expected facts/docs is `"HALLUCINATION_RISK"` (failed to refuse); conversely, `refused=True` when expectations exist (`expected_answer`, `required_facts`, or `expected_source_documents`) must be classified as `"UNEXPECTED_REFUSAL"`.
- LLM-as-a-Judge failure resilience: if `useLlmJudge` is enabled and the LLM returns malformed JSON or throws, `_llm_judge_scores` must return `None` so `_evaluate_case` keeps its deterministic scores without failing the run.
- `FakeLLM` in `llm` reranker or `useLlmJudge` mode: when `isinstance(provider, FakeLLM)`, `rerank_chunks(..., reranker="llm")` must fall back to the deterministic heuristic scorer rather than parsing `FakeLLM`'s canned answer string.
- Trace & Evaluation raw snapshot compatibility: `RetrievedChunk.rerank_score: float | None = None` must serialize cleanly in `RetrievedChunkModel`, `AnswerResult.to_dict()`, and `_build_raw_snapshot`.

---

### Task 1: Pluggable Second-Stage Reranker (`reranker.py`, `retrieval.py`, `answer.py`)

**Files:**
- Create: `services/ai/app/rag/reranker.py`
- Modify: `services/ai/app/rag/retrieval.py`
- Modify: `services/ai/app/rag/answer.py`
- Modify: `services/ai/app/api/v1/schemas.py`
- Create: `services/ai/tests/test_reranker.py`

**Interfaces:**
- Produces:
  - `RetrievedChunk.rerank_score: float | None = None` in `services/ai/app/rag/retrieval.py`
  - `rerank_chunks(query: str, chunks: list[RetrievedChunk], *, reranker: str | None, top_k: int, provider: LLMProvider | None = None) -> list[RetrievedChunk]` in `services/ai/app/rag/reranker.py`
  - `normalize_rag_config` in `services/ai/app/rag/answer.py` includes `"reranker": str` (`"none"` | `"heuristic"` | `"llm"`)

- [ ] **Step 1: Write failing unit tests in `services/ai/tests/test_reranker.py`**

Create `services/ai/tests/test_reranker.py`:

```python
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
```

- [ ] **Step 2: Run pytest on `tests/test_reranker.py` to verify it fails**

Run: `uv run pytest tests/test_reranker.py -v` (in `services/ai`)
Expected: FAIL (`ModuleNotFoundError: No module named 'app.rag.reranker'`).

- [ ] **Step 3: Implement `services/ai/app/rag/reranker.py` and wire into `retrieval.py`, `answer.py`, and `schemas.py`**

1. In `services/ai/app/rag/retrieval.py`, add `rerank_score: float | None = None` to `RetrievedChunk` and `RetrievedChunkModel` in `services/ai/app/api/v1/schemas.py`.
2. Create `services/ai/app/rag/reranker.py` implementing `rerank_chunks(query, chunks, *, reranker, top_k, provider=None)`:
   - When `reranker` is `None`, `""`, or `"none"`, return `chunks[:top_k]`.
   - Compute a heuristic cross-feature score in `[0, 1]` combining:
     - `compute_keyword_score(query, chunk.content)` (lexical & bigram coverage),
     - contiguous phrase match bonus (`1.0` if normalized query substring >= 3 chars appears verbatim in `chunk.content.lower()`, else longest common contiguous token/bigram run),
     - base retrieval `chunk.score`.
   - When `reranker == "llm"` and `provider is not None` and not `isinstance(provider, FakeLLM)`, prompt the LLM to score each numbered candidate in `[0.0, 1.0]` as JSON `{"scores": [0.9, 0.2, ...]}`, blending with the heuristic score and falling back to the heuristic score on any error.
   - Sort descending by `rerank_score`, slice `[:top_k]`, and return `RetrievedChunk` instances with `score=rerank_score` and `rerank_score=rerank_score`.
3. In `services/ai/app/rag/answer.py`:
   - Include `"reranker": str(raw.get("reranker") or "none").strip().lower()` in `normalize_rag_config`.
   - In `_plan_answer`, when `reranker not in ("", "none")`, call `retrieve(..., top_k=max(effective_top_k * 3, 12))`, then run `rerank_chunks(effective_query, retrieved, reranker=reranker, top_k=effective_top_k, provider=provider)` and record `rerank_latency_ms` (`stage_latencies["rerank"]`).

- [ ] **Step 4: Run pytest across `services/ai` to verify all tests pass**

Run: `uv run pytest -v` (in `services/ai`)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/ai/app/rag/reranker.py services/ai/app/rag/retrieval.py services/ai/app/rag/answer.py services/ai/app/api/v1/schemas.py services/ai/tests/test_reranker.py
git commit -m "feat(ai): add pluggable second-stage reranker with candidate pool expansion"
```

---

### Task 2: Automated Failure Attribution & Per-Run LLM-as-a-Judge (`metrics.py` & `run.py`)

**Files:**
- Modify: `services/ai/app/evaluation/metrics.py`
- Modify: `services/ai/app/evaluation/run.py`
- Test: `services/ai/tests/test_evaluation_metrics.py`
- Test: `services/ai/tests/test_evaluation_integration.py`

**Interfaces:**
- Produces:
  - `classify_case_failure(*, refused: bool, retrieval_hit: float | None, citation_accuracy: float | None, correctness: float | None, groundedness: float | None, has_expectations: bool, expect_refusal: bool = False) -> str` in `services/ai/app/evaluation/metrics.py`
  - `summarize_results(results: Sequence[dict]) -> dict` in `services/ai/app/evaluation/metrics.py` includes `failure_counts: dict[str, int]`
  - `_evaluate_case` in `services/ai/app/evaluation/run.py` honors `config.get("use_llm_judge")` / `config.get("useLlmJudge")` and writes `failure_category` and `judge_rationale` into `raw`

- [ ] **Step 1: Write failing unit tests in `services/ai/tests/test_evaluation_metrics.py`**

Add to `services/ai/tests/test_evaluation_metrics.py`:

```python
def test_classify_case_failure_categories():
    # 1. Expected refusal case that refused -> PASS
    assert (
        metrics.classify_case_failure(
            refused=True,
            retrieval_hit=None,
            citation_accuracy=None,
            correctness=None,
            groundedness=None,
            has_expectations=False,
            expect_refusal=True,
        )
        == "PASS"
    )
    # 2. Expected answer case that refused -> UNEXPECTED_REFUSAL
    assert (
        metrics.classify_case_failure(
            refused=True,
            retrieval_hit=1.0,
            citation_accuracy=0.0,
            correctness=0.0,
            groundedness=None,
            has_expectations=True,
            expect_refusal=False,
        )
        == "UNEXPECTED_REFUSAL"
    )
    # 3. Retrieval miss -> RETRIEVAL_MISS
    assert (
        metrics.classify_case_failure(
            refused=False,
            retrieval_hit=0.0,
            citation_accuracy=0.0,
            correctness=0.2,
            groundedness=0.9,
            has_expectations=True,
        )
        == "RETRIEVAL_MISS"
    )
    # 4. Hallucination risk -> HALLUCINATION_RISK
    assert (
        metrics.classify_case_failure(
            refused=False,
            retrieval_hit=1.0,
            citation_accuracy=1.0,
            correctness=0.8,
            groundedness=0.2,
            has_expectations=True,
        )
        == "HALLUCINATION_RISK"
    )
    # 5. Bad citation -> BAD_CITATION
    assert (
        metrics.classify_case_failure(
            refused=False,
            retrieval_hit=1.0,
            citation_accuracy=0.0,
            correctness=0.9,
            groundedness=0.9,
            has_expectations=True,
        )
        == "BAD_CITATION"
    )
    # 6. Incomplete answer -> INCOMPLETE_ANSWER
    assert (
        metrics.classify_case_failure(
            refused=False,
            retrieval_hit=1.0,
            citation_accuracy=1.0,
            correctness=0.3,
            groundedness=0.9,
            has_expectations=True,
        )
        == "INCOMPLETE_ANSWER"
    )
    # 7. All good -> PASS
    assert (
        metrics.classify_case_failure(
            refused=False,
            retrieval_hit=1.0,
            citation_accuracy=1.0,
            correctness=0.9,
            groundedness=0.9,
            has_expectations=True,
        )
        == "PASS"
    )


def test_summarize_results_aggregates_failure_counts():
    summary = metrics.summarize_results(
        [
            {"retrieval_hit": 1.0, "refused": False, "failure_category": "PASS"},
            {"retrieval_hit": 0.0, "refused": False, "failure_category": "RETRIEVAL_MISS"},
            {"retrieval_hit": 1.0, "refused": False, "failure_category": "PASS"},
        ]
    )
    assert summary["failure_counts"] == {"PASS": 2, "RETRIEVAL_MISS": 1}
```

- [ ] **Step 2: Run pytest on `tests/test_evaluation_metrics.py` to verify it fails**

Run: `uv run pytest tests/test_evaluation_metrics.py -v` (in `services/ai`)
Expected: FAIL (`AttributeError: module 'app.evaluation.metrics' has no attribute 'classify_case_failure'`).

- [ ] **Step 3: Implement `classify_case_failure`, `failure_counts`, and per-run `useLlmJudge` in `metrics.py` and `run.py`**

1. In `services/ai/app/evaluation/metrics.py`:
   - Implement `classify_case_failure(...) -> str`:
     - If `refused`: return `"PASS"` if `expect_refusal or not has_expectations` else `"UNEXPECTED_REFUSAL"`.
     - If `expect_refusal and not has_expectations`: return `"HALLUCINATION_RISK"` (failed to refuse when refusal was expected).
     - If `retrieval_hit is not None and retrieval_hit < 0.5`: return `"RETRIEVAL_MISS"`.
     - If `groundedness is not None and groundedness < 0.5`: return `"HALLUCINATION_RISK"`.
     - If `citation_accuracy is not None and citation_accuracy < 0.5`: return `"BAD_CITATION"`.
     - If `correctness is not None and correctness < 0.6`: return `"INCOMPLETE_ANSWER"`.
     - Return `"PASS"`.
   - In `summarize_results`, count `r.get("failure_category")` (or `r.get("raw", {}).get("failure_category")`) into `summary["failure_counts"] = dict[str, int]` when any result carries a `failure_category`.
2. In `services/ai/app/evaluation/run.py`:
   - Check `use_llm_judge = config.get("use_llm_judge") if config.get("use_llm_judge") is not None else config.get("useLlmJudge")`, falling back to `settings.evaluation_use_llm_judge`.
   - Update `_JUDGE_SYSTEM_PROMPT` and `_llm_judge_scores` to return `(correctness, groundedness, rationale)` (and skip calling the LLM judge when `isinstance(provider, FakeLLM)`).
   - Compute `failure_category = metrics.classify_case_failure(...)` and store both `failure_category` and `judge_rationale` inside `raw` (and `failure_category` on the result dict passed to `summarize_results`).

- [ ] **Step 4: Run pytest across `services/ai` to verify all unit and integration tests pass**

Run: `uv run pytest -v` (in `services/ai`)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/ai/app/evaluation/metrics.py services/ai/app/evaluation/run.py services/ai/tests/test_evaluation_metrics.py
git commit -m "feat(ai): add automated failure attribution and per-run LLM judge rationale"
```

---

### Task 3: Web Evaluation Controls (`reranker` Select & `useLlmJudge`) & Run Diagnostic UI

**Files:**
- Modify: `apps/web/src/lib/evaluation.ts`
- Modify: `apps/web/src/lib/evaluation-actions.ts`
- Modify: `apps/web/src/lib/evaluation-actions.test.ts`
- Modify: `apps/web/src/components/evaluation/TriggerEvaluationRunForm.tsx`
- Modify: `apps/web/src/app/[locale]/[workspaceSlug]/evaluations/[datasetId]/runs/[runId]/page.tsx`
- Modify: `apps/web/messages/en.json`
- Modify: `apps/web/messages/zh.json`

**Interfaces:**
- Consumes: `summary_metrics.failure_counts`, `raw.failure_category`, `raw.answer`, `raw.judge_rationale` from `evaluation_runs` / `evaluation_results`
- Produces:
  - `EvaluationRunConfig.useLlmJudge?: boolean` in `apps/web/src/lib/evaluation.ts`
  - `triggerEvaluationRunAction` parses `useLlmJudge: "on" | "true"` into `config.useLlmJudge = true`
  - `TriggerEvaluationRunForm.tsx` renders a `reranker` select (`none` / `heuristic` / `llm`) and `useLlmJudge` checkbox
  - `evaluations/[datasetId]/runs/[runId]/page.tsx` renders run-level failure distribution badges and per-case diagnosis badges + expandable answer/rationale details

- [ ] **Step 1: Write failing test in `apps/web/src/lib/evaluation-actions.test.ts`**

Update the `triggerEvaluationRunAction` test in `apps/web/src/lib/evaluation-actions.test.ts` to pass `reranker: "heuristic"` and `useLlmJudge: "on"` and assert `createEvaluationRunMock` receives `reranker: "heuristic"` and `useLlmJudge: true`.

- [ ] **Step 2: Run Vitest on `src/lib/evaluation-actions.test.ts` to verify it fails**

Run: `pnpm --filter @knowledgeops/web test src/lib/evaluation-actions.test.ts`
Expected: FAIL (`useLlmJudge: true` missing from `config`).

- [ ] **Step 3: Implement `useLlmJudge` parsing, `TriggerEvaluationRunForm` controls, and Run Detail diagnostic UI**

1. In `apps/web/src/lib/evaluation.ts` and `apps/web/src/lib/evaluation-actions.ts`, add `useLlmJudge?: boolean` to `EvaluationRunConfig` and parse `formData.get("useLlmJudge")` (`"on"` or `"true"` -> `config.useLlmJudge = true`).
2. In `apps/web/src/components/evaluation/TriggerEvaluationRunForm.tsx`, replace the free-text `reranker` input with a `<select>` (`none`, `heuristic`, `llm`) and add a `<input type="checkbox" name="useLlmJudge" />` toggle.
3. In `apps/web/src/app/[locale]/[workspaceSlug]/evaluations/[datasetId]/runs/[runId]/page.tsx`:
   - Render run-level `failure_counts` badges when present on `run.summaryMetrics`.
   - Add a `Diagnosis` (`t("diagnosis")`) column in the per-case results table showing a color-coded badge for `r.raw?.failure_category` (plus `"REFUSED"` indicator when `r.raw?.refused` is true), and render an expandable `<details>` under the question cell showing the generated answer (`r.raw?.answer`) and `r.raw?.judge_rationale` when available.
4. Add translation keys (`rerankerNone`, `rerankerHeuristic`, `rerankerLlm`, `useLlmJudge`, `diagnosis`, `viewAnswerDetail`, `judgeRationale`, `failureCategories.{PASS,UNEXPECTED_REFUSAL,RETRIEVAL_MISS,BAD_CITATION,HALLUCINATION_RISK,INCOMPLETE_ANSWER}`) to `apps/web/messages/en.json` and `apps/web/messages/zh.json`.

- [ ] **Step 4: Run full verification (`vitest`, `eslint`, `tsc --noEmit`, `next build`, and `pytest`)**

Run:
- `pnpm --filter @knowledgeops/web test`
- `pnpm --filter @knowledgeops/web lint`
- `pnpm --filter @knowledgeops/web exec tsc --noEmit`
- `pnpm --filter @knowledgeops/web build`
- `uv run pytest` (in `services/ai`)
Expected: All pass with 0 errors and 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/evaluation.ts apps/web/src/lib/evaluation-actions.ts apps/web/src/lib/evaluation-actions.test.ts apps/web/src/components/evaluation/TriggerEvaluationRunForm.tsx "apps/web/src/app/[locale]/[workspaceSlug]/evaluations/[datasetId]/runs/[runId]/page.tsx" apps/web/messages/en.json apps/web/messages/zh.json
git commit -m "feat(web): add reranker/LLM-judge controls and failure attribution diagnostics UI"
```
