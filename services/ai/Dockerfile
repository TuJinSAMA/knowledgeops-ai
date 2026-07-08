# syntax=docker/dockerfile:1
#
# Python AI service (services/ai). Build context is services/ai. The same
# image runs both the FastAPI service and the background worker:
#
#   service:  uvicorn app.main:app --host 0.0.0.0 --port 8000   (default CMD)
#   worker:   python -m app.worker.runner                       (compose override)

FROM python:3.12-slim AS base
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH=/opt/venv/bin:$PATH
WORKDIR /app
# uv binary for fast, reproducible dependency installs.
COPY --from=ghcr.io/astral-sh/uv:0.5 /uv /uvx /bin/

# --- deps: install locked dependencies into /opt/venv (cached) --------------
FROM base AS deps
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

# --- runtime: service + worker ----------------------------------------------
FROM base AS runtime
COPY --from=deps /opt/venv /opt/venv
COPY . .
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
