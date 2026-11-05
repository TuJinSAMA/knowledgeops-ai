# Module 1: Enterprise QA Findings Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve all 8 findings (`F-001` through `F-008`) discovered during the enterprise scenario manual QA round across the Python AI service and Next.js web application.

**Architecture:** Turn-level questions in feedback queries are resolved via `LEFT JOIN rag_traces` (`coalesce(rag_traces.query, conversations.title)`). The Python RAG answer core adds a bilingual `[REFUSED]` sentinel protocol that stripsunrelated citations and marks `refused=True` across streaming and batch evaluation paths, while `normalize_tokens` and `estimate_tokens` gain zero-dependency CJK unigram/bigram support. The Next.js web layer adds locale-preserving server-action redirects, localized upload error codes, persistent top-bar navigation (`Chat` / `Knowledge bases`) with an `EN / 中文` switcher, and 4-decimal sub-cent cost formatting.

**Tech Stack:** Next.js 16 (App Router, TypeScript, Drizzle ORM, `next-intl`, Vitest), Python 3.12 (FastAPI, SQLAlchemy, Pytest).

**Spec:** [`docs/superpowers/specs/2026-11-05-qa-findings-remediation-design.md`](../specs/2026-11-05-qa-findings-remediation-design.md)

## Global Constraints

- Database schema (`apps/web/src/db/schema.ts`) must not be modified (zero migrations in Module 1).
- Single RAG implementation rule: `generate_answer` and `stream_answer_events` in `services/ai/app/rag/answer.py` must share the exact same refusal detection and citation cleanup logic.
- Offline determinism: `uv run pytest` and `pnpm --filter @knowledgeops/web test` must pass 100% offline with zero external network calls.
- Translation parity: `apps/web/messages/en.json` and `apps/web/messages/zh.json` must maintain identical key trees (verified by `src/i18n/routing.test.ts`).

## Review Focus

- Streaming `[REFUSED]` prefix split across multiple 1–3 character SSE chunks in `stream_answer_events`: the leading prefix buffer must not leak `[REFUSED]` tokens to the client before deciding whether the response starts with `[REFUSED]`.
- LLM refusal in Chinese or English without the literal `[REFUSED]` prefix (e.g., `"I don't have enough information..."` or `"根据现有资料，无法回答..."`): `detect_and_clean_refusal` must still classify it as `refused=True` and clear `citations=[]`.
- Mixed Chinese + English + numeric strings in `normalize_tokens` (e.g., `"Pro 套餐月费 ¥899，含 5 个座席"`): must emit both ASCII tokens (`pro`, `899`, `5`) and CJK unigrams/bigrams while excluding CJK functional stopwords (`个`).
- Server action redirects running inside Vitest unit tests where no Next.js request context exists (`getLocale()` throws): `redirectWithLocale` must fall back to the unprefixed path (`/${workspaceSlug}/...`) so existing unit tests and non-request contexts never throw an unhandled error.
- Feedback rows whose answer has no linked `rag_traces` row (`trace_id IS NULL`): `question` must gracefully fall back to `conversations.title`.

---

### Task 1: CJK-Aware Evaluation Tokenization & Token Estimation (`F-003`)

**Files:**
- Modify: `services/ai/app/evaluation/metrics.py`
- Modify: `services/ai/app/rag/chunking.py`
- Test: `services/ai/tests/test_evaluation_metrics.py`
- Test: `services/ai/tests/test_chunking.py`

**Interfaces:**
- Produces:
  - `normalize_tokens(value: str | None) -> set[str]` in `services/ai/app/evaluation/metrics.py` (extracts lowercase ASCII `[a-z0-9]+` minus `_STOPWORDS`, plus CJK `[\u4e00-\u9fff]` unigrams and adjacent bigrams minus `_CJK_STOPWORDS`)
  - `estimate_tokens(text: str) -> int` in `services/ai/app/rag/chunking.py` (`cjk_count + round(non_cjk_count / 4)`, minimum 1 for non-empty text)

- [ ] **Step 1: Write the failing CJK metric and token estimation tests**

Add to `services/ai/tests/test_evaluation_metrics.py`:

```python
def test_normalize_tokens_extracts_cjk_unigrams_and_bigrams():
    tokens = metrics.normalize_tokens("Pro 套餐的月费是 899 元")
    assert "pro" in tokens
    assert "899" in tokens
    assert "套" in tokens
    assert "餐" in tokens
    assert "套餐" in tokens
    assert "月费" in tokens
    assert "的" not in tokens
    assert "是" not in tokens


def test_correctness_and_groundedness_support_chinese_text():
    score = metrics.correctness_approx(
        "云席是面向客服团队的知识库问答产品",
        "面向客服团队的知识库产品",
        None,
    )
    assert score is not None and score > 0.7

    grounded = metrics.groundedness_approx(
        "购买后 7 天内可申请全额退款",
        "自成功付款之日起 7 天内，可申请全额退款。",
    )
    assert grounded is not None and grounded > 0.7
```

Add to `services/ai/tests/test_chunking.py`:

```python
def test_estimate_tokens_counts_cjk_characters():
    # 10 Chinese characters -> 10 tokens (not 10 / 4 = 2)
    assert estimate_tokens("云席客服知识库问答系统") == 11
    # Mixed: 4 Chinese chars (4) + 8 ASCII chars (8 / 4 = 2) -> 6
    assert estimate_tokens("云席产品abcd1234") == 6
```

- [ ] **Step 2: Run pytest on both test files to verify they fail**

Run: `uv run pytest tests/test_evaluation_metrics.py tests/test_chunking.py -v` (in `services/ai`)
Expected: FAIL on `test_normalize_tokens_extracts_cjk_unigrams_and_bigrams`, `test_correctness_and_groundedness_support_chinese_text`, and `test_estimate_tokens_counts_cjk_characters`.

- [ ] **Step 3: Implement CJK tokenization in `services/ai/app/evaluation/metrics.py` and `services/ai/app/rag/chunking.py`**

In `services/ai/app/evaluation/metrics.py`, add `_CJK_SPAN_PATTERN = re.compile(r"[\u4e00-\u9fff]+")` and `_CJK_STOPWORDS = frozenset("的了是在和有与及或等把被让给对从向到于也都就而且并便可会要这那此其我你他她它们个位条项种")`. In `normalize_tokens(value: str | None) -> set[str]`, keep ASCII tokens (`_TOKEN_PATTERN`) and for each match in `_CJK_SPAN_PATTERN.findall(value)`, filter out characters in `_CJK_STOPWORDS`, add each remaining character as a unigram, and add adjacent pairs `cleaned[i : i + 2]` as bigrams.

In `services/ai/app/rag/chunking.py`, count CJK characters matching `[\u4e00-\u9fff]` as `1` token each and remaining characters as `len(rest) / 4`, returning `max(1, cjk_count + round(non_cjk_count / 4))` for non-empty `text`.

- [ ] **Step 4: Run pytest to verify all metric and chunking tests pass**

Run: `uv run pytest tests/test_evaluation_metrics.py tests/test_chunking.py -v` (in `services/ai`)
Expected: PASS (all tests green).

- [ ] **Step 5: Commit**

```bash
git add services/ai/app/evaluation/metrics.py services/ai/app/rag/chunking.py services/ai/tests/test_evaluation_metrics.py services/ai/tests/test_chunking.py
git commit -m "fix(ai): support CJK tokenization in evaluation metrics and token estimation"
```

---

### Task 2: Bilingual Refusal Protocol & Citation Hygiene (`F-002`)

**Files:**
- Modify: `services/ai/app/rag/answer.py`
- Test: `services/ai/tests/test_answer_unit.py`

**Interfaces:**
- Produces:
  - `REFUSAL_MESSAGE_ZH: str` in `services/ai/app/rag/answer.py`
  - `get_refusal_message(query: str) -> str` in `services/ai/app/rag/answer.py`
  - `detect_and_clean_refusal(text: str) -> tuple[str, bool]` in `services/ai/app/rag/answer.py`

- [ ] **Step 1: Write the failing unit tests in `services/ai/tests/test_answer_unit.py`**

Add to `services/ai/tests/test_answer_unit.py`:

```python
from app.rag.answer import (
    REFUSAL_MESSAGE,
    REFUSAL_MESSAGE_ZH,
    detect_and_clean_refusal,
     generate_answer,
    get_refusal_message,
    stream_answer_events,
)
from app.rag.llm import LLMResult, LLMUsage


class _StubRefusalLLM:
    model = "stub-llm"
    last_usage = LLMUsage(prompt_tokens=10, completion_tokens=8, total_tokens=18)

    def __init__(self, response_text: str):
        self._text = response_text

    def complete(self, messages):
        return LLMResult(text=self._text, usage=self.last_usage, model=self.model)

    def stream(self, messages):
        for ch in self._text:
            yield ch


def test_get_refusal_message_matches_query_language():
    assert get_refusal_message("What is the SLA?") == REFUSAL_MESSAGE
    assert get_refusal_message("年假有多少天？") == REFUSAL_MESSAGE_ZH


def test_detect_and_clean_refusal_handles_sentinel_and_fallback_phrases():
    cleaned, refused = detect_and_clean_refusal("[REFUSED] 现有资料未提及年假制度 [1][2]。")
    assert refused is True
    assert not cleaned.startswith("[REFUSED]")
    assert "现有资料未提及年假制度" in cleaned

    _, en_refused = detect_and_clean_refusal(
        "I don't have enough information to answer that [1]."
    )
    assert en_refused is True

    _, normal = detect_and_clean_refusal("Pro 套餐每月 ¥899，包含 5 个座席 [1]。")
    assert normal is False


def test_stream_and_generate_strip_refusal_sentinel_and_clear_citations(monkeypatch):
    from app.rag import answer as answer_mod

    monkeypatch.setattr(
        answer_mod,
        "retrieve",
        lambda *a, **kw: [_chunk("c1", "d1", 0, "unrelated pricing doc")],
    )
    llm = _StubRefusalLLM("[REFUSED] 抱歉，现有资料中没有关于年假的信息 [1]。")

    res = generate_answer(
        None,
        workspace_id="ws",
        knowledge_base_id="kb",
        query="年假有多少天？",
        provider=llm,
    )
    assert res.refused is True
    assert res.citations == []
    assert "[REFUSED]" not in res.answer

    events = list(
        stream_answer_events(
            None,
            workspace_id="ws",
            knowledge_base_id="kb",
            query="年假有多少天？",
            provider=llm,
        )
    )
    streamed_tokens = "".join(p["text"] for name, p in events if name == "token")
    done_payload = [p for name, p in events if name == "done"][0]
    assert "[REFUSED]" not in streamed_tokens
    assert done_payload["refused"] is True
    assert done_payload["citations"] == []
```

- [ ] **Step 2: Run pytest on `tests/test_answer_unit.py` to verify it fails**

Run: `uv run pytest tests/test_answer_unit.py -v` (in `services/ai`)
Expected: FAIL with `ImportError` (`REFUSAL_MESSAGE_ZH`, `detect_and_clean_refusal`, `get_refusal_message` not defined).

- [ ] **Step 3: Implement bilingual refusal detection and citation cleanup in `services/ai/app/rag/answer.py`**

In `services/ai/app/rag/answer.py`:
1. Define:
```python
REFUSAL_MESSAGE_ZH = (
    "当前知识库中没有足够的信息来准确回答该问题，因此我不会猜测。"
    "请补充相关文档或换一种方式提问。"
)
```
2. Update `_SYSTEM_PROMPT`:
```python
_SYSTEM_PROMPT = (
    "You are an enterprise knowledge assistant. Always answer in the same "
    "language as the user's question. Answer using ONLY the numbered sources "
    "provided in the context, and cite every supported claim with its source "
    "number in square brackets, e.g. [1] or [2]. If the provided sources do "
    "not contain the information needed to answer the question, begin your "
    "response with the exact token [REFUSED], briefly state in the user's "
    "language that the knowledge base does not contain enough information, "
    "and do NOT cite any source numbers. Never invent facts or sources."
)
```
3. Implement `get_refusal_message(query: str) -> str` (returns `REFUSAL_MESSAGE_ZH` if `re.search(r"[\u4e00-\u9fff]", query)` else `REFUSAL_MESSAGE`).
4. Implement `detect_and_clean_refusal(text: str) -> tuple[str, bool]`:
   - Check leading `^\s*\[REFUSED\]\s*:?\s*` (case-insensitive) and strip it if present.
   - Also check fallback refusal phrases (`"i don't have enough information"`, `"i do not have enough information"`, `"not contain enough information"`, `"没有足够的信息"`, `"未提及"`, `"无法从现有资料"`, `"不在本文档范围内且无法"`).
   - When refused, also strip trailing/inline `[n]` markers from the cleaned refusal text so unrelated source numbers aren't shown in refusal prose.
5. In `generate_answer` and `stream_answer_events`:
   - Use `get_refusal_message(query)` when `plan.refused` is `True`.
   - When `plan.refused` is `False`, pass the LLM output through `detect_and_clean_refusal`. In `stream_answer_events`, buffer up to the first 12 characters until it's clear whether the stream starts with `[REFUSED]`, strip the prefix before yielding `token` events, and in the final `done` payload set `refused=is_refused` and `citations=[] if is_refused else parse_citations(cleaned_text, plan.retrieved)`.

- [ ] **Step 4: Run pytest across the entire `services/ai` suite**

Run: `uv run pytest -v` (in `services/ai`)
Expected: PASS (all tests green).

- [ ] **Step 5: Commit**

```bash
git add services/ai/app/rag/answer.py services/ai/tests/test_answer_unit.py
git commit -m "fix(ai): add bilingual refusal sentinel and strip citations on LLM refusal"
```

---

### Task 3: Turn-Level Question Resolution in Feedback (`F-001`)

**Files:**
- Modify: `apps/web/src/lib/feedback.ts`
- Modify: `apps/web/src/app/[locale]/[workspaceSlug]/feedback/page.tsx`
- Modify: `apps/web/src/app/[locale]/[workspaceSlug]/feedback/[id]/page.tsx`
- Create: `apps/web/src/lib/feedback.test.ts`

**Interfaces:**
- Produces:
  - `FeedbackListItem` and `FeedbackDetail` in `apps/web/src/lib/feedback.ts` now include `question: string | null` (resolved via `coalesce(rag_traces.query, conversations.title)`) alongside `conversationTitle: string | null`.

- [ ] **Step 1: Write the failing unit test `apps/web/src/lib/feedback.test.ts`**

Create `apps/web/src/lib/feedback.test.ts` testing that `listFeedback` and `getFeedback` join `ragTraces` and expose `question` from the trace query (falling back to `conversationTitle` when `ragTraces.query` is null).

- [ ] **Step 2: Run Vitest on `src/lib/feedback.test.ts` to verify it fails**

Run: `pnpm --filter @knowledgeops/web test src/lib/feedback.test.ts`
Expected: FAIL (`question` is undefined on `FeedbackListItem` / `FeedbackDetail` and `ragTraces` is not joined).

- [ ] **Step 3: Implement `LEFT JOIN rag_traces` in `apps/web/src/lib/feedback.ts` and update the two Feedback pages**

In `apps/web/src/lib/feedback.ts`:
- In `listFeedback` and `getFeedback`, add `.leftJoin(ragTraces, eq(answerFeedback.traceId, ragTraces.id))` and select `question: sql<string | null>\`coalesce(\${ragTraces.query}, \${conversations.title})\``.
- In `apps/web/src/app/[locale]/[workspaceSlug]/feedback/page.tsx` line 169, render `{f.question?.slice(0, 60) || f.conversationTitle?.slice(0, 60) || t("untitled")}`.
- In `apps/web/src/app/[locale]/[workspaceSlug]/feedback/[id]/page.tsx` line 83, render `{feedback.question || feedback.conversationTitle || t("untitled")}`.

- [ ] **Step 4: Run Vitest to verify `feedback.test.ts` and `feedback-actions.test.ts` pass**

Run: `pnpm --filter @knowledgeops/web test src/lib/feedback.test.ts src/lib/feedback-actions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/feedback.ts apps/web/src/lib/feedback.test.ts apps/web/src/app/\[locale\]/\[workspaceSlug\]/feedback/page.tsx apps/web/src/app/\[locale\]/\[workspaceSlug\]/feedback/\[id\]/page.tsx
git commit -m "fix(web): resolve turn-level question from rag_traces on feedback views"
```

---

### Task 4: Locale-Preserving Server Action Redirects & Localized Upload Errors (`F-004`, `F-005`, `F-008`)

**Files:**
- Modify: `apps/web/src/lib/action-errors.ts`
- Modify: `apps/web/src/lib/workspace-actions.ts`
- Modify: `apps/web/src/lib/knowledge-base-actions.ts`
- Modify: `apps/web/src/lib/evaluation-actions.ts`
- Modify: `apps/web/src/lib/document-upload.ts`
- Modify: `apps/web/src/lib/document-upload.test.ts`
- Modify: `apps/web/src/app/[locale]/[workspaceSlug]/api/knowledge-bases/[knowledgeBaseId]/documents/route.ts`
- Modify: `apps/web/src/components/knowledge-base/DocumentsPanel.tsx`
- Modify: `apps/web/src/components/workspace/RenameWorkspaceForm.tsx`
- Modify: `apps/web/messages/en.json`
- Modify: `apps/web/messages/zh.json`

**Interfaces:**
- Produces:
  - `withLocalePath(path: string): Promise<string>` in `apps/web/src/lib/action-errors.ts` (uses `getLocale()` from `next-intl/server` inside a try/catch; returns `/${locale}${path}` when `getLocale()` succeeds, or `path` when outside a request context such as unit tests).
  - `UploadErrorCode = "UPLOAD_FILE_MISSING" | "UPLOAD_UNSUPPORTED_TYPE" | "UPLOAD_FILE_EMPTY" | "UPLOAD_FILE_TOO_LARGE"` on `UploadError` in `apps/web/src/lib/document-upload.ts`, returned as `{ error: error.message, errorCode: error.code }` by the documents POST route and localized via `errors.*` in `DocumentsPanel.tsx`.
  - `RenameWorkspaceActionState = ActionState & { ok?: boolean }` returned by `renameWorkspaceAction` and rendered as `"Saved"` / `"已保存"` in `RenameWorkspaceForm.tsx`.

- [ ] **Step 1: Write failing tests in `apps/web/src/lib/document-upload.test.ts`**

Add assertions to `apps/web/src/lib/document-upload.test.ts` verifying that `resolveMimeType` throws `UploadError` with `code: "UPLOAD_UNSUPPORTED_TYPE"` and `ingestUploadedFile` throws `UploadError` with `code: "UPLOAD_FILE_EMPTY"` on a 0-byte file and `code: "UPLOAD_FILE_TOO_LARGE"` when exceeding `maxUploadBytes`.

- [ ] **Step 2: Run Vitest on `src/lib/document-upload.test.ts` to verify it fails**

Run: `pnpm --filter @knowledgeops/web test src/lib/document-upload.test.ts`
Expected: FAIL (`err.code` is undefined).

- [ ] **Step 3: Implement `UploadError.code`, `withLocalePath`, localized upload error rendering, and workspace rename `saved` indicator**

1. In `apps/web/src/lib/document-upload.ts`, add `readonly code: UploadErrorCode` to `UploadError` and pass `"UPLOAD_UNSUPPORTED_TYPE"`, `"UPLOAD_FILE_EMPTY"`, and `"UPLOAD_FILE_TOO_LARGE"`.
2. In `apps/web/src/app/[locale]/[workspaceSlug]/api/knowledge-bases/[knowledgeBaseId]/documents/route.ts`, return `{ error: "Missing 'file' field in multipart form data", errorCode: "UPLOAD_FILE_MISSING" }` on missing file and `{ error: error.message, errorCode: error.code }` on `UploadError`.
3. In `apps/web/src/components/knowledge-base/DocumentsPanel.tsx`, read `data.errorCode` and translate via `errorT(data.errorCode)` when present in `errors` namespace, falling back to `data.error`.
4. Add `UPLOAD_FILE_MISSING`, `UPLOAD_UNSUPPORTED_TYPE`, `UPLOAD_FILE_EMPTY`, `UPLOAD_FILE_TOO_LARGE` to `errors` in both `apps/web/messages/en.json` and `apps/web/messages/zh.json`, plus `saved` to `settings`.
5. In `apps/web/src/lib/action-errors.ts`, implement `withLocalePath(path: string): Promise<string>` and wrap the `redirect(...)` target in `workspace-actions.ts`, `knowledge-base-actions.ts`, and `evaluation-actions.ts`.
6. In `apps/web/src/lib/workspace-actions.ts`, return `{ ok: true }` from `renameWorkspaceAction` and render `{state.ok && <span className="text-xs text-emerald-600 dark:text-emerald-400">{t("saved")}</span>}` in `RenameWorkspaceForm.tsx`.

- [ ] **Step 4: Run Vitest across all web tests to verify everything passes**

Run: `pnpm --filter @knowledgeops/web test`
Expected: PASS (all test files green, including `src/i18n/routing.test.ts` key parity).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/action-errors.ts apps/web/src/lib/workspace-actions.ts apps/web/src/lib/knowledge-base-actions.ts apps/web/src/lib/evaluation-actions.ts apps/web/src/lib/document-upload.ts apps/web/src/lib/document-upload.test.ts apps/web/src/app/\[locale\]/\[workspaceSlug\]/api/knowledge-bases/\[knowledgeBaseId\]/documents/route.ts apps/web/src/components/knowledge-base/DocumentsPanel.tsx apps/web/src/components/workspace/RenameWorkspaceForm.tsx apps/web/messages/en.json apps/web/messages/zh.json
git commit -m "fix(web): preserve locale in action redirects and localize upload errors"
```

---

### Task 5: Persistent Header Navigation, Locale Switcher & Cost Precision (`F-006`, `F-007`, `F-008`)

**Files:**
- Create: `apps/web/src/components/workspace/LocaleSwitcher.tsx`
- Modify: `apps/web/src/app/[locale]/[workspaceSlug]/layout.tsx`
- Modify: `apps/web/src/app/[locale]/[workspaceSlug]/page.tsx`
- Modify: `apps/web/src/app/[locale]/[workspaceSlug]/usage/page.tsx`
- Modify: `apps/web/src/lib/pricing.ts`
- Modify: `apps/web/src/lib/pricing.test.ts`
- Modify: `apps/web/messages/en.json`
- Modify: `apps/web/messages/zh.json`

**Interfaces:**
- Produces:
  - `formatUsdCost(amount: number, locale: string): string` in `apps/web/src/lib/pricing.ts` (uses `maximumFractionDigits: 2` when `amount === 0 || Math.abs(amount) >= 0.01`, and `maximumFractionDigits: 4` when `0 < Math.abs(amount) < 0.01` so sub-cent LLM usage like `$0.0036` is never rounded to `$0.00`).
  - `LocaleSwitcher` client component in `apps/web/src/components/workspace/LocaleSwitcher.tsx` (switches between `en` and `zh` on the current pathname via `@/i18n/navigation`).

- [ ] **Step 1: Write the failing cost formatting test in `apps/web/src/lib/pricing.test.ts`**

Add to `apps/web/src/lib/pricing.test.ts`:

```ts
import { formatUsdCost } from "./pricing";

describe("formatUsdCost", () => {
  it("formats zero and standard amounts with 2 decimals, and sub-cent amounts with up to 4 decimals", () => {
    expect(formatUsdCost(0, "en")).toBe("$0.00");
    expect(formatUsdCost(1.25, "en")).toBe("$1.25");
    expect(formatUsdCost(0.003594, "en")).toBe("$0.0036");
  });
});
```

- [ ] **Step 2: Run Vitest on `src/lib/pricing.test.ts` to verify it fails**

Run: `pnpm --filter @knowledgeops/web test src/lib/pricing.test.ts`
Expected: FAIL (`formatUsdCost` is not exported from `./pricing`).

- [ ] **Step 3: Implement `formatUsdCost`, `LocaleSwitcher`, top-bar navigation links, and dashboard audit copy fix**

1. Export `formatUsdCost(amount: number, locale: string): string` from `apps/web/src/lib/pricing.ts` and use it in `apps/web/src/app/[locale]/[workspaceSlug]/page.tsx` and `apps/web/src/app/[locale]/[workspaceSlug]/usage/page.tsx`.
2. Remove the hardcoded trailing `.` after `{t("openAudit")}` in `apps/web/src/app/[locale]/[workspaceSlug]/page.tsx`.
3. Create `apps/web/src/components/workspace/LocaleSwitcher.tsx` using `useLocale()`, `usePathname()`, and `useRouter()` from `@/i18n/navigation` to toggle between `zh` (`中文`) and `en` (`EN`).
4. In `apps/web/src/app/[locale]/[workspaceSlug]/layout.tsx`, add top-bar navigation links for `chat` (`t("chat")`) and `knowledgeBases` (`t("knowledgeBases")`) and render `<LocaleSwitcher />` before `<SignOutButton />`. Add `navigation.chat` and `navigation.knowledgeBases` to `en.json` (`"Chat"`, `"Knowledge bases"`) and `zh.json` (`"助手"`, `"知识库"`).

- [ ] **Step 4: Run full verification (`vitest`, `eslint`, `tsc --noEmit`, `next build`, and `pytest`)**

Run:
- `pnpm --filter @knowledgeops/web test`
- `pnpm --filter @knowledgeops/web lint`
- `pnpm --filter @knowledgeops/web exec tsc --noEmit`
- `pnpm --filter @knowledgeops/web build`
- `uv run pytest` (in `services/ai`)
Expected: All pass with 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/workspace/LocaleSwitcher.tsx apps/web/src/app/\[locale\]/\[workspaceSlug\]/layout.tsx apps/web/src/app/\[locale\]/\[workspaceSlug\]/page.tsx apps/web/src/app/\[locale\]/\[workspaceSlug\]/usage/page.tsx apps/web/src/lib/pricing.ts apps/web/src/lib/pricing.test.ts apps/web/messages/en.json apps/web/messages/zh.json
git commit -m "feat(web): add top-bar chat/kb links, locale switcher, and sub-cent cost formatting"
```
