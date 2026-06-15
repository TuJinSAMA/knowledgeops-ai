#!/usr/bin/env bash
# Set up local Postgres + pgvector using Homebrew postgresql@16.
# Idempotent: safe to run multiple times.
set -euo pipefail

DB_HOST="${POSTGRES_HOST:-localhost}"
DB_PORT="${POSTGRES_PORT:-5432}"
DB_NAME="${POSTGRES_DB:-knowledgeops}"
DB_USER="${POSTGRES_USER:-knowledgeops}"
DB_PASSWORD="${POSTGRES_PASSWORD:-knowledgeops}"

PG_BIN="/opt/homebrew/opt/postgresql@16/bin"
export PATH="$PG_BIN:$PATH"

echo "==> Ensuring postgresql@16 is running..."
brew services start postgresql@16 >/dev/null
sleep 2

echo "==> Ensuring pgvector is installed..."
if ! brew list pgvector >/dev/null 2>&1; then
  echo "    Installing pgvector via Homebrew (this may take a minute)..."
  brew install pgvector
else
  echo "    pgvector already installed."
fi

# Connect as the local superuser (current macOS user) to the default 'postgres' db.
ADMIN_DB="postgres"

echo "==> Creating role '${DB_USER}' (if missing)..."
psql -d "$ADMIN_DB" -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1 || \
  psql -d "$ADMIN_DB" -c "CREATE ROLE \"${DB_USER}\" LOGIN PASSWORD '${DB_PASSWORD}' CREATEDB;"

echo "==> Creating database '${DB_NAME}' (if missing)..."
psql -d "$ADMIN_DB" -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 || \
  psql -d "$ADMIN_DB" -c "CREATE DATABASE \"${DB_NAME}\" OWNER \"${DB_USER}\";"

echo "==> Enabling 'vector' extension on '${DB_NAME}'..."
psql -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS vector;"

echo "==> Verifying pgvector..."
psql -d "$DB_NAME" -tAc "SELECT extversion FROM pg_extension WHERE extname='vector';"

echo ""
echo "Done. DATABASE_URL is derived from POSTGRES_* by the apps; for reference:"
echo "  postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
