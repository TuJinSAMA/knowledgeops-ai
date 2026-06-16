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

export const env = {
  databaseUrl: buildDatabaseUrl(),
  aiServiceUrl: process.env.AI_SERVICE_URL ?? "http://127.0.0.1:8000",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  betterAuthSecret: process.env.BETTER_AUTH_SECRET ?? "dev-insecure-secret-change-me",
  betterAuthUrl: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
};
