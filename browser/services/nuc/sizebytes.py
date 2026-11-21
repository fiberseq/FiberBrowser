"""The ``nucsz`` bytes FiberBrowser reads: coarse code (+16 TF), round(255 x posterior) and the z byte.

FiberHMM before 3.2.0 wrote four bytes per footprint, a named-class byte (small, hexasome, octasome, chromatosome)
second. Named classes were removed (owner, 20 Nov 2026: they need an absolute control the data does not have) and
FiberHMM 3.2.0 stops writing them, so that byte is skipped, silently, wherever it is still present; a three-byte
group (coarse, posterior, z) reads the same.
"""
from __future__ import annotations

from typing import Optional, Sequence, Tuple

#: the byte names FiberBrowser's own nucsz layers carry
NUCSZ_NAMES = ('coarse', 'posterior', 'z')
NUCSZ_Z_MISSING = 255


def nucsz_positions(n_bytes: int) -> Tuple[int, int, int]:
    """(coarse, posterior, z) positions in a nucsz group of ``n_bytes`` bytes: 3 (coarse, posterior, z) or 4 (FiberHMM
    before 3.2.0: coarse, named, posterior, z; the named byte is skipped)."""
    return (0, 1, 2) if n_bytes == 3 else (0, 2, 3)


def nucsz_bytes(q: Sequence[int]) -> Tuple[Optional[int], Optional[int], Optional[int]]:
    """One mark's (coarse, posterior, z) bytes, None where the mark has no such byte."""
    q = tuple(q or ())
    at = nucsz_positions(len(q))
    return tuple(int(q[i]) if i < len(q) and q[i] is not None else None for i in at)  # type: ignore[return-value]
