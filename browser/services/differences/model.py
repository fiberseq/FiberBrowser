"""Source-neutral, JSON-safe phase-1 contracts (absolute half-open coordinates).

Geometry and exact allele identity are deliberately separate. These contracts
do not enable projection or implement sequence-likelihood calibration.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Literal

SCHEMA_VERSION = "differences:v1"
VERSIONS = {"normalization": "local:v1", "projection": "guarded:v1",
            "matching": "candidate:v1", "reconciliation": "independent:v1",
            "daf_likelihood": "contract:v1"}


@dataclass(frozen=True)
class Span:
    contig: str
    start: int
    end: int

    def __post_init__(self):
        if not self.contig or type(self.start) is not int or type(self.end) is not int or not 0 <= self.start <= self.end:
            raise ValueError("expected absolute half-open span")


@dataclass(frozen=True)
class Sequence:
    status: Literal["available", "partial", "unavailable", "not_applicable"]
    length: int | None
    preview: str | None = None
    digest: str | None = None
    locator: dict | None = None
    provenance: str | None = None

    def __post_init__(self):
        if self.status not in {"available", "partial", "unavailable", "not_applicable"}:
            raise ValueError("unknown sequence status")
        if self.length is not None and (type(self.length) is not int or self.length < 0):
            raise ValueError("invalid complete sequence length")
        if self.preview is not None and (len(self.preview) > 60 or self.length is None or len(self.preview) > self.length):
            raise ValueError("sequence preview must be bounded and have a full length")
        if self.digest is not None and (self.status != "available" or self.length is None):
            raise ValueError("only complete sequence can have a content digest")
        if self.status == "available" and self.length is None:
            raise ValueError("available sequence needs its full length")


@dataclass(frozen=True)
class Phase:
    sample_id: str | None = None
    phase_set_id: str | None = None
    haplotype: str | None = None
    provenance: str | None = None
    confidence: float | None = None


@dataclass(frozen=True)
class Geometry:
    reference: Span
    alt_bp: int
    kind: str
    raw_pieces: tuple[dict, ...] = ()
    breakends: tuple[dict, ...] = ()
    exact_boundary: int | None = None
    confidence_interval: tuple[int, int] | None = None
    equivalent_anchors: tuple[int, int] | None = None
    search_window: tuple[int, int] | None = None

    def __post_init__(self):
        if type(self.alt_bp) is not int or self.alt_bp < 0:
            raise ValueError("invalid alternate length")
        if self.kind == "insertion" and self.reference.start != self.reference.end:
            raise ValueError("an insertion is a reference boundary")

    @property
    def ref_bp(self):
        return self.reference.end - self.reference.start

    def payload(self):
        return {**asdict(self), "ref_bp": self.ref_bp, "inserted_bp": self.alt_bp,
                "deleted_bp": self.ref_bp, "net_bp": self.alt_bp - self.ref_bp}


@dataclass(frozen=True)
class Observation:
    observation_id: str
    source: Literal["assembly", "reads"]
    producer_version: str
    content_id: str
    source_span: Span | None
    record_id: str | None
    operation_id: str
    sequence: Sequence


@dataclass(frozen=True)
class Difference:
    difference_id: str
    revision: int
    source: Literal["assembly", "reads"]
    reference_id: str
    geometry: Geometry
    sequence: Sequence
    observation_ids: tuple[str, ...]
    phase: Phase = field(default_factory=Phase)
    identity_state: Literal["provisional", "exact", "retired", "unresolved"] = "provisional"
    exact_allele_id: str | None = None
    locus_group_id: str | None = None
    lineage: tuple[str, ...] = ()
    schema_version: str = SCHEMA_VERSION

    def __post_init__(self):
        if self.source not in {"assembly", "reads"} or self.revision < 1 or not self.difference_id:
            raise ValueError("invalid difference identity")
        if self.identity_state not in {"provisional", "exact", "retired", "unresolved"}:
            raise ValueError("unknown identity state")
        if self.identity_state == "exact" and not self.exact_allele_id:
            raise ValueError("exact identity requires a canonical allele ID")

    def payload(self):
        return {**asdict(self), "geometry": self.geometry.payload()}


@dataclass(frozen=True)
class LocusGroup:
    locus_group_id: str
    revision: int
    observation_ids: tuple[str, ...]
    geometry: Geometry
    complete: bool


@dataclass(frozen=True)
class AlleleTarget:
    target_id: str
    revision: int
    target_type: Literal["geometry", "exact"]
    reference_id: str
    geometry: Geometry
    exact_allele_id: str | None = None
    diagnostic_requirements: tuple[str, ...] = ()
    competing_targets: tuple[str, ...] = ()
    policy_versions: dict = field(default_factory=lambda: dict(VERSIONS))
    frozen: bool = True

    def __post_init__(self):
        if self.target_type not in {"geometry", "exact"} or (self.target_type == "exact" and not self.exact_allele_id):
            raise ValueError("exact targets need resolved allele identity")


@dataclass(frozen=True)
class EquivalenceLink:
    endpoints: tuple[tuple[str, ...], ...]
    relation: Literal["exact", "approximate", "candidate", "compound_member", "layout_association"]
    member_roles: dict = field(default_factory=dict)
    recipe: dict = field(default_factory=dict)
    window: Span | None = None
    policy_versions: dict = field(default_factory=lambda: dict(VERSIONS))
    phase_relation: str = "unknown"
    scores: dict = field(default_factory=dict)
    alternatives: tuple[str, ...] = ()
    reasons: tuple[str, ...] = ()


@dataclass(frozen=True)
class ResultScope:
    analysis_scope: Literal["native_only", "lifted_only", "combined"]
    reference_id: str
    data_revisions: tuple[str, ...] = ()
    map_revisions: tuple[str, ...] = ()
    tiles: tuple[dict, ...] = ()
    cohort: str = "loaded"
    sampling: dict = field(default_factory=dict)
    search_complete: bool = True
    cancelled: bool = False
    unresolved: dict = field(default_factory=dict)
    versions: dict = field(default_factory=lambda: dict(VERSIONS))
