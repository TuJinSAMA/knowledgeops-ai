# Module 1 Design: Enterprise QA Findings Remediation (`F-001`–`F-008`)

- **Date:** 2026-11-05
- **Source findings:** [`docs/manual-qa/test-report.md`](../../manual-qa/test-report.md) (`F-001` through `F-008`)
- **Size:** Small-to-medium targeted remediation across `apps/web` and `services/ai` (no database schema migration required).

---

## 1. Intent & Why

Our first enterprise scenario manual QA round with real models (`qwen/qwen3-embedding-8b` + `deepseek-chat`) and dual roles (`OWNER` + `ADMIN`) passed the baseline closed loop, but exposed 3 P1 quality/credibility defects and 5 P2 UX/i18n friction points. Fixing these first ensures the baseline product is trustworthy for Chinese and English enterprise users and provides clean turn-level question data for **Module 3 (Feedback → Evaluation Case)**.

---

## 2. Goals & Non-Goals

### Goals
- **`F-001` (P1 — Feedback turn question accuracy):** Show the actual turn question (`rag_traces.query`) on Feedback list and detail views instead of always showing `conversations.title` (the first turn of a multi-turn conversation).
- **`F-002` (P1 — Bilingual refusal & citation hygiene):** Ensure the RAG assistant answers in the user's query language, marks LLM-level refusals with `refused=True`, strips unrelated citations when refusing, and returns localized retrieval-refusal messages.
- **`F-003` (P1 — CJK-aware evaluation metrics & token estimation):** Support Chinese + English tokenization in `normalize_tokens` (`services/ai/app/evaluation/metrics.py`) and CJK-aware token estimation in `estimate_tokens` (`services/ai/app/rag/chunking.py`) without heavy external dependencies.
- **`F-004` (P2 — Locale-preserving server action redirects):** Preserve the active `/{locale}` prefix when Server Actions redirect after creating/deleting knowledge bases, datasets, workspaces, or triggering evaluation runs.
- **`F-005` (P2 — Localized upload & chat API errors):** Localize error messages returned or rendered when uploading invalid/empty files.
- **`F-006` (P2 — Persistent top-bar navigation & locale switcher):** Add `Chat` (`询问助手`), `Knowledge bases` (`知识库`), and an `EN / 中文` switcher to the workspace header in `apps/web/src/app/[locale]/[workspaceSlug]/layout.tsx`.
- **`F-007` (P2 — Small-cost formatting precision):** Display up to 4–6 fraction digits for non-zero sub-cent USD costs on Dashboard and Usage pages so real DeepSeek runs (`~$0.0036`) do not appear as `$0.00`.
- **`F-008` (P2 — Minor UX/i18n polish):** Remove trailing ASCII `.` in localized dashboard audit prompt and display a `"Saved"` / `"已保存"` confirmation after renaming a workspace in Settings.

### Non-Goals
- Hybrid search (BM25 + vector RRF), rerankers, query rewrite, or LLM-as-a-Judge (covered in **Module 2**).
- Promoting feedback items into evaluation cases (covered in **Module 3**).
- Database schema migrations (none needed for Module 1).

---

## 3. Approaches Considered

### 3.1 `F-002` — Refusal Detection & Language Consistency
- **Approach A (Chosen): Prompt sentinel (`[REFUSED]`) + query language matching + post-processing cleanup.**
  - Update `_SYSTEM_PROMPT` in `services/ai/app/rag/answer.py` to require answering in the same language as the user's question, starting refusals with `[REFUSED]`, and never citing unrelated sources when refusing.
  - Detect `[REFUSED]` (plus bilingual refusal phrase fallback) in both `generate_answer` and `stream_answer_events`, strip `[REFUSED]` from the user-visible answer text, set `refused=True`, and clear `citations=[]`.
  - Select Chinese vs. English `REFUSAL_MESSAGE` when retrieval itself returns 0 chunks above `min_score`.
  - *Trade-off:* Zero extra LLM calls, no latency/cost overhead, identical behavior in streaming chat and batch evaluation.
- **Approach B (Rejected): Pre-generation LLM relevance gate call.**
  - Adds an extra LLM round-trip before every answer, doubling latency and cost.

### 3.2 `F-003` — CJK Tokenization in Deterministic Evaluation Metrics
- **Approach A (Chosen): Zero-dependency hybrid tokenizer (ASCII words + CJK unigrams & bigrams).**
  - In `services/ai/app/evaluation/metrics.py`, extract lowercase ASCII tokens `[a-z0-9]+` (filtering English stopwords) plus CJK characters `[\u4e00-\u9fff]` as both unigrams and adjacent bigrams within contiguous CJK spans (filtering common Chinese functional characters: `的, 了, 是, 在, 和, 有, 与, 及, 或, 等, 把, 被, 让, 给, 对, 从, 向, 到, 于, 也, 都, 就, 而, 且, 并, 便, 可, 能, 会, 要, 这, 那, 此, 其, 我, 你, 他, 她, 它, 们, 个, 位, 条, 项, 种`).
  - In `services/ai/app/rag/chunking.py`, estimate tokens as `cjk_chars + round(non_cjk_chars / 4)`.
  - *Trade-off:* Pure, deterministic, offline-safe in Docker and unit tests, accurately captures Chinese lexical overlap and groundedness.
- **Approach B (Rejected): Add `jieba` + `tiktoken` dependencies.**
  - Increases container size, cold-start dictionary loading, and risks offline BPE cache misses.

---

## 4. Detailed Component Changes

1. **Feedback Turn Question (`apps/web/src/lib/feedback.ts`)**
   - In `listFeedback` and `getFeedback`, `LEFT JOIN rag_traces ON rag_traces.id = answer_feedback.trace_id` and select `question: sql<string | null>\`coalesce(\${ragTraces.query}, \${conversations.title})\``.
   - Keep `conversationTitle` or replace display usage in `feedback/page.tsx` and `feedback/[id]/page.tsx` so each feedback row displays the exact question asked on that turn.
2. **RAG Refusal & Bilingual Prompt (`services/ai/app/rag/answer.py`)**
   - Add `REFUSAL_MESSAGE_ZH` alongside `REFUSAL_MESSAGE` and a helper `get_refusal_message(query: str) -> str` that returns Chinese when `query` contains CJK characters.
   - Update `_SYSTEM_PROMPT` to instruct the model to respond in the user's question language and prefix any insufficient-information refusal with `[REFUSED]` without citations.
   - Add `detect_and_clean_refusal(text: str) -> tuple[str, bool]` used by `generate_answer` and `stream_answer_events`. When `is_refused` is `True`, set `refused=True` and `citations=[]`.
   - In `stream_answer_events`, buffer the initial few characters so a leading `[REFUSED]` marker is stripped cleanly before yielding `token` events.
3. **CJK Evaluation Metrics & Token Estimation (`services/ai/app/evaluation/metrics.py`, `services/ai/app/rag/chunking.py`)**
   - Update `normalize_tokens` to emit ASCII word tokens + CJK unigrams/bigrams (minus stopwords).
   - Update `estimate_tokens` to count CJK characters at 1 token/char and non-CJK characters at 1 token per 4 chars.
4. **Locale-Preserving Server Actions & Upload Errors (`apps/web/src/lib/*-actions.ts`, `DocumentsPanel.tsx`, upload route)**
   - Add a small helper `withLocalePath(path: string): Promise<string>` that reads `getLocale()` from `next-intl/server` when inside a Next.js request context and prefixes `/${locale}${path}`, while gracefully falling back to `path` in unit tests where `getLocale()` is not active.
   - Map upload API errors (`400` unsupported type / empty file / too large / missing file) to localized keys in `DocumentsPanel.tsx` (`en.json` & `zh.json`).
5. **Header Navigation, Locale Switcher & Polish (`apps/web/src/app/[locale]/[workspaceSlug]/layout.tsx`, `page.tsx`, `usage/page.tsx`, `RenameWorkspaceForm.tsx`)**
   - Add `询问助手` (`Chat`) and `知识库` (`Knowledge bases`) links plus a `LocaleSwitcher` (`中文 / EN`) component to the workspace header.
   - Format non-zero costs `< 0.01` with `maximumFractionDigits: 4` on Dashboard and Usage pages.
   - Remove the hardcoded `.` after `{t("openAudit")}` on the workspace dashboard and add a `"Saved"` / `"已保存"` status indicator to `RenameWorkspaceForm`.
