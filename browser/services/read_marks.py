"""Typed modification marks on compact reads."""
from __future__ import annotations

from typing import Any


def m6a_positions(read: dict[str, Any]) -> list[int]:
    """A read's m6A positions.

    Loaders always set ``methyl_m6a`` when they read m6A, then copy one mark
    type into the legacy ``methyl`` union (m6A, else 5mC, else deamination).
    So ``methyl`` counts as m6A only on reads with no typed marks at all
    (older callers and custom reads that only ever had ``methyl``).
    """
    typed = read.get("methyl_m6a")
    if typed:
        return typed
    if read.get("methyl_m5c") or read.get("deam"):
        return []
    return read.get("methyl") or []
