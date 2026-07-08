import "dotenv/config";

function required(name: string, value: string | undefined): string {
  if (!value || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// Build the connection string from POSTGRES_* parts (the single source of
// truth). DATABASE_URL, if set, takes precedence so production can point at a
// managed database with a ready-made connection string.
function buildDatabaseUrl(): string {
  if (process.env.DATABASE_URL && process.env.DATABASE_URL.length > 0) {
    return process.env.DATABASE_URL;
  }
  const host = process.env.POSTGRES_HOST ?? "localhost";
  const port = process.env.POSTGRES_PORT ?? "5432";
  const name = required("POSTGRES_DB", process.env.POSTGRES_DB);
  const user = required("POSTGRES_USER", process.env.POSTGRES_USER);
  const password = required("POSTGRES_PASSWORD", process.env.POSTGRES_PASSWORD);
  return `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${name}`;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new Error(`Invalid integer for environment variable ${name}: ${raw}`);
  }
  return parsed;
}

export const env = {
  databaseUrl: buildDatabaseUrl(),
  aiServiceUrl: process.env.AI_SERVICE_URL ?? "http://127.0.0.1:8000",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  betterAuthSecret: process.env.BETTER_AUTH_SECRET ?? "dev-insecure-secret-change-me",
  betterAuthUrl: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  // Public base URL of the web app, safe to expose to the browser.
  appUrl:
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.BETTER_AUTH_URL ??
    "http://localhost:3000",
  // Shared secret for internal Web -> AI service calls (see plan §3.1).
  // Empty in local dev; required in deployments that call the AI service.
  internalApiToken: process.env.INTERNAL_API_TOKEN ?? "",
  // Per-IP fixed-window rate limits (also read directly by middleware.ts,
  // which cannot import this module from the edge runtime).
  rateLimitApi: intFromEnv("RATE_LIMIT_API", 60),
  rateLimitAuth: intFromEnv("RATE_LIMIT_AUTH", 20),
  // Per-workspace token quotas (see lib/quota.ts). 0 disables the limit.
  quotaDailyTokens: intFromEnv("QUOTA_DAILY_TOKENS", 200_000),
  quotaMonthlyTokens: intFromEnv("QUOTA_MONTHLY_TOKENS", 5_000_000),
  // Root directory for uploaded source files (see lib/storage.ts). The Python
  // ingestion worker reads the same files by joining this root with
  // documents.source_metadata.storage_path, so both processes must point at the
  // same directory (use an absolute path when web and worker run from different
  // working directories). Default mirrors the AI service's file_storage_dir.
  fileStorageDir: process.env.FILE_STORAGE_DIR ?? "./data/uploads",
  // Maximum accepted upload size in bytes (see the document upload route).
  maxUploadBytes: intFromEnv("MAX_UPLOAD_BYTES", 20 * 1024 * 1024),
};
