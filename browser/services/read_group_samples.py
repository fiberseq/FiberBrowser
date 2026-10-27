"""Opaque keys for the samples a BAM dataset's read groups declare (@RG SM), cached by file identity.

They let the client match a native dataset with the live-lift dataset of the same sample: the native inspector's
assembly comparison uses that sample's map, not whichever lifted dataset was opened first. Only equal keys matter, so
the names themselves never leave the server: each is hashed with a secret this server process draws at start (public
visitors and lab-catalog visitors see no sample or subject identifiers, and keys can't be looked up elsewhere).
"""
from __future__ import annotations

import hashlib
import os
import secrets
from functools import lru_cache

MAX_SAMPLES = 16
_SALT = secrets.token_bytes(16)


def _key(name: str) -> str:
    return hashlib.sha256(_SALT + name.encode()).hexdigest()[:16]


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
    """Sorted unique @RG SM values over the dataset's local BAM files ([] for other data, remote files or none).
    Server-side only: payloads carry sample_keys()."""
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


def sample_keys(dataset) -> list[str]:
    """The dataset's samples as opaque keys (equal for equal names within this server process; sorted)."""
    return sorted({_key(name) for name in read_group_samples(dataset)})
