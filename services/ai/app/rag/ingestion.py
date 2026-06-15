"""Document ingestion pipeline (placeholder).

Real implementation will: load the document, split into chunks, compute
embeddings, and write document_chunks rows. Kept as a stub so the worker
loop and job lifecycle can be exercised end-to-end first.
"""

from sqlalchemy.orm import Session


def process_ingestion_job(session: Session, job: dict) -> None:
    # TODO: parse document -> chunk -> embed -> persist document_chunks.
    document_id = job.get("document_id")
    raise NotImplementedError(
        f"Ingestion pipeline not implemented yet (document_id={document_id})."
    )
