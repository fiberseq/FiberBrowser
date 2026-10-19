"""Live-lift capabilities, checked inside services (DESIGN_LIVE_LIFT.md §3.10).

A ``bam_livelift`` dataset supports display, versioned difference analysis and prepared-cohort clustering (compact reads,
``compact_all``, coverage, locate, tooltips). Every other analysis refuses it
with ``LiveLiftUnsupported`` (HTTP 409 and one notice), default-deny: a
service that has not been taught about lifted datasets calls ``require`` (or
reaches ``Dataset.get_reads``, which refuses) instead of silently reading the
source BAM with target coordinates.
"""
from __future__ import annotations

from typing import Iterable

LIFTED_TYPE = "bam_livelift"
# Display and prepared-cohort clustering. Versioned analysis gates follow below.
SUPPORTED = frozenset({"compact_reads", "compact_all", "coverage", "lift_correspondence_only", "locate", "tooltip", "settings", "differences", "clustering"})
# Independent v2 adapters; legacy summary/Variants/lens remain default-deny.
# Enabling either does not authorize source BAM scans in target coordinates.
SUPPORTED = SUPPORTED | {"difference_summary", "difference_split", "difference_lens"}


class LiveLiftUnsupported(Exception):
    """An analysis that does not support lifted datasets yet (HTTP 409)."""

    status_code = 409

    def __init__(self, feature: str, label: str = None):
        self.feature = feature
        self.label = label
        who = f" ({label})" if label else ""
        super().__init__(f"{_FEATURE_NAMES.get(feature, feature)} is not available for live-lift datasets{who} yet. "
                         "Use the source BAM, or a BAM aligned to this genome, for it.")


_FEATURE_NAMES = {
    "clustering": "Clustering",
    "metaprofile": "Metaprofiles",
    "peaks": "Peak scanning",
    "coaccessibility": "Co-accessibility",
    "read_stats": "Read statistics",
    "random_window": "Random windows",
    "figure": "Figure read tracks",
    "sv_summary": "The SV summary",
    "variants": "SNP/variant analysis",
    "insertion_lens": "The insertion lens",
    "alt_allele": "Alternative alleles",
    "consensus": "Footprint classes and consensus",
    "export": "Read export",
    "merge": "Merging datasets",
    "dense_reads": "This read table",
    "dafc": "DAF-C",
    "quality_impact": "Quality-filter impact",
}


def is_lifted(dataset) -> bool:
    return getattr(dataset, "data_type", None) == LIFTED_TYPE


def is_bam_backed(dataset) -> bool:
    """A dataset whose reads come from BAM records (native or lifted)."""
    return getattr(dataset, "data_type", None) in ("bam", LIFTED_TYPE)


def require(dataset, feature: str) -> None:
    """Raise ``LiveLiftUnsupported`` when ``dataset`` is lifted and ``feature`` is not supported."""
    if is_lifted(dataset) and feature not in SUPPORTED:
        raise LiveLiftUnsupported(feature, getattr(dataset, "label", None))


def unsupported_notice(feature: str) -> str:
    """The one-line notice a refused or suppressed feature gives for lifted datasets."""
    return str(LiveLiftUnsupported(feature))


def lifted_display_notices(state, dataset_id, *, include_metaprofile: bool = False) -> list:
    """Notices for a lifted display request whose extras were suppressed (§3.10):
    a metaprofile asked for and left out."""
    dataset = (getattr(state, "datasets", {}) or {}).get(dataset_id) if dataset_id else None
    if not is_lifted(dataset):
        return []
    out = []
    if include_metaprofile:
        out.append(unsupported_notice("metaprofile"))
    return out


def require_all(datasets: Iterable, feature: str) -> None:
    for dataset in datasets or ():
        require(dataset, feature)


def require_for_ids(state, dataset_ids, feature: str) -> None:
    """``require`` for datasets named by id (None or empty: every dataset open)."""
    ids = list(dataset_ids or ()) or list(getattr(state, "dataset_order", ()) or ())
    datasets = getattr(state, "datasets", {}) or {}
    for dataset_id in ids:
        require(datasets.get(dataset_id), feature)
