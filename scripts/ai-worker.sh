#!/usr/bin/env bash
# Run the Python background worker (polls the Postgres job table).
set -euo pipefail
cd "$(dirname "$0")/../services/ai"
uv run python -m app.worker.runner
