"""Garbage-collector settings for a server that caches millions of read objects.

Read caches (the broad windows behind each view, up to 20 of them) hold
millions of small dicts and lists. CPython's full (generation 2) collection
walks every one of them and holds the GIL while it does: browsing 50-100 kb
views of two deep BAMs, full collections ran 20 times in 90 s, growing to
2.1 s each (14.5 s in all), finding nothing to free, and every request and
the event loop stopped meanwhile.

Generation-2 collections now need 100x as many generation-1 collections
(1,000 instead of 10) before they run; the young generations, which collect
almost all cyclic garbage, are unchanged. Measured on the same browse: 2 full
collections (3.0 s) instead of 20 (14.5 s).

``FIBERBROWSER_GC_FULL_THRESHOLD`` sets the value (``0`` keeps Python's
defaults). Python 3.14's incremental collector ignores this threshold in
3.14.0-3.14.4; the app ships Python 3.12.
"""
from __future__ import annotations

import gc
import os

FULL_COLLECTION_THRESHOLD = 1000
ENV = "FIBERBROWSER_GC_FULL_THRESHOLD"


def _wanted_threshold() -> int:
    raw = os.environ.get(ENV, "").strip()
    if not raw:
        return FULL_COLLECTION_THRESHOLD
    try:
        return max(0, int(raw))
    except ValueError:
        return FULL_COLLECTION_THRESHOLD


def configure_gc() -> tuple[int, int, int]:
    """Raise the generation-2 threshold (never lower one already raised)."""
    wanted = _wanted_threshold()
    young, middle, full = gc.get_threshold()
    if wanted and young and full < wanted:
        gc.set_threshold(young, middle, wanted)
    return gc.get_threshold()
