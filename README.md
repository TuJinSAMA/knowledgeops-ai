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

## Running the whole stack with Docker (fastest path)

This brings up everything — Postgres + pgvector, Redis, the FastAPI AI service,
the background worker, and the Next.js web app — with one command. It works out
of the box with **deterministic fake AI providers**, so the full closed loop
runs **without any external API keys**.

```bash
docker compose up --build
```

Then open <http://localhost:3000> and follow the [end-to-end smoke test](#end-to-end-smoke-test).

What `docker compose up` does:

- `postgres` + `redis` start and become healthy.
- `migrate` (one-shot) applies all Drizzle migrations, then exits.
- `ai` (FastAPI) and `worker` (job consumer) start from the same image.
- `web` (Next.js) starts last, once migrations are applied and `ai` is healthy.

Health checks (also wired into compose):

```bash
curl http://localhost:3000/api/health   # web: DB, pgvector, Redis, AI service
curl http://localhost:8000/health       # ai:  DB, pgvector, Redis
```

### Using real AI models

The stack defaults to `AI_PROVIDER=fake` / `LLM_PROVIDER=fake`. To use real
models, create a root `.env` (read by docker compose, **never commit real
keys**) with, e.g.:

```bash
AI_PROVIDER=openrouter      # embeddings via OpenRouter (qwen3-embedding-8b)
OPENROUTER_API_KEY=sk-...
LLM_PROVIDER=deepseek       # answers via DeepSeek
DEEPSEEK_API_KEY=sk-...
INTERNAL_API_TOKEN=some-strong-shared-secret
```

`INTERNAL_API_TOKEN` is injected into both `web` and `ai` from the same value,
so they always match (a mismatch makes the AI service return 401).

---

## Local development (without containers)

### Prerequisites

- Node.js >= 22, pnpm >= 10
- Python >= 3.12, [uv](https://docs.astral.sh/uv/)
- Homebrew PostgreSQL 16 (`brew install postgresql@16`) — or run just the
  datastores via Docker: `docker compose up -d postgres redis`

### First-time setup

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

> **Shared upload directory:** the web app writes uploaded files and the Python
> worker reads them back via `FILE_STORAGE_DIR`. When the two run from different
> working directories, set the **same absolute path** for `FILE_STORAGE_DIR` in
> both `apps/web/.env` and `services/ai/.env` (the Docker stack handles this with
> a shared volume).

### Running locally

Run each in its own terminal:

```bash
pnpm dev:web        # Next.js  -> http://localhost:3000
pnpm ai:dev         # FastAPI  -> http://localhost:8000
pnpm ai:worker      # background worker (polls ingestion_jobs)
```

Verify everything is wired up:

```bash
curl http://localhost:3000/api/health   # checks DB, pgvector, Redis, and AI service
curl http://localhost:8000/health       # checks DB, pgvector, and Redis
```

---

## End-to-end smoke test

Walk the §1 MVP closed loop (see [`docs/mvp-plan.md`](./docs/mvp-plan.md)). Works
fully offline in fake-provider mode.

1. **Sign up** — open <http://localhost:3000>, create an account. A default
   workspace is created automatically (you land at `/<workspaceSlug>`).
2. **Create a knowledge base** — go to **Knowledge bases**, create one
   (requires ADMIN; the workspace owner is ADMIN).
3. **Upload documents** — open the knowledge base and upload a Markdown, text,
   and/or PDF file. Each appears as `PENDING`.
4. **Wait for ingestion** — the worker picks up the `ingestion_jobs` row,
   chunks + embeds the file, and the status moves `PENDING → PROCESSING →
   INGESTED` (the list auto-refreshes). Failures show `FAILED` with the error.
5. **Ask a question** — go to **Chat**, pick the knowledge base, and ask
   something answerable from your docs. You get a streamed answer **with
   citations** (expand to see source chunks). Off-topic questions are refused
   rather than hallucinated.
6. **Inspect the trace** — click **View trace** under the answer (or the
   **Traces** page) to see retrieved chunks + scores, final context, model,
   tokens, estimated cost, and latency.
7. **Give feedback** — mark the answer helpful / not helpful, or report a wrong
   answer / missing knowledge. Operators review it under **Feedback**.
8. **Create an evaluation dataset** — go to **Evaluations**, create a dataset
   and add a case or two (question + expected sources/facts).
9. **Trigger a run** — trigger a batch evaluation run; the worker processes the
   `RUN_EVALUATION` job, reusing the same RAG core, and writes per-case +
   summary metrics.
10. **View the dashboard** — the workspace home shows documents/chunks, answer
    volume, latency, token/cost usage, feedback distribution, and recent
    evaluation runs. Compare two runs from a dataset's **Compare runs** view.

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
  Dockerfile          web image (multi-stage: build, migrate, standalone runner)
services/ai/          Python AI service + worker (uv)
  app/main.py         FastAPI entrypoint
  app/rag/            single RAG / ingestion implementation
  app/worker/         background job runner (SKIP LOCKED)
  Dockerfile          AI service + worker image (uv)
scripts/              db-setup / ai-dev / ai-worker helpers
docker-compose.yml    full stack: postgres, redis, migrate, ai, worker, web
```

## Tech stack

- **Web**: Next.js, React, Tailwind, better-auth, Drizzle ORM
- **AI**: Python, FastAPI, SQLAlchemy, pgvector
- **Database**: PostgreSQL 16 + pgvector
- **Queue**: Postgres job table (`ingestion_jobs`) consumed with `SKIP LOCKED`
