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


def bump_layer_epochs(state: Any, dataset_id: str, names) -> None:
    """A change of the dataset's rows carrying these layers alone (``invalidate_dataset_layer_caches``): loads that
    started before it (and name one of them) must not write their rows into a cache, nor be joined by later loads."""
    epochs = getattr(state, "_layer_epochs", None)
    if not isinstance(epochs, dict):
        epochs = {}
        try:
            setattr(state, "_layer_epochs", epochs)
        except Exception:
            return
    per = epochs.setdefault(dataset_id, {})
    for name in names:
        per[name] = per.get(name, 0) + 1


def layer_epochs(state: Any, dataset_id: str) -> dict:
    epochs = getattr(state, "_layer_epochs", None)
    return dict(epochs.get(dataset_id) or {}) if isinstance(epochs, dict) else {}
