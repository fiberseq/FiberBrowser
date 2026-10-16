"""Per-dataset generation counters for cache writes.

A dataset ID can be removed and reused for another file while a load for the
old file is still running. Each invalidation bumps the ID's generation; a load
started under an older generation must not write its result into a cache.
"""
from __future__ import annotations

from typing import Any


def dataset_generation(state: Any, dataset_id: str) -> int:
    gens = getattr(state, "_dataset_generations", None)
    return gens.get(dataset_id, 0) if isinstance(gens, dict) else 0


def bump_dataset_generation(state: Any, dataset_id: str) -> None:
    gens = getattr(state, "_dataset_generations", None)
    if not isinstance(gens, dict):
        gens = {}
        try:
            setattr(state, "_dataset_generations", gens)
        except Exception:
            return
    gens[dataset_id] = gens.get(dataset_id, 0) + 1
