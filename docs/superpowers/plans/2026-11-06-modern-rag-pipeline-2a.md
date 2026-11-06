# Module 2A: Contextual Chunking, Hybrid RRF Search & Query Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the RAG ingestion, retrieval, answer, tracing, and evaluation configuration layers with Markdown heading-aware Contextual Chunking, tenant-isolated Hybrid Search (Dense Vector + Lexical Keyword RRF), and Multi-Turn / Configurable Query Rewrite.

**Architecture:** `chunk_text` tracks active Markdown headings (`#`–`######`) and optional `document_title` to inject a `[Document: ... | Section: ...]` context header into chunks when `document_title` is provided or headings are present. `retrieve` supports `retrieval_mode` (`"hybrid"` | `"vector"` | `"keyword"`), combining `pgvector` cosine similarity with CJK+ASCII lexical coverage via Reciprocal Rank Fusion (RRF) and exposing `vector_score` and `keyword_score` on `RetrievedChunk`. `_plan_answer` normalizes camelCase/snake_case config keys, runs `rewrite_query` when conversation `history` or `query_rewrite` is active, and emits `rewritten_query` in `trace`, which `apps/web` persists to `rag_traces.rewritten_query` and renders in the Trace Detail UI.

**Tech Stack:** Python 3.12 (FastAPI, SQLAlchemy, pgvector, Pytest), Next.js 16 (TypeScript, Drizzle ORM, `next-intl`, Vitest).

**Spec:** [`docs/superpowers/specs/2026-11-06-modern-rag-pipeline-2a-design.md`](../specs/2026-11-06-modern-rag-pipeline-2a-design.md)

## Global Constraints

- Single RAG implementation rule: both real-time chat (`/v1/answer`) and batch evaluation (`run_evaluation_job`) must go through `generate_answer` / `stream_answer_events` and `retrieve`.
- Tenant isolation: every SQL query in `retrieval.py` must filter on `kb.workspace_id = :workspace_id AND kb.id = :knowledge_base_id`.
- Backward compatibility: existing calls to `chunk_text(text, chunk_size=..., chunk_overlap=...)` without `document_title` on plain text must continue to produce identical chunks and respect `len(chunk.content) <= chunk_size` when no context prefix is added; when `document_title` or Markdown headings are present, the total chunk length including any context prefix must also stay `<= chunk_size` whenever `chunk_size` is large enough to hold the prefix.
- Exact-match invariant: when querying the exact text of an ingested chunk in `vector` or `hybrid` mode, `results[0].score` must be `pytest.approx(1.0, abs=1e-6)` so `test_exact_match_scores_highest` continues to pass.

## Review Focus

- Exact-match score calibration in `hybrid` mode: when a chunk has `vector_score ~= 1.0` and `keyword_score == 1.0` (rank 1 in both), the fused `score` must equal `1.0` (not raw unnormalized `2 / 61 = 0.0327`, which would fall below `answer_min_score=0.2` and cause every answer to refuse!).
- Cross-workspace and cross-KB isolation in `keyword` and `hybrid` modes: keyword matching must never surface chunks from another workspace or knowledge base.
- CamelCase config keys from Next.js `evaluation_runs.config` (`topK`, `retrievalMode`, `queryRewrite`, `minScore`): `_plan_answer` must honor both camelCase and snake_case keys.
- `FakeLLM` offline determinism during `rewrite_query`: when `LLM_PROVIDER=fake`, `rewrite_query` must deterministically combine context terms from the last user turn with the current query without making any network call.
- Multi-turn chat history ordering in `handleChat`: `listMessages(conversationId)` must be fetched *before* appending the current user turn (or slice excluding the current turn) so the current query is not duplicated as its own prior history.

---

### Task 1: Markdown Heading-Aware Contextual Chunking (`chunking.py` & `ingestion.py`)

**Files:**
- Modify: `services/ai/app/rag/chunking.py`
- Modify: `services/ai/app/rag/ingestion.py`
- Test: `services/ai/tests/test_chunking.py`

**Interfaces:**
- Produces:
  - `chunk_text(text: str, *, chunk_size: int, chunk_overlap: int, document_title: str | None = None) -> list[TextChunk]` in `services/ai/app/rag/chunking.py`
  - `process_ingestion_job` in `services/ai/app/rag/ingestion.py` passes `document_title=document.get("title")` to `chunk_text`

- [ ] **Step 1: Write failing tests for contextual chunking in `services/ai/tests/test_chunking.py`**

Add to `services/ai/tests/test_chunking.py`:

```python
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
    assert any("03-refund-policy.md" in c.content for c in chunks)
    # Later chunk under '## 如何申请' carries the section context
    apply_chunks = [c for c in chunks if "billing@nimbusdesk.example" in c.content]
    assert apply_chunks
    assert "退订与退款政策" in apply_chunks[0].content
```

- [ ] **Step 2: Run pytest on `tests/test_chunking.py` to verify it fails**

Run: `uv run pytest tests/test_chunking.py -v` (in `services/ai`)
Expected: FAIL (`TypeError: chunk_text() got an unexpected keyword argument 'document_title'`).

- [ ] **Step 3: Implement `document_title` and Markdown heading breadcrumb injection in `services/ai/app/rag/chunking.py` and pass `document_title` in `services/ai/app/rag/ingestion.py`**

In `services/ai/app/rag/chunking.py`:
- Accept `document_title: str | None = None` in `chunk_text`.
- Track active Markdown headings (`#` through `######`) across paragraphs/chunks. When `document_title` is provided (or when a subsequent chunk `index > 0` is under active Markdown headings that are not already present in that chunk), build a compact prefix `[Document: {document_title} | Section: {breadcrumb}]\n` (or `[Document: {document_title}]\n` / `[Section: {breadcrumb}]\n`) and prepend it while keeping total chunk length `<= chunk_size` when `len(prefix) < chunk_size // 2`.
- In `services/ai/app/rag/ingestion.py`, select `title` in `_fetch_document` (`SELECT id, title, mime_type, source_metadata FROM documents WHERE id = :id`) and pass `document_title=document.get("title")` to `chunk_text`.

- [ ] **Step 4: Run pytest on `tests/test_chunking.py` and `tests/test_ingestion_integration.py`**

Run: `uv run pytest tests/test_chunking.py tests/test_ingestion_integration.py -v` (in `services/ai`)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/ai/app/rag/chunking.py services/ai/app/rag/ingestion.py services/ai/tests/test_chunking.py
git commit -m "feat(ai): add contextual chunking with document and section breadcrumbs"
```

---

### Task 2: Tenant-Isolated Hybrid Search (Vector + Keyword RRF) in `retrieval.py`

**Files:**
- Modify: `services/ai/app/rag/retrieval.py`
- Modify: `services/ai/app/api/v1/schemas.py`
- Modify: `services/ai/app/api/v1/retrieve.py`
- Test: `services/ai/tests/test_retrieval.py`

**Interfaces:**
- Produces:
  - `RetrievedChunk` in `services/ai/app/rag/retrieval.py` adds optional `vector_score: float | None = None` and `keyword_score: float | None = None`
  - `retrieve(session, *, workspace_id, knowledge_base_id, query, top_k=None, score_threshold=None, retrieval_mode: str = "hybrid", settings=None) -> list[RetrievedChunk]`
  - `compute_keyword_score(query: str, content: str) -> float` and `fuse_hybrid_results(vector_hits: list[RetrievedChunk], keyword_hits: list[RetrievedChunk], *, top_k: int, rrf_k: int = 60) -> list[RetrievedChunk]` in `services/ai/app/rag/retrieval.py`

- [ ] **Step 1: Write failing unit and integration tests in `services/ai/tests/test_retrieval.py`**

Add to `services/ai/tests/test_retrieval.py`:

```python
from app.rag.retrieval import (
    RetrievedChunk,
    compute_keyword_score,
    fuse_hybrid_results,
    retrieve,
)


def test_compute_keyword_score_matches_exact_terms_and_cjk():
    score = compute_keyword_score(
        "billing@nimbusdesk.example 退款",
        "请发送邮件至 billing@nimbusdesk.example 申请全额退款。",
    )
    assert score > 0.7
    assert compute_keyword_score("年假制度", "Pro 套餐每月 899 元") == 0.0


def test_fuse_hybrid_results_boosts_dual_hit_and_preserves_score_range():
    v_hits = [
        RetrievedChunk("c1", "d1", 0, "vec first", 10, 0.80, vector_score=0.80),
        RetrievedChunk("c2", "d1", 1, "both hit", 10, 0.78, vector_score=0.78),
    ]
    k_hits = [
        RetrievedChunk("c2", "d1", 1, "both hit", 10, 1.0, keyword_score=1.0),
    ]
    fused = fuse_hybrid_results(v_hits, k_hits, top_k=2)
    assert fused[0].chunk_id == "c2"
    assert fused[0].vector_score == 0.78
    assert fused[0].keyword_score == 1.0
    assert 0.0 <= fused[0].score <= 1.0


def test_retrieve_supports_keyword_and_hybrid_modes(ingested_kb_factory):
    kb = ingested_kb_factory(
        "Pro 套餐月费 ¥899，联系 billing@nimbusdesk.example 办理退订。",
        slug_hint="hyb",
    )
    with session_scope() as session:
        kw_hits = retrieve(
            session,
            workspace_id=kb["workspace_id"],
            knowledge_base_id=kb["knowledge_base_id"],
            query="billing@nimbusdesk.example",
            retrieval_mode="keyword",
            top_k=3,
        )
        hyb_hits = retrieve(
            session,
            workspace_id=kb["workspace_id"],
            knowledge_base_id=kb["knowledge_base_id"],
            query="billing@nimbusdesk.example",
            retrieval_mode="hybrid",
            top_k=3,
        )
    assert kw_hits and kw_hits[0].keyword_score is not None and kw_hits[0].keyword_score > 0
    assert hyb_hits and hyb_hits[0].vector_score is not None
```

- [ ] **Step 2: Run pytest on `tests/test_retrieval.py` to verify it fails**

Run: `uv run pytest tests/test_retrieval.py -v` (in `services/ai`)
Expected: FAIL (`ImportError: cannot import name 'compute_keyword_score' from 'app.rag.retrieval'`).

- [ ] **Step 3: Implement `compute_keyword_score`, `fuse_hybrid_results`, and `retrieval_mode` in `services/ai/app/rag/retrieval.py` and `schemas.py`**

In `services/ai/app/rag/retrieval.py`:
1. Add `vector_score: float | None = None` and `keyword_score: float | None = None` to `RetrievedChunk`.
2. Implement `compute_keyword_score(query: str, content: str) -> float` using `normalize_tokens(query)` and `normalize_tokens(content)` from `app.evaluation.metrics` (plus exact case-insensitive substring bonus for email/code literals like `billing@nimbusdesk.example`).
3. Implement `fuse_hybrid_results(vector_hits, keyword_hits, *, top_k, rrf_k=60)`:
   - Rank `vector_hits` (1-based `r_v`) and `keyword_hits` with `keyword_score > 0` (1-based `r_k`).
   - Order candidates by RRF score `1 / (rrf_k + r_v) + (1 / (rrf_k + r_k) if r_k else 0)`, breaking ties by `vector_score` descending.
   - Set each fused item's calibrated `score` in `[-1, 1]`: when both `v_score` and `k_score` exist, `score = round(min(1.0, max(v_score, 0.7 * v_score + 0.3 * k_score)), 8)` (so an exact match with `v_score=1.0, k_score=1.0` stays `1.0`, and a chunk with a strong keyword hit gets boosted without distorting the `[0, 1]` cosine scale used by `answer_min_score`!).
4. In `retrieve(...)`, accept `retrieval_mode: str = "hybrid"` (`"vector"` | `"keyword"` | `"hybrid"`), run the tenant-scoped query, and return the requested mode's top-k results.
5. Update `RetrievedChunkModel` in `services/ai/app/api/v1/schemas.py` and `services/ai/app/api/v1/retrieve.py` to include `vector_score: float | None = None` and `keyword_score: float | None = None` and pass `config.get("retrieval_mode") or config.get("retrievalMode") or "hybrid"`.

- [ ] **Step 4: Run pytest across `services/ai` to verify all retrieval tests (including `test_exact_match_scores_highest`) pass**

Run: `uv run pytest tests/test_retrieval.py -v` (in `services/ai`)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/ai/app/rag/retrieval.py services/ai/app/api/v1/schemas.py services/ai/app/api/v1/retrieve.py services/ai/tests/test_retrieval.py
git commit -m "feat(ai): add tenant-isolated hybrid RRF search with vector and keyword scores"
```

---

### Task 3: Multi-Turn / Configurable Query Rewrite & Config Normalization (`answer.py`)

**Files:**
- Modify: `services/ai/app/rag/answer.py`
- Modify: `services/ai/app/api/v1/schemas.py`
- Modify: `services/ai/app/api/v1/answer.py`
- Test: `services/ai/tests/test_answer_unit.py`

**Interfaces:**
- Produces:
  - `rewrite_query(query: str, history: list[dict[str, str]] | None, provider: LLMProvider, settings: Settings) -> str` in `services/ai/app/rag/answer.py`
  - `normalize_rag_config(config: dict[str, Any] | None) -> dict[str, Any]` in `services/ai/app/rag/answer.py` (normalizes `topK`/`top_k`, `retrievalMode`/`retrieval_mode`, `queryRewrite`/`query_rewrite`, `minScore`/`min_score`, `scoreThreshold`/`score_threshold`)
  - `AnswerResult.rewritten_query: str | None = None` (included in `AnswerResult.to_dict()` both at top-level `rewritten_query` and inside `trace.rewritten_query` and `trace.retrieval_config`)
  - `AnswerRequest.history: list[dict[str, str]] | None = None` in `services/ai/app/api/v1/schemas.py`

- [ ] **Step 1: Write failing unit tests in `services/ai/tests/test_answer_unit.py`**

Add to `services/ai/tests/test_answer_unit.py`:

```python
from app.rag.answer import normalize_rag_config, rewrite_query


def test_normalize_rag_config_accepts_camel_and_snake_case():
    cfg = normalize_rag_config(
        {"topK": 8, "retrievalMode": "keyword", "queryRewrite": True, "minScore": 0.35}
    )
    assert cfg["top_k"] == 8
    assert cfg["retrieval_mode"] == "keyword"
    assert cfg["query_rewrite"] is True
    assert cfg["min_score"] == 0.35


def test_rewrite_query_resolves_multi_turn_context_deterministically_in_fake_mode():
    settings = get_settings()
    llm = FakeLLM()
    history = [
        {"role": "user", "content": "Pro 套餐每月多少钱？"},
        {"role": "assistant", "content": "Pro 套餐每月 ¥899 [1]。"},
    ]
    rewritten = rewrite_query("那它包含几个座席？", history, llm, settings)
    assert "Pro" in rewritten or "套餐" in rewritten
    assert "那它包含几个座席？" in rewritten


def test_generate_answer_records_rewritten_query_and_forwards_retrieval_mode(monkeypatch):
    from app.rag import answer as answer_mod

    captured_call = {}

    def fake_retrieve(session, **kwargs):
        captured_call.update(kwargs)
        return [_chunk("c1", "d1", 0, "Pro 套餐包含 5 个座席。")]

    monkeypatch.setattr(answer_mod, "retrieve", fake_retrieve)

    res = generate_answer(
        None,
        workspace_id="ws",
        knowledge_base_id="kb",
        query="那它包含几个座席？",
        history=[{"role": "user", "content": "Pro 套餐每月多少钱？"}],
        config={"topK": 4, "retrievalMode": "hybrid", "queryRewrite": True},
        provider=FakeLLM(),
    )
    assert captured_call["top_k"] == 4
    assert captured_call["retrieval_mode"] == "hybrid"
    assert res.rewritten_query is not None
    assert "Pro" in captured_call["query"]
    assert res.to_dict()["trace"]["rewritten_query"] == res.rewritten_query
```

- [ ] **Step 2: Run pytest on `tests/test_answer_unit.py` to verify it fails**

Run: `uv run pytest tests/test_answer_unit.py -v` (in `services/ai`)
Expected: FAIL (`ImportError: cannot import name 'normalize_rag_config' from 'app.rag.answer'`).

- [ ] **Step 3: Implement `normalize_rag_config`, `rewrite_query`, and `history` support in `services/ai/app/rag/answer.py`, `schemas.py`, and `api/v1/answer.py`**

1. In `services/ai/app/rag/answer.py`:
   - Implement `normalize_rag_config(config: dict[str, Any] | None) -> dict[str, Any]` mapping camelCase keys (`topK`, `retrievalMode`, `queryRewrite`, `minScore`, `scoreThreshold`) to snake_case.
   - Implement `rewrite_query(query: str, history: list[dict[str, str]] | None, provider: LLMProvider, settings: Settings) -> str`:
     - When `isinstance(provider, FakeLLM)`: deterministically prepend key content terms from the most recent user message in `history` (or expand the query) so offline tests are fast and deterministic.
     - When using a real LLM provider: ask the LLM with a concise query-rewrite system prompt to output ONLY a standalone search query in the same language as `query`, falling back to `query` if the output is empty.
   - Update `_plan_answer`, `generate_answer`, and `stream_answer_events` to accept `history: list[dict[str, str]] | None = None`, run `rewrite_query` when `bool(history)` or `norm_cfg.get("query_rewrite")` is truthy, record `stage_latency_ms["rewrite"]`, pass the rewritten query into `retrieve(..., retrieval_mode=norm_cfg["retrieval_mode"])`, and include `rewritten_query` and `retrieval_config` on `AnswerResult` and `AnswerResult.to_dict()`.
2. In `services/ai/app/api/v1/schemas.py` and `services/ai/app/api/v1/answer.py`, add `history: list[dict[str, str]] | None = None` to `AnswerRequest` and forward `history=body.history` into `stream_answer_events`.

- [ ] **Step 4: Run pytest across `services/ai` to verify all tests pass**

Run: `uv run pytest -v` (in `services/ai`)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/ai/app/rag/answer.py services/ai/app/api/v1/schemas.py services/ai/app/api/v1/answer.py services/ai/tests/test_answer_unit.py
git commit -m "feat(ai): add multi-turn query rewrite and normalize camelCase RAG config"
```

---

### Task 4: Web Chat History Forwarding, Trace View & Evaluation Config Controls

**Files:**
- Modify: `apps/web/src/lib/chat.ts`
- Modify: `apps/web/src/lib/chat.test.ts`
- Modify: `apps/web/src/lib/trace.ts`
- Modify: `apps/web/src/app/[locale]/[workspaceSlug]/traces/[id]/page.tsx`
- Modify: `apps/web/src/lib/evaluation.ts`
- Modify: `apps/web/src/lib/evaluation-actions.ts`
- Modify: `apps/web/src/lib/evaluation-actions.test.ts`
- Modify: `apps/web/src/components/evaluation/TriggerEvaluationRunForm.tsx`
- Modify: `apps/web/messages/en.json`
- Modify: `apps/web/messages/zh.json`

**Interfaces:**
- Consumes: `AnswerRequest.history`, `trace.rewritten_query`, `trace.retrieval_config`, and `retrieved_chunks[*].vector_score` / `keyword_score` from `services/ai`
- Produces:
  - `handleChat` in `apps/web/src/lib/chat.ts` loads prior messages via `listMessages(conversationId)` (up to last 6 messages before the current user turn), passes `history` to `POST /v1/answer`, and persists `rewrittenQuery` and `retrievalConfig` on `createTrace`
  - `TraceRetrievedChunk` in `apps/web/src/lib/trace.ts` adds optional `vectorScore?: number | null` and `keywordScore?: number | null`
  - `TriggerEvaluationRunForm.tsx` and `triggerEvaluationRunAction` support `retrievalMode` (`"hybrid" | "vector" | "keyword"`) and `queryRewrite` (`boolean`)

- [ ] **Step 1: Write failing tests in `apps/web/src/lib/chat.test.ts` and `apps/web/src/lib/evaluation-actions.test.ts`**

1. In `apps/web/src/lib/chat.test.ts`, add a test verifying that when `handleChat` reuses an existing `conversationId` with prior messages, it forwards `history` to `/v1/answer` and persists `rewrittenQuery` from `done.trace.rewritten_query` into `createTrace`.
2. In `apps/web/src/lib/evaluation-actions.test.ts`, add an assertion in `triggerEvaluationRunAction` verifying that `retrievalMode: "hybrid"` and `queryRewrite: "true"` are parsed into `config`.

- [ ] **Step 2: Run Vitest on `src/lib/chat.test.ts` and `src/lib/evaluation-actions.test.ts` to verify they fail**

Run: `pnpm --filter @knowledgeops/web test src/lib/chat.test.ts src/lib/evaluation-actions.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement chat history/trace persistence, Trace Detail UI, and Evaluation Run config controls**

1. In `apps/web/src/lib/chat.ts`:
   - Import `listMessages` from `@/lib/conversation`. When reusing an existing `conversationId`, load prior messages *before* `addMessage({ conversationId, role: "USER", content: query })` and build `history` from the last 6 messages (`role: m.role.toLowerCase()`, `content: m.content`).
   - Pass `history` in the `POST ${env.aiServiceUrl}/v1/answer` JSON body.
   - Include `vectorScore: c.vector_score ?? null` and `keywordScore: c.keyword_score ?? null` in `traceChunks(captured)`.
   - Pass `rewrittenQuery: captured.rewritten_query ?? captured.trace?.rewritten_query ?? null` and `retrievalConfig: captured.trace?.retrieval_config ?? ctx.retrievalConfig` to `createTrace`.
2. In `apps/web/src/app/[locale]/[workspaceSlug]/traces/[id]/page.tsx`:
   - Display `trace.rewrittenQuery` when present (in a `Rewritten query` / `改写后查询` card right below `Question`).
   - Display `vectorScore` and `keywordScore` badges next to `score` on each retrieved chunk when available.
3. In `apps/web/src/lib/evaluation.ts`, `apps/web/src/lib/evaluation-actions.ts`, and `apps/web/src/components/evaluation/TriggerEvaluationRunForm.tsx`:
   - Parse `retrievalMode` (`"hybrid" | "vector" | "keyword"`) and `queryRewrite` (`"true"` -> `true`, `"false"` -> `false`) in `triggerEvaluationRunAction`.
   - Render `Retrieval mode` and `Query rewrite` selects in `TriggerEvaluationRunForm.tsx`.
4. Add corresponding translation keys (`traces.rewrittenQuery`, `traces.vectorScore`, `traces.keywordScore`, `evaluations.retrievalMode`, `evaluations.retrievalModeHybrid`, `evaluations.retrievalModeVector`, `evaluations.retrievalModeKeyword`, `evaluations.queryRewrite`, `evaluations.queryRewriteDefault`, `evaluations.queryRewriteEnabled`, `evaluations.queryRewriteDisabled`) to `apps/web/messages/en.json` and `apps/web/messages/zh.json`.

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
git add apps/web/src/lib/chat.ts apps/web/src/lib/chat.test.ts apps/web/src/lib/trace.ts "apps/web/src/app/[locale]/[workspaceSlug]/traces/[id]/page.tsx" apps/web/src/lib/evaluation.ts apps/web/src/lib/evaluation-actions.ts apps/web/src/lib/evaluation-actions.test.ts apps/web/src/components/evaluation/TriggerEvaluationRunForm.tsx apps/web/messages/en.json apps/web/messages/zh.json
git commit -m "feat(web): wire multi-turn query rewrite, hybrid trace scores, and evaluation retrieval modes"
```
