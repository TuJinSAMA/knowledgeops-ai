"""Background worker.

Polls the Postgres `ingestion_jobs` table using SELECT ... FOR UPDATE
SKIP LOCKED so multiple worker processes can run safely. Reuses the RAG
core for the actual work. This is the cross-language queue contract: the
Next.js web app enqueues by inserting rows, the worker consumes here.
"""

import logging
import signal
import time
from types import FrameType

from sqlalchemy import text

from app.config import get_settings
from app.db import session_scope
from app.rag.ingestion import process_ingestion_job

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [worker] %(levelname)s %(message)s",
)
logger = logging.getLogger(__name__)

_should_stop = False


def _handle_signal(signum: int, _frame: FrameType | None) -> None:
    global _should_stop
    logger.info("Received signal %s, shutting down after current job...", signum)
    _should_stop = True


# Atomically claim the next runnable job.
_CLAIM_SQL = text(
    """
    UPDATE ingestion_jobs
    SET status = 'PROCESSING', locked_at = now(), attempts = attempts + 1
    WHERE id = (
        SELECT id FROM ingestion_jobs
        WHERE status = 'PENDING' AND scheduled_at <= now()
        ORDER BY scheduled_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
    )
    RETURNING id, document_id, payload, attempts, max_attempts
    """
)


def _claim_and_process() -> bool:
    """Claim one job and process it. Returns True if a job was handled."""
    with session_scope() as session:
        row = session.execute(_CLAIM_SQL).mappings().first()
        if row is None:
            return False

        job = dict(row)
        job_id = job["id"]
        logger.info("Processing ingestion job %s (attempt %s)", job_id, job["attempts"])

        try:
            process_ingestion_job(session, job)
            session.execute(
                text(
                    "UPDATE ingestion_jobs SET status = 'COMPLETED', "
                    "completed_at = now(), last_error = NULL WHERE id = :id"
                ),
                {"id": job_id},
            )
            logger.info("Job %s completed", job_id)
        except Exception as exc:  # noqa: BLE001 - record and retry/fail
            failed = job["attempts"] >= job["max_attempts"]
            session.execute(
                text(
                    "UPDATE ingestion_jobs SET status = :status, "
                    "last_error = :err, locked_at = NULL WHERE id = :id"
                ),
                {
                    "status": "FAILED" if failed else "PENDING",
                    "err": str(exc),
                    "id": job_id,
                },
            )
            logger.warning(
                "Job %s %s: %s",
                job_id,
                "failed permanently" if failed else "will retry",
                exc,
            )
        return True


def main() -> None:
    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    settings = get_settings()
    logger.info("Worker started. Polling every %ss.", settings.worker_poll_interval)

    while not _should_stop:
        try:
            handled = _claim_and_process()
        except Exception:  # noqa: BLE001 - keep the loop alive on transient errors
            logger.exception("Unexpected error while polling for jobs")
            handled = False

        if not handled:
            time.sleep(settings.worker_poll_interval)

    logger.info("Worker stopped.")


if __name__ == "__main__":
    main()
