import {
  boolean,
  index,
  integer,
  jsonb,
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
// Job queue (cross-language: Next.js enqueues, Python worker
// consumes via SELECT ... FOR UPDATE SKIP LOCKED).
// ============================================================
export const ingestionJobs = pgTable(
  "ingestion_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
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
