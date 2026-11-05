# Module 3 Design: Feedback-to-Evaluation-Case Closed Loop

- **Date:** 2026-11-05
- **Size:** Focused domain feature across `apps/web` (1 Drizzle schema migration + server action + bidirectional UI links + audit logging).

---

## 1. Intent & Why

In production RAG operations, user complaints (`NOT_HELPFUL`, `WRONG_ANSWER`, `MISSING_KNOWLEDGE`) are the highest-signal source of regression test cases. However, in most RAG tools (Dify, Langfuse, etc.), user feedback and evaluation datasets are disconnected silos.

This module closes the loop between **Feedback Triage** and **Regression Evaluation**: when an operator reviews a feedback item, they can promote it directly into an `EvaluationCase` inside an existing (or newly created) `EvaluationDataset`, with bidirectional traceability (`Feedback ↔ EvaluationCase`) and full audit logging.

---

## 2. Goals & Non-Goals

### Goals
- **Bidirectional database linkage (`answer_feedback.promoted_case_id`):** Add a nullable `promoted_case_id UUID REFERENCES evaluation_cases(id) ON DELETE SET NULL` column to `answer_feedback` via a Drizzle migration. If the target case or dataset is later deleted, `promoted_case_id` automatically resets to `NULL` so the feedback can be promoted again.
- **One-step promotion workflow on Feedback Detail (`/[locale]/[workspaceSlug]/feedback/[id]`):**
  - Pre-fill `question` from the turn's resolved question (`feedback.question`) and `tags` from the feedback report type (e.g., `from-feedback, wrong-answer`).
  - Allow the operator to either pick an existing `EvaluationDataset` (prioritizing datasets bound to the same `knowledgeBaseId`) or create a new dataset bound to `feedback.knowledgeBaseId` inline in a single transaction.
  - Allow the operator to optionally mark the feedback's `reviewStatus` as `RESOLVED` (enabled by default) in the same atomic action.
- **Bidirectional UI visibility:**
  - **Feedback list (`/feedback`):** Display a badge (`Promoted` / `已转用例`) on feedback rows where `promotedCaseId` is non-null.
  - **Feedback detail (`/feedback/[id]`):** When already promoted, display the linked dataset name and a direct link to `/[locale]/[workspaceSlug]/evaluations/[datasetId]`.
  - **Evaluation dataset detail (`/evaluations/[datasetId]`):** For any case linked from an `answer_feedback` row, display a `From feedback →` (`来自反馈 →`) badge linking back to `/[locale]/[workspaceSlug]/feedback/[feedbackId]`.
- **Audit trail:** Record `feedback.promote-case` in `audit_logs` with `{ feedback_id, dataset_id, case_id }`.

### Non-Goals
- Automatic AI synthesis of `expectedAnswer` (operators write or curate the ground-truth `expectedAnswer` / `requiredFacts` so the regression benchmark remains human-verified).

---

## 3. Approaches Considered

### Approach A (Rejected): Stateless insert into `evaluation_cases` without foreign key
- Simply inserts a row into `evaluation_cases` from the Feedback page.
- *Why rejected:* Loses provenance. Refreshing the Feedback page cannot show whether the feedback was already added to a regression set, permits accidental duplicate cases, and cannot link back from the Evaluation Dataset page to the originating user complaint.

### Approach B (Chosen): Nullable `promoted_case_id` FK on `answer_feedback` (`ON DELETE SET NULL`) + transactional promotion
- `answer_feedback.promoted_case_id` references `evaluation_cases.id` (`ON DELETE SET NULL`).
- Promotion runs in a single database transaction: (optionally creates a new dataset bound to the feedback's KB) → inserts the `evaluation_cases` row → updates `answer_feedback.promoted_case_id` (and `review_status = 'RESOLVED'` when checked) → records `feedback.promote-case` in `audit_logs`.
- On the dataset cases query (`listEvaluationCases`), `LEFT JOIN answer_feedback ON answer_feedback.promoted_case_id = evaluation_cases.id` surfaces `sourceFeedbackId: string | null` without needing a second circular foreign key column on `evaluation_cases`.

---

## 4. Detailed Component Changes

1. **Database Schema & Migration (`apps/web/src/db/schema.ts`, `apps/web/drizzle/`)**
   - Add `promotedCaseId: uuid("promoted_case_id").references((): AnyPgColumn => evaluationCases.id, { onDelete: "set null" })` and index `answer_feedback_promoted_case_idx` to `answerFeedback`.
   - Generate and apply the Drizzle migration (`pnpm db:generate && pnpm db:migrate`).
2. **Domain & Data Access (`apps/web/src/lib/feedback.ts`, `apps/web/src/lib/evaluation.ts`, `apps/web/src/lib/audit.ts`)**
   - `AUDIT_ACTIONS.FEEDBACK_PROMOTE_CASE = "feedback.promote-case"`.
   - `listFeedback`: include `promotedCaseId: answerFeedback.promotedCaseId`.
   - `getFeedback`: `LEFT JOIN evaluation_cases` and `LEFT JOIN evaluation_datasets` on `answerFeedback.promotedCaseId` to return `promotedCaseId: string | null`, `promotedDatasetId: string | null`, and `promotedDatasetName: string | null`.
   - `promoteFeedbackToCase(workspaceId, feedbackId, params)`: transactional helper in `apps/web/src/lib/feedback.ts` that verifies tenant ownership of the feedback (and target dataset if existing), creates a new dataset if `newDatasetName` is requested, creates the `evaluation_cases` row, updates `answer_feedback.promoted_case_id` (and optionally sets `reviewStatus = "RESOLVED"`), and returns `{ caseId, datasetId, datasetName }`.
   - `listEvaluationCases`: `LEFT JOIN answer_feedback ON eq(answerFeedback.promotedCaseId, evaluationCases.id)` so each `EvaluationCaseRecord` includes `sourceFeedbackId: string | null`.
3. **Server Action (`apps/web/src/lib/feedback-actions.ts`)**
   - Add `promoteFeedbackToCaseAction(workspaceSlug: string, feedbackId: string, _prev: PromoteActionState, formData: FormData): Promise<PromoteActionState>` guarded by `requireWorkspaceMemberBySlug(workspaceSlug, "ADMIN")`.
   - Also update `updateFeedbackReviewAction` to use `withLocalePath` on `revalidatePath` (resolving the deferred minor from Module 1).
4. **UI Components & Pages (`PromoteFeedbackToCaseForm.tsx`, `feedback/page.tsx`, `feedback/[id]/page.tsx`, `evaluations/[datasetId]/page.tsx`, `en.json`, `zh.json`)**
   - Create `apps/web/src/components/feedback/PromoteFeedbackToCaseForm.tsx`.
   - Update `feedback/[id]/page.tsx` to render either the promoted status card (with deep link to `/evaluations/[datasetId]`) or `PromoteFeedbackToCaseForm`.
   - Update `feedback/page.tsx` to show a `Promoted` / `已转用例` badge next to status when `f.promotedCaseId` is set.
   - Update `evaluations/[datasetId]/page.tsx` to show a `From feedback →` / `来自反馈 →` link on cases with `c.sourceFeedbackId`.
