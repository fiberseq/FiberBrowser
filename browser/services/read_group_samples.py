"""The sample names a BAM dataset's read groups declare (@RG SM), cached by file identity.

They let the client match a native dataset with the live-lift dataset of the same sample: the native inspector's
assembly comparison uses that sample's map, not whichever lifted dataset was opened first.
"""
from __future__ import annotations

import os
from functools import lru_cache

MAX_SAMPLES = 16


@lru_cache(maxsize=512)
def _header_samples(path: str, mtime_ns: int, size: int) -> tuple[str, ...]:
    try:
        import pysam
        with pysam.AlignmentFile(path, "rb", check_sq=False) as bam:
            groups = bam.header.to_dict().get("RG") or []
    except Exception:
        return ()
    return tuple(sorted({str(rg["SM"]) for rg in groups if rg.get("SM")}))[:MAX_SAMPLES]


def read_group_samples(dataset) -> list[str]:
    """Sorted unique @RG SM values over the dataset's local BAM files ([] for other data, remote files or none)."""
    if getattr(dataset, "is_remote", False) or getattr(dataset, "data_type", None) not in ("bam", "bam_livelift"):
        return []
    found: set[str] = set()
    for path in getattr(dataset, "paths", None) or [getattr(dataset, "path", None)]:
        if not path:
            continue
        try:
            st = os.stat(path)
        except (OSError, TypeError, ValueError):
            continue
        found.update(_header_samples(str(path), st.st_mtime_ns, st.st_size))
    return sorted(found)[:MAX_SAMPLES]
