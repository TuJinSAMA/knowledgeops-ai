#!/usr/bin/env bash
# Run the Python AI service (FastAPI) in development mode.
set -euo pipefail
cd "$(dirname "$0")/../services/ai"
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port "${AI_SERVICE_PORT:-8000}"
