"""RAG core.

This package is the SINGLE implementation of retrieval / answer / evaluation
logic. Both the FastAPI real-time path and the background worker import from
here so that online answers and evaluation runs use identical retrieval
behavior. Do not duplicate retrieval logic elsewhere.
"""
