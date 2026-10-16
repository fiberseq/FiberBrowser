"""Reads a display sample must keep (fb-r4-clicks).

When the user goes to a read by name, the browser shows its locus and
highlights it; with more reads there than a panel shows, the display sample
could leave that very read out. A read request may name a few reads
(``pin_ids``) that, when they are in the request's pool (in view and passing
its filters), are added to whatever the sample picked. Only the display sample
changes: counts, working sets and profiles are as without pins.

The pins of the request being served are a context variable, so every sampling
path (direct, broad-cache, pre-projection) honours them without new arguments
through the layers between the route and the sampler.
"""
from __future__ import annotations

import contextlib
import re
from contextvars import ContextVar
from typing import Callable, Iterable, Iterator, Optional, Sequence, TypeVar

MAX_PINS = 50
_SEGMENT_SUFFIX = re.compile(r"_\d+$")
_PINS: ContextVar[frozenset] = ContextVar("fiberbrowser_pinned_read_ids", default=frozenset())

T = TypeVar("T")


def parse_pin_ids(value: Optional[str]) -> frozenset:
    """``pin_ids`` query value (comma separated) -> at most MAX_PINS ids."""
    if not value or not isinstance(value, str):
        return frozenset()
    ids = [part.strip() for part in value.split(",") if part.strip()]
    return frozenset(ids[:MAX_PINS])


@contextlib.contextmanager
def pinned_reads(ids: Iterable[str]) -> Iterator[None]:
    token = _PINS.set(frozenset(ids or ()))
    try:
        yield
    finally:
        _PINS.reset(token)


def current_pins() -> frozenset:
    return _PINS.get()


def _matches(read_id: Optional[str], pins: frozenset) -> bool:
    if not read_id:
        return False
    return read_id in pins or _SEGMENT_SUFFIX.sub("", read_id) in pins


def with_pinned(selected: Sequence[T], pool: Iterable[T], read_id: Callable[[T], Optional[str]]) -> list[T]:
    """``selected`` plus the pinned items of ``pool`` it lacks (in pool order)."""
    pins = _PINS.get()
    if not pins:
        return list(selected)
    have = {read_id(item) for item in selected}
    extra = [item for item in pool if _matches(read_id(item), pins) and read_id(item) not in have]
    if not extra:
        return list(selected)
    seen: set = set()
    unique = []
    for item in extra:
        key = read_id(item)
        if key in seen:
            continue
        seen.add(key)
        unique.append(item)
    return [*selected, *unique]


def compact_read_id(read) -> Optional[str]:
    return read.get("id") if isinstance(read, dict) else None
