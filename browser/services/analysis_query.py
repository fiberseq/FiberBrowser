"""Shared analysis read-query normalization.

This module intentionally keeps algorithms out of routers. It only normalizes
the common "which reads should this analysis see?" contract used by clustering,
peak scanning, footprint analysis, co-accessibility, read stats, and notebook
helpers.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Iterable, Mapping, Optional, Sequence

from models.domain import WorkingSet
from services.query_params import resolve_dataset_id, resolve_dataset_ids
from services.read_metrics import DEFAULT_SAMPLE_SEED, normalize_sample_seed, sample_stable_by_id
from services.working_sets import normalize_requested_layers


def _normalize_read_id_map(state, values: Optional[Mapping[str, Sequence[str]]]) -> dict[str, list[str]]:
    if not values:
        return {}
    out: dict[str, list[str]] = {}
    for raw_dataset_id, ids in values.items():
        resolved = resolve_dataset_id(state, raw_dataset_id)
        if not resolved:
            continue
        cleaned = [str(read_id) for read_id in (ids or []) if str(read_id)]
        out[resolved] = cleaned
    return out


@dataclass(frozen=True)
class AnalysisReadQuery:
    chrom: str
    start: int
    end: int
    dataset_ids: list[str]
    spanning: bool = False
    sample_seed: str = DEFAULT_SAMPLE_SEED
    read_ids_by_dataset: dict[str, list[str]] = field(default_factory=dict)
    # None: no read scope. An explicit empty list scopes to no reads at all.
    singleton_read_ids: Optional[list[str]] = None
    max_reads: Optional[int] = None
    min_footprints: int = 0
    include_methylation: bool = True
    include_layers: bool = True
    requested_layers: tuple[str, ...] = ()
    include_layer_qualities: bool = True
    infer_legacy_layers: bool = True
    legacy_nuc_min_size: int = 90
    # DAF-seq panels showing one strand: dataset id -> 'CT' / 'GA'.
    strand_by_dataset: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_request(
        cls,
        state,
        *,
        chrom: str,
        start: int,
        end: int,
        spanning: bool = False,
        dataset_id: Optional[str] = None,
        dataset_ids: Optional[Iterable[str] | str] = None,
        sample_seed: Optional[str] = None,
        read_ids: Optional[Sequence[str]] = None,
        read_ids_by_dataset: Optional[Mapping[str, Sequence[str]]] = None,
        max_reads: Optional[int] = None,
        min_footprints: int = 0,
        include_methylation: bool = True,
        include_layers: bool = True,
        requested_layers: Optional[Iterable[str] | str] = None,
        include_layer_qualities: bool = True,
        infer_legacy_layers: Optional[bool] = None,
        legacy_nuc_min_size: Optional[int] = None,
        strand_by_dataset: Optional[Mapping[str, str]] = None,
    ) -> "AnalysisReadQuery":
        resolved_dataset_ids = resolve_dataset_ids(state, dataset_ids=dataset_ids, dataset_id=dataset_id)
        from services.read_strand import normalize_strand
        strands = {str(k): s for k, v in (strand_by_dataset or {}).items() if (s := normalize_strand(v))}
        if strands:
            include_methylation = True  # strands come from deamination marks
        return cls(
            chrom=state.translate_chrom(chrom),
            start=int(start),
            end=int(end),
            dataset_ids=resolved_dataset_ids,
            spanning=bool(spanning),
            sample_seed=normalize_sample_seed(sample_seed),
            read_ids_by_dataset=_normalize_read_id_map(state, read_ids_by_dataset),
            singleton_read_ids=(
                None if read_ids is None else [str(read_id) for read_id in read_ids if str(read_id)]
            ),
            max_reads=int(max_reads) if max_reads and int(max_reads) > 0 else None,
            min_footprints=max(0, int(min_footprints or 0)),
            include_methylation=bool(include_methylation),
            include_layers=bool(include_layers),
            requested_layers=normalize_requested_layers(requested_layers),
            include_layer_qualities=bool(include_layer_qualities),
            infer_legacy_layers=bool(
                getattr(state, "infer_legacy_layers", True)
                if infer_legacy_layers is None
                else infer_legacy_layers
            ),
            legacy_nuc_min_size=int(
                getattr(state, "legacy_nuc_min_size", 90)
                if legacy_nuc_min_size is None
                else legacy_nuc_min_size
            ),
            strand_by_dataset=strands,
        )

    @property
    def region_width(self) -> int:
        return max(0, self.end - self.start)

    def with_region(self, *, chrom: Optional[str] = None, start: Optional[int] = None, end: Optional[int] = None) -> "AnalysisReadQuery":
        return replace(
            self,
            chrom=self.chrom if chrom is None else chrom,
            start=self.start if start is None else int(start),
            end=self.end if end is None else int(end),
        )

    def read_ids_for_dataset(self, dataset_id: str) -> Optional[list[str]]:
        if dataset_id in self.read_ids_by_dataset:
            return self.read_ids_by_dataset[dataset_id]
        if len(self.dataset_ids) == 1 and self.singleton_read_ids is not None:
            return self.singleton_read_ids
        return None

    def filter_reads_for_dataset(self, dataset_id: str, reads: list[dict], *, fallback_to_all: bool = False) -> list[dict]:
        read_ids = self.read_ids_for_dataset(dataset_id)
        if read_ids is None:
            return reads
        if len(read_ids) == 0:
            return []
        requested = set(read_ids)
        filtered = [read for read in reads if read.get("id") in requested]
        return filtered if filtered or not fallback_to_all else reads

    def cap_reads(self, reads: list[dict], *, namespace: str, label: str) -> list[dict]:
        if not self.max_reads or len(reads) <= self.max_reads:
            return reads
        return sample_stable_by_id(
            reads,
            self.max_reads,
            seed=f"{self.sample_seed}:{namespace}:{label}",
        )

    def build_working_set(
        self,
        state,
        dataset_id: str,
        *,
        chrom: Optional[str] = None,
        start: Optional[int] = None,
        end: Optional[int] = None,
        spanning: Optional[bool] = None,
        read_ids: Optional[Sequence[str]] = None,
        include_methylation: Optional[bool] = None,
        include_layers: Optional[bool] = None,
        requested_layers: Optional[Iterable[str] | str] = None,
        include_layer_qualities: Optional[bool] = None,
        quality_filters: Optional[Iterable[dict]] = None,
        infer_legacy_layers: Optional[bool] = None,
        legacy_nuc_min_size: Optional[int] = None,
        broad_prefetch_multiplier: Optional[int] = None,
        force_reload: bool = False,
    ) -> WorkingSet:
        ws = self._build_working_set(state, dataset_id, chrom=chrom, start=start, end=end, spanning=spanning,
                                     read_ids=read_ids, include_methylation=include_methylation,
                                     include_layers=include_layers, requested_layers=requested_layers,
                                     include_layer_qualities=include_layer_qualities, quality_filters=quality_filters,
                                     infer_legacy_layers=infer_legacy_layers, legacy_nuc_min_size=legacy_nuc_min_size,
                                     broad_prefetch_multiplier=broad_prefetch_multiplier, force_reload=force_reload)
        strand = self.strand_by_dataset.get(dataset_id)
        if not strand:
            return ws
        from services.read_strand import filter_reads_by_strand, strand_calls, strand_totals
        reads = filter_reads_by_strand(ws.reads, strand, strand_calls(state, dataset_id))
        overlapping, spanning_count = strand_totals(ws.reads, reads, ws.total_overlapping, ws.end - ws.start)
        return WorkingSet(reads, overlapping, spanning_count, ws.chrom, ws.start, ws.end)

    def _build_working_set(
        self,
        state,
        dataset_id: str,
        *,
        chrom: Optional[str] = None,
        start: Optional[int] = None,
        end: Optional[int] = None,
        spanning: Optional[bool] = None,
        read_ids: Optional[Sequence[str]] = None,
        include_methylation: Optional[bool] = None,
        include_layers: Optional[bool] = None,
        requested_layers: Optional[Iterable[str] | str] = None,
        include_layer_qualities: Optional[bool] = None,
        quality_filters: Optional[Iterable[dict]] = None,
        infer_legacy_layers: Optional[bool] = None,
        legacy_nuc_min_size: Optional[int] = None,
        broad_prefetch_multiplier: Optional[int] = None,
        force_reload: bool = False,
    ) -> WorkingSet:
        return state.build_working_set(
            dataset_id,
            chrom or self.chrom,
            self.start if start is None else int(start),
            self.end if end is None else int(end),
            self.spanning if spanning is None else bool(spanning),
            self.min_footprints,
            read_ids=list(read_ids) if read_ids is not None else self.read_ids_for_dataset(dataset_id),
            include_methylation=self.include_methylation if include_methylation is None else bool(include_methylation),
            include_layers=self.include_layers if include_layers is None else bool(include_layers),
            requested_layers=self.requested_layers if requested_layers is None else requested_layers,
            include_layer_qualities=(
                self.include_layer_qualities
                if include_layer_qualities is None
                else bool(include_layer_qualities)
            ),
            quality_filters=quality_filters,
            infer_legacy_layers=self.infer_legacy_layers if infer_legacy_layers is None else bool(infer_legacy_layers),
            legacy_nuc_min_size=self.legacy_nuc_min_size if legacy_nuc_min_size is None else int(legacy_nuc_min_size),
            sample_seed=self.sample_seed,
            broad_prefetch_multiplier=broad_prefetch_multiplier,
            force_reload=force_reload,
        )

    def iter_working_sets(self, state):
        for dataset_id in self.dataset_ids:
            yield dataset_id, self.build_working_set(state, dataset_id)
