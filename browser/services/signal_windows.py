"""Reuse alignment signal evidence seen during a complete indexed BAM fetch.

These small arrays include reads hidden by call, signal and duplicate filters.
Complete indexed fetches, including disjoint edge ranges, can jointly cover a
nearby view without another scan. Interrupted and partitioned loads never publish.
"""
from array import array
from contextvars import ContextVar

import numpy as np

from services.background_work import file_identity
from services.byte_cache import shared_cache
from services.signal_evidence import active_signal_filters

_STATUSES = ("background", "detectable", "unclassified", "unscored", "unknown")
_CODES = {name: index for index, name in enumerate(_STATUSES)}
_windows = shared_cache("profiles")
_sources = shared_cache("profiles")
signal_window_sink = ContextVar('signal_window_sink', default=None)


def _identity(path):
    identity = file_identity([path])[0]
    # Remote sources without a stable file version use the ordinary scan.
    return identity if identity[1] is not None else None


class SignalWindow:
    def __init__(self, path, chrom, start, end, *, regions=None, source=None):
        self.path, self.chrom, self.start, self.end = str(path), chrom, start, end
        self.regions = tuple((left, right) for left, right in regions) if regions is not None else ((start, end),)
        self.source = source
        self.identity = _identity(path)
        self.max_records = min(1_000_000, _windows.max_bytes // 19)
        self.enabled = self.identity is not None and self.max_records > 0
        self.starts, self.ends = array("q"), array("q")
        self.status, self.structure, self.duplicates = array("B"), array("B"), array("B")

    def append(self, read, evidence):
        if not self.enabled:
            return
        if len(self.starts) >= self.max_records:
            # Genome-scale analysis cannot accumulate an unbounded sidecar.
            self.enabled = False
            self.starts = self.ends = self.status = self.structure = self.duplicates = None
            return
        self.starts.append(read.reference_start)
        self.ends.append(read.reference_end)
        self.status.append(_CODES[evidence["status"]])
        structure = evidence["structure"]["status"]
        self.structure.append(0 if structure == "unscored" else 1 if structure == "supported" else 2)
        self.duplicates.append(bool(getattr(read, "is_duplicate", False)))

    def finish(self):
        if not self.enabled or self.identity != _identity(self.path):
            return
        for name, dtype in (("starts", np.int64), ("ends", np.int64),
                            ("status", np.uint8), ("structure", np.uint8), ("duplicates", np.uint8)):
            values = np.frombuffer(getattr(self, name), dtype=dtype)
            values.flags.writeable = False
            setattr(self, name, values)
        self.retained_bytes = sum(getattr(self, name).nbytes for name in
                                  ("starts", "ends", "status", "structure", "duplicates")) + 1024
        sink = signal_window_sink.get()
        if sink is not None:
            sink(self)
        else:
            self.publish()

    def publish(self):
        """Publish a completed local/worker fetch only if its source still matches."""
        if not self.enabled or self.identity != _identity(self.path):
            return
        for name in ('starts', 'ends', 'status', 'structure', 'duplicates'):
            getattr(self, name).flags.writeable = False
        _windows[(self.identity, self.chrom, self.start, self.end, self.regions)] = self
        if self.source is not None:
            _sources[self.identity] = self.source
            self.source = None  # metadata has its own byte budget and LRU entry

    def counts(self, start, end, *, include_duplicates=False, spanning=False, previous=()):
        selected = (self.starts < end) & (self.ends > start)
        if not include_duplicates:
            selected &= self.duplicates == 0
        if spanning:
            selected &= (self.starts <= start) & (self.ends >= end)
        for left, right in previous:
            selected &= ~((self.starts < right) & (self.ends > left))
        status, structure = self.status[selected], self.structure[selected]
        frequencies = np.bincount(status, minlength=len(_STATUSES))
        counts = {name: int(frequencies[index]) for index, name in enumerate(_STATUSES)}
        filters = active_signal_filters()
        kept = np.ones(len(status), dtype=bool)
        if filters["hideBackground"]:
            kept &= status != _CODES["background"]
        if filters["excludeUnscored"]:
            kept &= (status != _CODES["unscored"]) & (status != _CODES["unknown"])
        if filters["requireDetectable"]:
            kept &= status == _CODES["detectable"]
        if filters["requireStructure"]:
            kept &= structure == 1
        kept_count = int(np.count_nonzero(kept))
        return dict(counts, total=len(status), kept=kept_count, hidden=len(status)-kept_count,
                    structure_scored=int(np.count_nonzero(structure)))


class _CombinedWindow:
    def __init__(self, windows):
        self.windows = windows

    def counts(self, start, end, *, previous=(), **options):
        from services.background_work import checkpoint

        counts, seen = {}, list(previous)
        for window in self.windows:
            checkpoint()
            # Every physical record overlapping an earlier complete fetch was
            # present there, including identical primary records. Exclude by
            # overlap rather than QNAME or alignment coordinates as an identity.
            values = window.counts(start, end, previous=seen, **options)
            for name, value in values.items():
                counts[name] = counts.get(name, 0) + value
            seen.extend(window.regions)
        return counts


def find_signal_source(path):
    identity = _identity(path)
    with _sources._lock:
        source = _sources.get(identity)
        if source is not None:
            _sources.move_to_end(identity)
        return source


def find_signal_window(path, chrom, start, end):
    identity = _identity(path)
    if identity is None:
        return None
    with _windows._lock:
        spans = [(left, right, key, value) for key, value in _windows.items()
                 if key[0] == identity and key[1] == chrom
                 for left, right in value.regions if left < end and right > start]
        containing = [span for span in spans if span[0] <= start and span[1] >= end]
        if containing:
            _, _, key, window = min(containing, key=lambda span: span[1] - span[0])
            _windows.move_to_end(key)
            return window
        # Select a small set of complete fetches whose union covers the view.
        # A missing/evicted middle must fall back to the ordinary scan.
        spans.sort(key=lambda span: span[0])
        selected, cursor, covered = {}, 0, start
        while covered < end:
            best = None
            while cursor < len(spans) and spans[cursor][0] <= covered:
                span = spans[cursor]
                if span[1] > covered and (best is None or span[1] > best[1]):
                    best = span
                cursor += 1
            if best is None:
                return None
            _, covered, key, window = best
            selected[key] = window
        if not selected:
            return None
        for key in selected:
            _windows.move_to_end(key)
        return _CombinedWindow(list(selected.values()))
