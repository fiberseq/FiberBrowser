"""Record-scoped decoding (graph decode, lift composition): whether a supplementary's molecule is called.

"Hide reads without footprint calls" is decided on the primary, whose record carries the molecule's calls; a
supplementary carries none. The molecule path sees the whole molecule bundle; a record-scoped load sees records
one at a time, and the records it fetches depend on the view and on what a cache already holds. So the answer is
asked of the file, not of the fetch: the supplementary's SA tag names its other alignments, and each one at its
own position is looked up (a reader of its own, so the load's open iterator is untouched).

- Kept when any primary found there is called (or QC-fail: exempt, as everywhere), so one uncalled occurrence never
  vetoes a molecule that also has a called primary.
- Kept when no primary is found (no SA, a contig the file lacks, a primary the lift hides): as the molecule path
  keeps a supplementary whose primary is not in its fetch.
- Hidden only when every primary found is uncalled.

The answer depends only on the file, so every view, navigation order and cache state agrees. Lookups are memoised
per load, checkpointed for cancellation, and bounded by an allowance of their own (``MAX_LOOKUP_RECORDS`` records per
load, or the load's record budget when smaller); past it supplementaries are kept (counted in ``undetermined``) and a
lifted load is reported truncated. They never spend the load's own record budget, so a view shows as many reads as
before.
"""
from __future__ import annotations

from typing import Callable, Optional

MAX_LOOKUP_RECORDS = 200_000


def sa_positions(read) -> list:
    """(contig, 0-based start) of each alignment the SA tag lists (malformed entries skipped)."""
    try:
        if not read.has_tag("SA"):
            return []
        value = str(read.get_tag("SA"))
    except (KeyError, ValueError, TypeError):
        return []
    out = []
    for entry in value.split(";"):
        parts = entry.split(",")
        if len(parts) < 2 or not parts[0]:
            continue
        try:
            pos = int(parts[1]) - 1
        except ValueError:
            continue
        if pos >= 0 and (parts[0], pos) not in out:
            out.append((parts[0], pos))
    return out


class SupplementaryPrimaryLookup:
    """Per load: ``called(read)`` for a supplementary record (module docstring)."""

    def __init__(self, bam_path: str, *, lift_hidden: Optional[Callable] = None, load_budget=None,
                 max_records: int = MAX_LOOKUP_RECORDS, opener=None):
        self.bam_path = bam_path
        self.lift_hidden = lift_hidden
        self.load_budget = load_budget
        self.max_records = int(max_records) if load_budget is None else min(int(max_records),
                                                                             int(load_budget.max_records))
        self.records = 0
        self.undetermined = 0
        self._memo: dict = {}
        self._opener = opener
        self._scope = None
        self._handle = None
        self._failed = False

    def _reader(self):
        if self._handle is None and not self._failed:
            if self._opener is not None:
                self._handle = self._opener(self.bam_path)
            else:
                from services.bam_handles import private_bam_handle
                self._scope = private_bam_handle(self.bam_path)
                self._handle = self._scope.__enter__()
            self._failed = self._handle is None
        return self._handle

    def _spend(self) -> bool:
        """One looked-up record; False once this load's lookup allowance is spent (then a lifted load is reported
        truncated). An allowance of its own, not the load's record budget: a lookup reads every record over the
        primary's position, so spending the view's budget on them would shrink what a view can show."""
        self.records += 1
        if self.records <= self.max_records:
            return True
        if self.load_budget is not None:
            self.load_budget.truncated = True
        return False

    def called(self, read) -> bool:
        from services.background_work import checkpoint
        from services.bam_tags import read_has_footprint_calls
        positions = sa_positions(read)
        key = (read.query_name, tuple(positions))
        if key in self._memo:
            return self._memo[key]
        if not positions:
            self._memo[key] = True
            return True
        handle = self._reader()
        if handle is None:
            self.undetermined += 1
            return True  # (not memoised: nothing was established)
        references = set(getattr(handle, "references", ()) or ())
        name = read.query_name
        found = False
        for contig, pos in positions:
            if contig not in references:
                continue
            checkpoint()
            for record in handle.fetch(contig, pos, pos + 1):
                if not self._spend():
                    self.undetermined += 1
                    return True  # budget spent: kept, not memoised (the load reports truncation)
                if (record.query_name != name or record.is_unmapped or record.is_secondary
                        or record.is_supplementary or record.reference_start != pos):
                    continue
                if self.lift_hidden is not None and self.lift_hidden(record):
                    continue
                found = True
                if getattr(record, "is_qcfail", False) or read_has_footprint_calls(record):
                    self._memo[key] = True
                    return True
        result = not found
        self._memo[key] = result
        return result

    def close(self) -> None:
        if self._scope is not None:
            scope, self._scope = self._scope, None
            scope.__exit__(None, None, None)
        elif self._handle is not None and self._opener is not None:
            close = getattr(self._handle, "close", None)
            if close is not None:
                close()
        self._handle = None
