"""Batch evaluation execution (T7.3).

The evaluation worker reuses the single RAG core (retrieve + answer) for every
case so reported metrics always reflect what production does. ``metrics`` holds
the deterministic, reproducible metric functions; ``run`` holds the
``RUN_EVALUATION`` job handler invoked by the worker.
"""
