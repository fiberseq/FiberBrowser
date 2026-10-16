"""Profile aggregation helpers for per-read annotation intervals."""
from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence

import numpy as np


AnnotationTuple = tuple[int, int, str, float]
AnnotationDict = Mapping[str, Sequence[AnnotationTuple]]


def build_annotation_profiles(
    annotation_dicts: Iterable[AnnotationDict],
    start: int,
    end: int,
    bins: int,
    annotation_types: Sequence[str] | None = None,
) -> dict[str, list[float]]:
    """Aggregate annotation confidence values into fixed genomic bins."""
    type_filter = set(annotation_types or [])
    region_size = end - start
    bin_size = region_size / bins
    profiles: dict[str, np.ndarray] = {}

    for ann_dict in annotation_dicts:
        for anns_list in ann_dict.values():
            for a_start, a_end, a_type, a_conf in anns_list:
                if type_filter and a_type not in type_filter:
                    continue
                if a_type not in profiles:
                    profiles[a_type] = np.zeros(bins, dtype=np.float64)

                # Half-open [a_start, a_end): no extra bin at an exact boundary.
                b0 = max(0, int((a_start - start) / bin_size))
                b1 = min(bins, int(np.ceil((a_end - start) / bin_size)))
                for b in range(b0, b1):
                    profiles[a_type][b] += a_conf

    return {key: value.tolist() for key, value in profiles.items()}
