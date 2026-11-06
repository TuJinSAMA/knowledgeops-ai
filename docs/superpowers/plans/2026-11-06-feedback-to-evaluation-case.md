# Module 3: Feedback-to-Evaluation-Case Closed Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the bidirectional operational loop that promotes user feedback items into evaluation regression cases (`Feedback ↔ EvaluationCase`), with schema foreign-key linkage, single-transaction inline dataset/case creation, audit logging, and UI deep links on both Feedback and Evaluation pages.

**Architecture:** `answer_feedback` gains a nullable `promoted_case_id` foreign key (`ON DELETE SET NULL`) referencing `evaluation_cases(id)` via a Drizzle migration. A transactional domain helper `promoteFeedbackToCase` in `apps/web/src/lib/feedback.ts` verifies workspace isolation, optionally creates a new dataset bound to the feedback's knowledge base, inserts the evaluation case, updates `answer_feedback.promoted_case_id` (and optionally marks `review_status = 'RESOLVED'`), and records a `feedback.promote-case` audit entry. Both Feedback views (`/feedback`, `/feedback/[id]`) and the Evaluation Dataset view (`/evaluations/[datasetId]`) surface the bidirectional linkage.

**Tech Stack:** Next.js 16 (App Router, TypeScript, Drizzle ORM, PostgreSQL 16, `next-intl`, Vitest).

**Spec:** [`docs/superpowers/specs/2026-11-05-feedback-to-evaluation-case-design.md`](../specs/2026-11-05-feedback-to-evaluation-case-design.md)

## Global Constraints

- Schema ownership: Drizzle in `apps/web/src/db/schema.ts` owns the migration (`pnpm db:generate && pnpm db:migrate`).
- Tenant isolation: `promoteFeedbackToCase` must verify that both the feedback item and any target existing `datasetId` belong to `workspaceId` before writing.
- Idempotency / duplicate protection: if `feedback.promotedCaseId` is already non-null, `promoteFeedbackToCase` must reject with `FEEDBACK_ALREADY_PROMOTED` rather than creating duplicate cases.
- Cascading cleanup: if an operator later deletes the promoted `EvaluationCase` or its `EvaluationDataset`, Postgres `ON DELETE SET NULL` resets `answer_feedback.promoted_case_id` to `NULL` so the feedback item can be promoted again.
- Translation parity: `apps/web/messages/en.json` and `apps/web/messages/zh.json` must remain in 100% key parity.

## Review Focus

- Cross-tenant dataset injection: an operator in workspace A submits `promoteFeedbackToCaseAction` with a `datasetId` belonging to workspace B — must return `DATASET_NOT_FOUND` without creating a case or updating the feedback row.
- Double promotion race / repeat submission: promoting a feedback item whose `promotedCaseId` is already set must return `FEEDBACK_ALREADY_PROMOTED` without inserting a second case.
- Inline new dataset creation (`datasetId === "__new__"`): when the operator chooses to create a new dataset inline, an empty `newDatasetName` must return `DATASET_NAME_REQUIRED`, and a valid name must bind the new dataset to `feedback.knowledgeBaseId`.
- Feedback with empty turn question (`question` and `conversationTitle` both null/empty, and operator submits empty `question` field): must return `EVALUATION_CASE_QUESTION_REQUIRED`.
- Deleting a promoted case from `/evaluations/[datasetId]`: `ON DELETE SET NULL` clears `answer_feedback.promoted_case_id`, so `/feedback/[id]` renders the promotion form again instead of a broken link.

---

### Task 1: Drizzle Schema & Migration for `answer_feedback.promoted_case_id`

**Files:**
- Modify: `apps/web/src/db/schema.ts`
- Modify: `apps/web/src/lib/audit.ts`
- Modify: `apps/web/src/lib/audit.test.ts`
- Modify: `apps/web/src/lib/action-errors.ts`
- Create: `apps/web/drizzle/0007_*.sql` (generated via `pnpm db:generate`)

**Interfaces:**
- Produces:
  - `answerFeedback.promotedCaseId` (`uuid("promoted_case_id").references((): AnyPgColumn => evaluationCases.id, { onDelete: "set null" })`) in `apps/web/src/db/schema.ts`
  - `AUDIT_ACTIONS.FEEDBACK_PROMOTE_CASE = "feedback.promote-case"` in `apps/web/src/lib/audit.ts`
  - `"FEEDBACK_ALREADY_PROMOTED"` added to `ActionErrorCode` in `apps/web/src/lib/action-errors.ts`

- [ ] **Step 1: Write failing test in `apps/web/src/lib/audit.test.ts`**

Add an assertion in `apps/web/src/lib/audit.test.ts` checking that `AUDIT_ACTIONS.FEEDBACK_PROMOTE_CASE` equals `"feedback.promote-case"`.

- [ ] **Step 2: Run Vitest on `src/lib/audit.test.ts` to verify it fails**

Run: `pnpm --filter @knowledgeops/web test src/lib/audit.test.ts`
Expected: FAIL (`AUDIT_ACTIONS.FEEDBACK_PROMOTE_CASE` is `undefined`).

- [ ] **Step 3: Add `promotedCaseId` to `schema.ts`, `FEEDBACK_PROMOTE_CASE` to `audit.ts`, `FEEDBACK_ALREADY_PROMOTED` to `action-errors.ts`, and generate + apply the Drizzle migration**

1. In `apps/web/src/db/schema.ts`, import `type AnyPgColumn` from `"drizzle-orm/pg-core"`, add `promotedCaseId: uuid("promoted_case_id").references((): AnyPgColumn => evaluationCases.id, { onDelete: "set null" })` to `answerFeedback`, and add `index("answer_feedback_promoted_case_idx").on(table.promotedCaseId)`.
2. In `apps/web/src/lib/audit.ts`, add `FEEDBACK_PROMOTE_CASE: "feedback.promote-case"` to `AUDIT_ACTIONS`.
3. In `apps/web/src/lib/action-errors.ts`, add `"FEEDBACK_ALREADY_PROMOTED"` to `ActionErrorCode`.
4. Run `pnpm db:generate` and `pnpm db:migrate` to generate and apply the migration against Postgres.

- [ ] **Step 4: Run `src/lib/audit.test.ts` and verify migration applied cleanly**

Run: `pnpm --filter @knowledgeops/web test src/lib/audit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/db/schema.ts apps/web/src/lib/audit.ts apps/web/src/lib/audit.test.ts apps/web/src/lib/action-errors.ts apps/web/drizzle
git commit -m "feat(db): add promoted_case_id foreign key on answer_feedback"
```

---

### Task 2: Domain Layer (`promoteFeedbackToCase`, `getFeedback` / `listFeedback` & `listEvaluationCases` Provenance)

**Files:**
- Modify: `apps/web/src/lib/feedback.ts`
- Modify: `apps/web/src/lib/feedback.test.ts`
- Modify: `apps/web/src/lib/evaluation.ts`

**Interfaces:**
- Consumes: `answerFeedback.promotedCaseId` from `apps/web/src/db/schema.ts`
- Produces:
  - `FeedbackListItem.promotedCaseId: string | null` in `apps/web/src/lib/feedback.ts`
  - `FeedbackDetail.promotedCaseId: string | null`, `promotedDatasetId: string | null`, `promotedDatasetName: string | null` in `apps/web/src/lib/feedback.ts`
  - `PromoteFeedbackToCaseParams` and `PromoteFeedbackToCaseResult` in `apps/web/src/lib/feedback.ts`:
    ```ts
    export type PromoteFeedbackToCaseParams = {
      datasetId?: string | null;
      newDatasetName?: string | null;
      question: string;
      expectedAnswer?: string | null;
      expectedSourceDocuments?: string[] | null;
      requiredFacts?: string[] | null;
      tags?: string[] | null;
      markResolved?: boolean;
    };
    export type PromoteFeedbackToCaseResult =
      | { ok: true; caseId: string; datasetId: string; datasetName: string }
      | {
          ok: false;
          reason:
            | "FEEDBACK_NOT_FOUND"
            | "FEEDBACK_ALREADY_PROMOTED"
            | "DATASET_NOT_FOUND"
            | "DATASET_NAME_REQUIRED"
            | "EVALUATION_CASE_QUESTION_REQUIRED";
        };
    ```
  - `promoteFeedbackToCase(workspaceId: string, feedbackId: string, params: PromoteFeedbackToCaseParams): Promise<PromoteFeedbackToCaseResult>`
  - `EvaluationCaseRecord.sourceFeedbackId: string | null` in `apps/web/src/lib/evaluation.ts`

- [ ] **Step 1: Write failing unit tests in `apps/web/src/lib/feedback.test.ts`**

Extend `apps/web/src/lib/feedback.test.ts` with tests for:
1. `listFeedback` and `getFeedback` selecting `promotedCaseId` (and `promotedDatasetId` / `promotedDatasetName` on `getFeedback`).
2. `promoteFeedbackToCase`:
   - returns `{ ok: false, reason: "FEEDBACK_NOT_FOUND" }` when feedback is absent in workspace;
   - returns `{ ok: false, reason: "FEEDBACK_ALREADY_PROMOTED" }` when `promotedCaseId` is already set;
   - returns `{ ok: false, reason: "DATASET_NOT_FOUND" }` when target `datasetId` does not belong to `workspaceId`;
   - returns `{ ok: false, reason: "DATASET_NAME_REQUIRED" }` when neither `datasetId` nor `newDatasetName` is provided;
   - creates an inline dataset bound to `feedback.knowledgeBaseId`, inserts the `evaluation_cases` row, and updates `answer_feedback.promotedCaseId` (plus `reviewStatus: "RESOLVED"` when `markResolved: true`).

- [ ] **Step 2: Run Vitest on `src/lib/feedback.test.ts` to verify it fails**

Run: `pnpm --filter @knowledgeops/web test src/lib/feedback.test.ts`
Expected: FAIL (`promoteFeedbackToCase` is not defined).

- [ ] **Step 3: Implement `promoteFeedbackToCase` and provenance fields in `apps/web/src/lib/feedback.ts` and `apps/web/src/lib/evaluation.ts`**

1. In `apps/web/src/lib/feedback.ts`:
   - Import `evaluationCases, evaluationDatasets` from `@/db/schema`.
   - In `listFeedback`, select `promotedCaseId: answerFeedback.promotedCaseId`.
   - In `getFeedback`, `.leftJoin(evaluationCases, eq(answerFeedback.promotedCaseId, evaluationCases.id))` and `.leftJoin(evaluationDatasets, eq(evaluationCases.datasetId, evaluationDatasets.id))`, selecting `promotedCaseId: answerFeedback.promotedCaseId`, `promotedDatasetId: evaluationDatasets.id`, `promotedDatasetName: evaluationDatasets.name`.
   - Implement `promoteFeedbackToCase(workspaceId, feedbackId, params)` inside `db.transaction(async (tx) => ...)`.
2. In `apps/web/src/lib/evaluation.ts`:
   - Import `answerFeedback` from `@/db/schema`.
   - In `listEvaluationCases`, `.leftJoin(answerFeedback, eq(answerFeedback.promotedCaseId, evaluationCases.id))` and return `sourceFeedbackId: row.sourceFeedbackId ?? null` on each `EvaluationCaseRecord`.

- [ ] **Step 4: Run Vitest on `src/lib/feedback.test.ts` to verify it passes**

Run: `pnpm --filter @knowledgeops/web test src/lib/feedback.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/feedback.ts apps/web/src/lib/feedback.test.ts apps/web/src/lib/evaluation.ts
git commit -m "feat(web): implement transactional promoteFeedbackToCase and case provenance"
```

---

### Task 3: Server Action `promoteFeedbackToCaseAction` & Unit Tests

**Files:**
- Modify: `apps/web/src/lib/feedback-actions.ts`
- Modify: `apps/web/src/lib/feedback-actions.test.ts`

**Interfaces:**
- Consumes: `promoteFeedbackToCase` from `apps/web/src/lib/feedback.ts`, `AUDIT_ACTIONS.FEEDBACK_PROMOTE_CASE` from `apps/web/src/lib/audit.ts`, `withLocalePath` from `apps/web/src/lib/action-errors.ts`
- Produces:
  - `PromoteActionState = ActionState & { ok?: boolean; caseId?: string; datasetId?: string; datasetName?: string }`
  - `promoteFeedbackToCaseAction(workspaceSlug: string, feedbackId: string, _prev: PromoteActionState, formData: FormData): Promise<PromoteActionState>` in `apps/web/src/lib/feedback-actions.ts`

- [ ] **Step 1: Write failing tests for `promoteFeedbackToCaseAction` in `apps/web/src/lib/feedback-actions.test.ts`**

Add a `describe("promoteFeedbackToCaseAction", ...)` block in `apps/web/src/lib/feedback-actions.test.ts` testing:
1. Requires `ADMIN` role and calls `promoteFeedbackToCase` with parsed `question`, `expectedAnswer`, `requiredFacts`, `expectedSourceDocuments`, `tags`, and `markResolved`, then records a `feedback.promote-case` audit log entry.
2. Rejects a `MEMBER` below `ADMIN` with `AUTHORIZATION_FAILED`.
3. Propagates domain failure reasons (`FEEDBACK_ALREADY_PROMOTED`, `DATASET_NOT_FOUND`, `DATASET_NAME_REQUIRED`, `EVALUATION_CASE_QUESTION_REQUIRED`) as `errorCode` without recording an audit log.

- [ ] **Step 2: Run Vitest on `src/lib/feedback-actions.test.ts` to verify it fails**

Run: `pnpm --filter @knowledgeops/web test src/lib/feedback-actions.test.ts`
Expected: FAIL (`promoteFeedbackToCaseAction` is not exported).

- [ ] **Step 3: Implement `promoteFeedbackToCaseAction` in `apps/web/src/lib/feedback-actions.ts` (and wrap `revalidatePath` with `withLocalePath`)**

In `apps/web/src/lib/feedback-actions.ts`:
- Parse `datasetChoice` (`formData.get("datasetId")`), `newDatasetName` (`formData.get("newDatasetName")`), `question`, `expectedAnswer`, newline/comma-separated `expectedSourceDocuments`, `requiredFacts`, `tags`, and `markResolved` (`formData.get("markResolved") === "on"`).
- Enforce `requireWorkspaceMemberBySlug(workspaceSlug, "ADMIN")`.
- Call `promoteFeedbackToCase(workspaceId, feedbackId, ...)`.
- Record audit log `AUDIT_ACTIONS.FEEDBACK_PROMOTE_CASE` with `target: { type: "evaluation_case", id: result.caseId }` and `metadata: { feedback_id: feedbackId, dataset_id: result.datasetId, name: result.datasetName }`.
- Revalidate feedback and evaluation dataset paths using `withLocalePath`.

- [ ] **Step 4: Run Vitest on `src/lib/feedback-actions.test.ts` to verify it passes**

Run: `pnpm --filter @knowledgeops/web test src/lib/feedback-actions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/feedback-actions.ts apps/web/src/lib/feedback-actions.test.ts
git commit -m "feat(web): add promoteFeedbackToCaseAction server action with audit logging"
```

---

### Task 4: Bidirectional UI (`PromoteFeedbackToCaseForm`, Feedback List/Detail, Dataset Detail & i18n)

**Files:**
- Create: `apps/web/src/components/feedback/PromoteFeedbackToCaseForm.tsx`
- Modify: `apps/web/src/app/[locale]/[workspaceSlug]/feedback/page.tsx`
- Modify: `apps/web/src/app/[locale]/[workspaceSlug]/feedback/[id]/page.tsx`
- Modify: `apps/web/src/app/[locale]/[workspaceSlug]/evaluations/[datasetId]/page.tsx`
- Modify: `apps/web/messages/en.json`
- Modify: `apps/web/messages/zh.json`

**Interfaces:**
- Consumes: `promoteFeedbackToCaseAction` from `apps/web/src/lib/feedback-actions.ts`, `listEvaluationDatasets` from `apps/web/src/lib/evaluation.ts`
- Produces:
  - `PromoteFeedbackToCaseForm` client component in `apps/web/src/components/feedback/PromoteFeedbackToCaseForm.tsx`
  - Bidirectional badges/links on `/feedback`, `/feedback/[id]`, and `/evaluations/[datasetId]`

- [ ] **Step 1: Add translation keys to `apps/web/messages/en.json` and `apps/web/messages/zh.json` and create `PromoteFeedbackToCaseForm.tsx`**

1. Add keys under `feedback` (`promotedBadge`, `promoteTitle`, `promoteDescription`, `promotedCardTitle`, `promotedToDataset`, `openDataset`, `targetDataset`, `createNewDatasetOption`, `newDatasetName`, `newDatasetNamePlaceholder`, `questionLabel`, `expectedAnswerLabel`, `expectedAnswerPlaceholder`, `requiredFactsLabel`, `expectedDocsLabel`, `tagsLabel`, `markResolvedLabel`, `promoteButton`, `promoting`), under `evaluations` (`fromFeedback`), under `audit.actionLabels.feedback` (`promote-case`), and under `errors` (`FEEDBACK_ALREADY_PROMOTED`) in both `en.json` and `zh.json`.
2. Create `apps/web/src/components/feedback/PromoteFeedbackToCaseForm.tsx` with dataset selector (existing datasets ordered with same-KB datasets first, plus `__new__` option that reveals the inline `newDatasetName` input, defaulting to `__new__` when the workspace has no datasets yet), pre-filled `question` and default `tags` (`from-feedback` + reportType slug), `expectedAnswer`, `requiredFacts`, `expectedSourceDocuments`, and `markResolved` checkbox (defaultChecked).
3. Update `apps/web/src/app/[locale]/[workspaceSlug]/feedback/[id]/page.tsx` to load `listEvaluationDatasets(workspace.id)` and render either the promoted confirmation card (linking to `/${workspaceSlug}/evaluations/${feedback.promotedDatasetId}`) or `<PromoteFeedbackToCaseForm />`.
4. Update `apps/web/src/app/[locale]/[workspaceSlug]/feedback/page.tsx` to render a `t("promotedBadge")` pill next to the review status when `f.promotedCaseId` is non-null.
5. Update `apps/web/src/app/[locale]/[workspaceSlug]/evaluations/[datasetId]/page.tsx` to render a `<Link href={\`/\${workspaceSlug}/feedback/\${c.sourceFeedbackId}\`}>` badge (`t("fromFeedback")`) on cases where `c.sourceFeedbackId` is non-null.

- [ ] **Step 2: Run full verification (`vitest`, `eslint`, `tsc --noEmit`, `next build`, and `pytest`)**

Run:
- `pnpm --filter @knowledgeops/web test`
- `pnpm --filter @knowledgeops/web lint`
- `pnpm --filter @knowledgeops/web exec tsc --noEmit`
- `pnpm --filter @knowledgeops/web build`
- `uv run pytest` (in `services/ai`)
Expected: All pass with 0 errors and 0 warnings.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/feedback/PromoteFeedbackToCaseForm.tsx "apps/web/src/app/[locale]/[workspaceSlug]/feedback/page.tsx" "apps/web/src/app/[locale]/[workspaceSlug]/feedback/[id]/page.tsx" "apps/web/src/app/[locale]/[workspaceSlug]/evaluations/[datasetId]/page.tsx" apps/web/messages/en.json apps/web/messages/zh.json
git commit -m "feat(web): add feedback-to-evaluation-case promotion UI and bidirectional links"
```
