"""Shared API query parameter parsing helpers."""
from __future__ import annotations

from collections.abc import Iterable
from typing import Optional

LEGACY_PRIMARY_DATASET_ID = "primary"


def parse_csv_list(value: Optional[str | Iterable[str]]) -> list[str]:
    """Normalize comma-separated or iterable query values into a clean list."""
    if value is None:
        return []
    if isinstance(value, str):
        raw_values = value.split(",")
    else:
        raw_values = value
    return [str(item).strip() for item in raw_values if str(item).strip()]


def parse_optional_csv_list(value: Optional[str | Iterable[str]]) -> Optional[list[str]]:
    """Return a normalized list, or None when no values were supplied."""
    values = parse_csv_list(value)
    return values or None


def parse_csv_set(value: Optional[str | Iterable[str]]) -> set[str]:
    """Normalize comma-separated or iterable query values into a clean set."""
    return set(parse_csv_list(value))


def parse_csv_int_set(value: Optional[str | Iterable[str]]) -> set[int]:
    """Normalize comma-separated or iterable query values into an int set."""
    return {int(item) for item in parse_csv_list(value)}


def _dedupe_preserve_order(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out


def resolve_dataset_id(state, dataset_id: Optional[str] = None) -> Optional[str]:
    """Resolve omitted/legacy single-dataset params to an explicit loaded id."""
    if hasattr(state, "resolve_dataset_id"):
        return state.resolve_dataset_id(dataset_id)
    if dataset_id and str(dataset_id).strip() != LEGACY_PRIMARY_DATASET_ID:
        return str(dataset_id).strip()
    if hasattr(state, "dataset_order"):
        for did in state.dataset_order:
            if getattr(state, "datasets", {}).get(did) is not None:
                return did
    return next(iter(getattr(state, "datasets", {}) or {}), None)


def resolve_dataset_ids(state, dataset_ids=None, dataset_id: Optional[str] = None) -> list[str]:
    """Resolve multi/single dataset params, defaulting to loaded dataset order."""
    resolved = parse_csv_list(dataset_ids)
    if not resolved and dataset_id:
        resolved = parse_csv_list(dataset_id)
    if resolved:
        return _dedupe_preserve_order(
            actual
            for actual in (resolve_dataset_id(state, did) for did in resolved)
            if actual
        )
    if hasattr(state, "dataset_order"):
        return _dedupe_preserve_order(did for did in state.dataset_order if state.get_dataset(did))
    return _dedupe_preserve_order(getattr(state, "datasets", {}).keys())
