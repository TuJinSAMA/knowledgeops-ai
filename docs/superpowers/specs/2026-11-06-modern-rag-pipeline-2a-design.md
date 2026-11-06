# Module 2A Design: Contextual Chunking, Hybrid RRF Search & Query Rewrite

- **Date:** 2026-11-06
- **Size:** Core AI pipeline upgrade across `services/ai` and `apps/web` (no database schema migration required; uses existing `rag_traces.rewritten_query` and `evaluation_runs.config` columns).

---

## 1. Intent & Why

A 2023-era RAG baseline ("fixed character split + dense vector top-k") fails on three real enterprise patterns:
1. **Orphaned chunks:** A chunk like `"7 天内可申请全额退款"` loses its document title and section heading (`退订与退款政策 > 全额退款窗口`), degrading both embedding quality and LLM grounding.
2. **Exact-term blind spots:** Dense embeddings struggle on exact SKUs, prices (`¥899`), emails (`billing@nimbusdesk.example`), and error codes when not paired with lexical keyword matching.
3. **Conversational coreference:** In multi-turn chat, follow-up questions like `"那它包含几个座席？"` fail retrieval unless rewritten into a standalone query (`"Pro 套餐包含几个座席？"`).

Module 2A upgrades the single RAG core in `services/ai` with **Contextual Chunking**, **Tenant-Isolated Hybrid Search (Dense Vector + Lexical Keyword RRF)**, and **Multi-Turn / Configurable Query Rewrite**, while exposing these signals in **RAG Traces** and **Evaluation Run Configurations**.

---

## 2. Goals & Non-Goals

### Goals
- **Contextual Chunking (`services/ai/app/rag/chunking.py`, `ingestion.py`):**
  - Track Markdown heading hierarchy (`#`–`######`) as text is split and accept an optional `document_title: str | None` in `chunk_text`.
  - When `document_title` or active section headings exist, prepend a compact context header (`[Document: <title> | Section: <H1 > H2>]\n`) to each chunk whose body does not already start with that heading.
- **Tenant-Isolated Hybrid Search with RRF (`services/ai/app/rag/retrieval.py`):**
  - Support `retrieval_mode: "hybrid" | "vector" | "keyword"` (default `"hybrid"`).
  - **Vector branch:** `pgvector` cosine similarity (`vector_score`).
  - **Keyword branch:** Tokenize `query` using the project's CJK + ASCII tokenizer (`normalize_tokens`) and compute normalized lexical term + substring coverage (`keyword_score` in `[0, 1]`) over tenant-isolated chunks in the target `(workspace_id, knowledge_base_id)`.
  - **Reciprocal Rank Fusion (RRF):** Combine vector and keyword rankings via RRF and produce a calibrated relevance `score` in `[0, 1]` (preserving exact-match `score == 1.0` and compatibility with `answer_min_score`), while attaching `vector_score: float | None` and `keyword_score: float | None` on `RetrievedChunk`.
- **Query Rewrite (`services/ai/app/rag/answer.py`, `apps/web/src/lib/chat.ts`):**
  - Pass prior conversation turns (`history: list[{"role": "user" | "assistant", "content": str}]`) from `handleChat` in `apps/web/src/lib/chat.ts` to `POST /v1/answer`.
  - Add `rewrite_query(query, history, provider, settings) -> str` in `services/ai/app/rag/answer.py`. Run query rewrite when non-empty `history` is provided or when `config.query_rewrite` / `config.queryRewrite` is enabled.
  - Record `rewritten_query` and `stage_latency_ms["rewrite"]` in `AnswerResult.trace`, persist `rewritten_query` into `rag_traces.rewritten_query`, and display it on the **Trace Detail** page (`/[locale]/[workspaceSlug]/traces/[id]`) along with per-chunk `vectorScore` and `keywordScore`.
- **Cross-Language Config Normalization & Evaluation Controls (`answer.py`, `TriggerEvaluationRunForm.tsx`):**
  - Normalize both camelCase (`topK`, `retrievalMode`, `queryRewrite`, `minScore`) and snake_case (`top_k`, `retrieval_mode`, `query_rewrite`, `min_score`) keys in `_plan_answer`.
  - Add `Retrieval mode` (`hybrid` / `vector` / `keyword`) and `Query rewrite` (`enabled` / `disabled`) selectors to `TriggerEvaluationRunForm.tsx`.

### Non-Goals
- Cross-encoder / LLM reranking and LLM-as-a-Judge failure attribution (covered in **Module 2B**).
- External C extensions in Postgres (must work out-of-the-box on standard `pgvector/pgvector:pg16`).
