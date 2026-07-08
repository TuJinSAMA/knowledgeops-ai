import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

// ============================================================
// Embedding dimension. Default targets OpenAI text-embedding-3-small.
// Keep in sync with the Python AI service.
// ============================================================
export const EMBEDDING_DIMENSIONS = 1536;

// ------------------------------------------------------------
// Enums (uppercase snake_case values per project naming rules)
// ------------------------------------------------------------
export const workspaceRole = pgEnum("workspace_role", ["OWNER", "ADMIN", "MEMBER"]);

export const documentStatus = pgEnum("document_status", [
  "PENDING",
  "PROCESSING",
  "INGESTED",
  "FAILED",
]);

export const jobStatus = pgEnum("job_status", [
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
]);

// Generic job queue task type. The worker dispatches by this value.
// INGEST_DOCUMENT is the legacy/default type so existing rows migrate forward.
export const jobType = pgEnum("job_type", ["INGEST_DOCUMENT", "RUN_EVALUATION"]);

// Author of a chat message: the human asking or the AI assistant answering.
export const messageRole = pgEnum("message_role", ["USER", "ASSISTANT"]);

// Answer feedback (Phase 6). A coarse thumbs up/down plus an optional, more
// specific report category and operator review state. Values are uppercase
// snake_case per project naming rules.
export const feedbackRating = pgEnum("feedback_rating", [
  "HELPFUL",
  "NOT_HELPFUL",
]);

export const feedbackReportType = pgEnum("feedback_report_type", [
  "WRONG_ANSWER",
  "MISSING_KNOWLEDGE",
  "OTHER",
]);

export const feedbackReviewStatus = pgEnum("feedback_review_status", [
  "NEW",
  "PENDING_REVIEW",
  "RESOLVED",
]);

// Lifecycle of a batch evaluation run (Phase 7). PENDING once enqueued, RUNNING
// while the worker processes cases, then COMPLETED or FAILED. Values are
// uppercase snake_case per project naming rules.
export const evaluationRunStatus = pgEnum("evaluation_run_status", [
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "FAILED",
]);

// ============================================================
// Auth tables (managed by better-auth; kept in better-auth's
// default shape so the adapter works out of the box. This is a
// deliberate exception to the snake_case-plural table convention
// used by the domain tables below.)
// ============================================================
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified")
    .$defaultFn(() => false)
    .notNull(),
  image: text("image"),
  createdAt: timestamp("created_at")
    .$defaultFn(() => new Date())
    .notNull(),
  updatedAt: timestamp("updated_at")
    .$defaultFn(() => new Date())
    .notNull(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").$defaultFn(() => new Date()),
  updatedAt: timestamp("updated_at").$defaultFn(() => new Date()),
});

// ============================================================
// Domain tables (project-owned, snake_case plural).
// These are the multi-tenant and knowledge models the product
// controls directly rather than delegating to a framework.
// ============================================================

// A workspace is the tenant boundary. All knowledge and members
// belong to exactly one workspace.
export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Membership + role join between a user and a workspace (RBAC).
export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: workspaceRole("role").notNull().default("MEMBER"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("workspace_members_workspace_user_idx").on(
      table.workspaceId,
      table.userId,
    ),
  ],
);

// A knowledge base groups documents within a workspace.
export const knowledgeBases = pgTable(
  "knowledge_bases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [index("knowledge_bases_workspace_idx").on(table.workspaceId)],
);

// A source document uploaded into a knowledge base.
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    knowledgeBaseId: uuid("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    mimeType: text("mime_type").notNull(),
    sourceMetadata: jsonb("source_metadata").$type<Record<string, unknown>>(),
    status: documentStatus("status").notNull().default("PENDING"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [index("documents_knowledge_base_idx").on(table.knowledgeBaseId)],
);

// A chunk of a document with its embedding vector for retrieval.
export const documentChunks = pgTable(
  "document_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    tokenCount: integer("token_count"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("document_chunks_document_idx").on(table.documentId),
    // HNSW index for cosine similarity search over embeddings.
    index("document_chunks_embedding_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
  ],
);

// ============================================================
// Generic job queue (cross-language: Next.js enqueues, Python worker
// consumes via SELECT ... FOR UPDATE SKIP LOCKED). The worker dispatches
// on `job_type`. NOTE: the table is intentionally kept named
// `ingestion_jobs` for the MVP — renaming to a neutral `jobs` would cascade
// across the existing migration, worker SQL, and tests for little gain. The
// `job_type` column generalizes it; type-specific parameters live in `payload`.
// ============================================================
export const ingestionJobs = pgTable(
  "ingestion_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobType: jobType("job_type").notNull().default("INGEST_DOCUMENT"),
    // Nullable: only document-scoped jobs (INGEST_DOCUMENT) reference a
    // document. Other types (e.g. RUN_EVALUATION) carry their parameters in
    // `payload` instead.
    documentId: uuid("document_id").references(() => documents.id, {
      onDelete: "cascade",
    }),
    status: jobStatus("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    lastError: text("last_error"),
    scheduledAt: timestamp("scheduled_at").defaultNow().notNull(),
    lockedAt: timestamp("locked_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    // Supports the worker's "next runnable job" poll.
    index("ingestion_jobs_poll_idx").on(table.status, table.scheduledAt),
  ],
);

// ============================================================
// Chat (Phase 4). A conversation groups messages exchanged against one
// knowledge base within a workspace; messages carry the assistant's resolved
// citations (jsonb) so answers stay self-contained and auditable. Trace and
// feedback relations are deferred to Phases 5/6.
// ============================================================
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    knowledgeBaseId: uuid("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("conversations_workspace_idx").on(table.workspaceId),
    index("conversations_knowledge_base_idx").on(table.knowledgeBaseId),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: messageRole("role").notNull(),
    content: text("content").notNull(),
    // Resolved citations for ASSISTANT messages: source number + chunk/document
    // ids plus an enriched snippet/title/score for display. Null for USER.
    citations: jsonb("citations").$type<unknown[]>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("messages_conversation_idx").on(table.conversationId)],
);

// ============================================================
// RAG observability (Phase 5). One trace per answer: the question, the
// retrieval config + retrieved chunks (with scores/snippets), the final context
// sent to the model, the model response, token usage, an estimated cost, the
// end-to-end latency (plus optional per-stage latency), and any error. The AI
// service returns a trace summary on its `done` event; the web layer persists
// it here so schema ownership stays single-sourced (mvp-plan §5). Every row is
// scoped to a workspace for tenant isolation.
// ============================================================
export const ragTraces = pgTable(
  "rag_traces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    // The assistant message this trace explains. Nullable because a failed turn
    // may produce a trace without ever persisting an assistant message.
    messageId: uuid("message_id").references(() => messages.id, {
      onDelete: "cascade",
    }),
    query: text("query").notNull(),
    // Optional query rewrite (not produced in the MVP; reserved for later).
    rewrittenQuery: text("rewritten_query"),
    // Retrieval configuration used for this turn (top_k, score thresholds, ...).
    retrievalConfig: jsonb("retrieval_config").$type<Record<string, unknown>>(),
    // Retrieved chunks snapshot: chunk_id / document_id / chunk_index / score /
    // snippet, as returned by the AI service retrieval stage.
    retrievedChunks: jsonb("retrieved_chunks").$type<unknown[]>(),
    finalContext: text("final_context"),
    model: text("model"),
    response: text("response"),
    // Token counts: prompt_tokens / completion_tokens / total_tokens.
    tokenUsage: jsonb("token_usage").$type<Record<string, number>>(),
    // Estimated USD cost derived from token usage and a per-model price map.
    costEstimate: numeric("cost_estimate", { precision: 12, scale: 6 }),
    // End-to-end latency measured by the web layer (milliseconds).
    latencyMs: integer("latency_ms"),
    // Optional per-stage latency from the AI service (e.g. retrieve, generate).
    stageLatencyMs: jsonb("stage_latency_ms").$type<Record<string, number>>(),
    error: text("error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("rag_traces_workspace_idx").on(table.workspaceId),
    index("rag_traces_conversation_idx").on(table.conversationId),
    index("rag_traces_message_idx").on(table.messageId),
  ],
);

// ============================================================
// Feedback loop (Phase 6). User feedback on an assistant answer turned into
// operational data, not just a like: a HELPFUL/NOT_HELPFUL rating, an optional
// specific report (wrong answer / missing knowledge / other) with a free-text
// comment, and an operator-owned review lifecycle (status + failure reason).
// Optionally links to the rag_trace for the answer so operators can jump from a
// complaint straight to the debug panel. Every row is scoped to a workspace for
// tenant isolation; (workspace_id, message_id, user_id) is unique so a user has
// at most one feedback per answer (re-submitting updates it).
// ============================================================
export const answerFeedback = pgTable(
  "answer_feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    // The trace explaining the answer, if one exists (lets operators deep-link
    // from a complaint to the debug panel). Set to null if the trace is removed.
    traceId: uuid("trace_id").references(() => ragTraces.id, {
      onDelete: "set null",
    }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    rating: feedbackRating("rating").notNull(),
    reportType: feedbackReportType("report_type"),
    comment: text("comment"),
    reviewStatus: feedbackReviewStatus("review_status").notNull().default("NEW"),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    // One feedback per (workspace, message, user); re-submitting upserts it.
    uniqueIndex("answer_feedback_workspace_message_user_idx").on(
      table.workspaceId,
      table.messageId,
      table.userId,
    ),
    index("answer_feedback_workspace_idx").on(table.workspaceId),
    index("answer_feedback_message_idx").on(table.messageId),
    index("answer_feedback_review_status_idx").on(table.reviewStatus),
  ],
);

// ============================================================
// Evaluation (Phase 7). The quality-engineering core: a workspace builds an
// evaluation dataset of cases (questions + expected answers/sources/facts),
// then triggers batch runs against a given RAG configuration. The worker reuses
// the single RAG retrieve+answer implementation (services/ai) and writes a
// per-case result plus a run-level summary, so different configs (chunk size,
// top_k, embedding model, reranker, prompt version) can be compared. Schema is
// owned here (Drizzle); the Python worker only reads/writes these rows. Every
// row is scoped to a workspace for tenant isolation.
// ============================================================

// A named collection of evaluation cases within a workspace. Optionally bound
// to a knowledge base (the answers being evaluated come from that KB).
export const evaluationDatasets = pgTable(
  "evaluation_datasets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Optional: which knowledge base this dataset evaluates against. Set null
    // (rather than cascade-delete) if the KB is removed so the dataset survives.
    knowledgeBaseId: uuid("knowledge_base_id").references(
      () => knowledgeBases.id,
      { onDelete: "set null" },
    ),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("evaluation_datasets_workspace_idx").on(table.workspaceId),
  ],
);

// A single evaluation case: a question plus the operator's ground truth. The
// jsonb expectations are optional and feed the worker's metric computation
// (retrieval hit rate, citation accuracy, correctness, groundedness).
export const evaluationCases = pgTable(
  "evaluation_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    datasetId: uuid("dataset_id")
      .notNull()
      .references(() => evaluationDatasets.id, { onDelete: "cascade" }),
    question: text("question").notNull(),
    expectedAnswer: text("expected_answer"),
    // Expected source document ids (string[]) the answer should cite.
    expectedSourceDocuments:
      jsonb("expected_source_documents").$type<string[]>(),
    // Expected chunk ids (string[]) retrieval should surface.
    expectedChunks: jsonb("expected_chunks").$type<string[]>(),
    // Facts the answer must contain (string[]) for a correctness check.
    requiredFacts: jsonb("required_facts").$type<string[]>(),
    // Free-form labels (string[]) for slicing results.
    tags: jsonb("tags").$type<string[]>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("evaluation_cases_dataset_idx").on(table.datasetId)],
);

// One batch evaluation run: a dataset evaluated under a specific RAG config. The
// worker (T7.3) consumes a RUN_EVALUATION job carrying { evaluation_run_id },
// transitions status, writes evaluation_results, and fills summary_metrics.
export const evaluationRuns = pgTable(
  "evaluation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    datasetId: uuid("dataset_id")
      .notNull()
      .references(() => evaluationDatasets.id, { onDelete: "cascade" }),
    // The RAG configuration under test: chunk_size / top_k / embedding_model /
    // reranker / prompt_version, etc. Stored verbatim so two runs are comparable.
    config: jsonb("config").$type<Record<string, unknown>>(),
    status: evaluationRunStatus("status").notNull().default("PENDING"),
    // Run-level aggregate metrics (e.g. retrieval_hit_rate, citation_accuracy,
    // correctness, groundedness, avg_latency_ms, total_cost), filled by worker.
    summaryMetrics: jsonb("summary_metrics").$type<Record<string, unknown>>(),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("evaluation_runs_workspace_idx").on(table.workspaceId),
    index("evaluation_runs_dataset_idx").on(table.datasetId),
  ],
);

// Per-case outcome of a run. Metric columns are nullable so partial results and
// fake-mode approximations both fit. `raw` holds the retrieval/answer snapshot
// (retrieved chunks, scores, the generated answer, citations) for debugging.
export const evaluationResults = pgTable(
  "evaluation_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => evaluationRuns.id, { onDelete: "cascade" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => evaluationCases.id, { onDelete: "cascade" }),
    // Retrieval hit rate / score for this case (0..1), e.g. fraction of expected
    // chunks/docs retrieved. Nullable until the worker computes it.
    retrievalHit: numeric("retrieval_hit", { precision: 6, scale: 4 }),
    citationAccuracy: numeric("citation_accuracy", { precision: 6, scale: 4 }),
    correctness: numeric("correctness", { precision: 6, scale: 4 }),
    groundedness: numeric("groundedness", { precision: 6, scale: 4 }),
    latencyMs: integer("latency_ms"),
    costEstimate: numeric("cost_estimate", { precision: 12, scale: 6 }),
    // Retrieval/answer snapshot for this case (chunks, scores, answer, citations).
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("evaluation_results_run_idx").on(table.runId),
    index("evaluation_results_case_idx").on(table.caseId),
  ],
);

// ============================================================
// Audit log (Phase 8). An append-only record of consequential write operations
// (create/delete knowledge base, upload document, trigger evaluation run, ...)
// so a workspace owner/operator can answer "who changed what, when" — an
// enterprise-readiness requirement (AGENTS.md). Every row is scoped to a
// workspace for tenant isolation. `actor_id` is set null (rather than cascade)
// when a user is removed so the historical record survives. `action` is a stable
// dotted identifier (see lib/audit.ts AUDIT_ACTIONS); `target_type`/`target_id`
// point at the affected entity and `metadata` carries action-specific details.
// ============================================================
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // The user who performed the action. Null when the actor is unknown or has
    // since been deleted (audit rows must outlive the actor).
    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("audit_logs_workspace_idx").on(table.workspaceId),
    // Supports the "recent activity, newest first" workspace audit list.
    index("audit_logs_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
  ],
);
