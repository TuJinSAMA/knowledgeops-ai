# Hameo KnowledgeOps AI

An enterprise AI knowledge quality platform for building, evaluating, and operating
trustworthy RAG-powered knowledge assistants.

> See [`AGENTS.md`](./AGENTS.md) for product vision, scope, and architecture decisions.

## Architecture

Hybrid: a TypeScript web layer and a Python AI layer, decoupled through Postgres.

```
apps/web        Next.js (TS): UI + business API (auth / multi-tenant / RBAC / CRUD),
                trace storage, chat streaming. Owns the DB schema via Drizzle.
services/ai     Python (FastAPI): the SINGLE RAG / retrieval / answer + evaluation
                implementation. Called in real time by the web app, and reused by
                the worker for batch ingestion / evaluation.
                Postgres + pgvector is the single source of truth and the job queue
                (Next.js enqueues rows, the Python worker consumes via SKIP LOCKED).
```

## Prerequisites

- Node.js >= 22, pnpm >= 10
- Python >= 3.12, [uv](https://docs.astral.sh/uv/)
- Homebrew PostgreSQL 16 (`brew install postgresql@16`) — or Docker (see below)

## First-time setup

```bash
# 1. Install JS and Python dependencies
pnpm install
(cd services/ai && uv sync)

# 2. Create local env files (each service owns its own)
cp apps/web/.env.example apps/web/.env
cp services/ai/.env.example services/ai/.env

# 3. Set up Postgres + pgvector (Homebrew) and run migrations
pnpm db:setup
pnpm db:migrate
```

### Alternative: Postgres via Docker

If you prefer a container instead of Homebrew Postgres:

```bash
docker compose up -d
pnpm db:migrate
```

## Running locally

Run each in its own terminal:

```bash
pnpm dev:web        # Next.js  -> http://localhost:3000
pnpm ai:dev         # FastAPI  -> http://localhost:8000
pnpm ai:worker      # background worker (polls ingestion_jobs)
```

Verify everything is wired up:

```bash
curl http://localhost:3000/api/health   # checks DB, pgvector, and AI service
curl http://localhost:8000/health       # checks DB and pgvector
```

## Useful scripts

| Command | Description |
| --- | --- |
| `pnpm dev:web` | Start the Next.js web app |
| `pnpm ai:dev` | Start the Python AI service (FastAPI) |
| `pnpm ai:worker` | Start the background worker |
| `pnpm db:setup` | Provision local Postgres role/db + pgvector |
| `pnpm db:generate` | Generate a Drizzle migration from schema changes |
| `pnpm db:migrate` | Apply pending migrations |
| `pnpm db:studio` | Open Drizzle Studio |

## Repository layout

```
apps/web/             Next.js app (TypeScript)
  src/db/             Drizzle schema + client (owns DB migrations)
  src/lib/auth.ts     better-auth configuration
  src/app/api/        health + auth routes
services/ai/          Python AI service + worker (uv)
  app/main.py         FastAPI entrypoint
  app/rag/            single RAG / ingestion implementation
  app/worker/         background job runner (SKIP LOCKED)
scripts/              db-setup / ai-dev / ai-worker helpers
docker-compose.yml    optional Postgres + pgvector container
```

## Tech stack

- **Web**: Next.js, React, Tailwind, better-auth, Drizzle ORM
- **AI**: Python, FastAPI, SQLAlchemy, pgvector
- **Database**: PostgreSQL 16 + pgvector
- **Queue**: Postgres job table (`ingestion_jobs`) consumed with `SKIP LOCKED`
