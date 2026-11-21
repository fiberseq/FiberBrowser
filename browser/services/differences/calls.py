"""Executable representation/hypothesis algebra; never pool alternative paths.

Each input call was classified independently. Reconciliation cannot construct
junctions from witnesses or upgrade geometry to sequence-specific carriage.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass

from .identity import content_id


@dataclass(frozen=True)
class MoleculeId:
    provenance_group: str
    library_id: str
    raw_name: str

    def __post_init__(self):
        if not all((self.provenance_group, self.library_id, self.raw_name)):
            raise ValueError("qualified molecule identity required")

    @property
    def key(self):
        return content_id("molecule:v1", asdict(self))


def witness_id(molecule: MoleculeId, record_lineage: str, query_start: int, query_end: int, *, kind="bases"):
    if not record_lineage or not 0 <= query_start <= query_end:
        raise ValueError("original physical witness interval required")
    return content_id("witness:v1", [molecule.key, record_lineage, query_start, query_end, kind])


@dataclass(frozen=True)
class Call:
    assignment: str = "unknown"
    level: str | None = None
    allele_id: str | None = None
    method: str = "geometry_only"
    reasons: tuple[str, ...] = ()
    witness_ids: tuple[str, ...] = ()
    alignment_ids: tuple[str, ...] = ()
    coverage: tuple[dict, ...] = ()

    def __post_init__(self):
        if self.assignment not in {"target", "reference", "other_allele", "ambiguous", "unknown", "unavailable"}:
            raise ValueError("invalid allele assignment")
        if self.level not in {None, "confirmed", "putative", "conflicting", "ambiguous"}:
            raise ValueError("invalid evidence tier")
        if self.assignment == "other_allele" and not self.allele_id:
            raise ValueError("other allele needs its identity")


@dataclass(frozen=True)
class Representation:
    representation_id: str
    source: str  # native | lifted
    call: Call
    admissible: bool = True
    authoritative: bool = True
    complete: bool = True


@dataclass(frozen=True)
class Hypothesis:
    hypothesis_id: str
    call: Call
    ownership: str = "coequal"  # primary | secondary | coequal
    source_alignment_ids: tuple[str, ...] = ()
    selected_map_pieces: tuple[str, ...] = ()
    target_paths: tuple[str, ...] = ()
    exclusivity_set: str | None = None
    unresolved_components: tuple[str, ...] = ()
    projection_version: str = "guarded:v1"
    map_version: str | None = None
    molecule_id: str | None = None
    record_scope: tuple[str, ...] = ()
    quality: dict | None = None
    ownership_complete: bool = False
    search_complete: bool = True


@dataclass(frozen=True)
class MoleculeEvidence:
    molecule_id: MoleculeId
    target_id: str
    target_revision: int
    geometry_evidence: dict
    allele_assignment: Call
    representations: tuple[Representation, ...]
    hypotheses: tuple[Hypothesis, ...] = ()
    observed_coverage: tuple[dict, ...] = ()
    dissenting_witnesses: tuple[dict, ...] = ()
    unprojectable_witnesses: tuple[dict, ...] = ()
    analysis_scope: str = "native_only"
    reconciliation_policy: str = "independent:v1"


def _reduce(calls, *, disagreement, unresolved):
    witnesses = tuple(sorted({w for c in calls for w in c.witness_ids}))
    alignments = tuple(sorted({a for c in calls for a in c.alignment_ids}))
    reasons = {r for c in calls for r in c.reasons}
    decisive = [c for c in calls if c.assignment in {"target", "reference", "other_allele"}]
    outcomes = {(c.assignment, c.allele_id) for c in decisive}
    if len(outcomes) > 1:
        return Call("ambiguous", "ambiguous", reasons=tuple(sorted(reasons | {disagreement})), witness_ids=witnesses, alignment_ids=alignments)
    if decisive and len(decisive) != len(calls):
        return Call("ambiguous", "ambiguous", reasons=tuple(sorted(reasons | {unresolved})), witness_ids=witnesses, alignment_ids=alignments)
    if not decisive:
        ambiguous = any(c.assignment == "ambiguous" for c in calls)
        return Call("ambiguous" if ambiguous else "unknown", "ambiguous" if ambiguous else None,
                    reasons=tuple(sorted({r for c in calls for r in c.reasons})), witness_ids=witnesses, alignment_ids=alignments)
    # Minimum justified tier; duplicates never increase confidence.
    levels = {c.level for c in decisive}
    level = next(tier for tier in (None, "ambiguous", "conflicting", "putative", "confirmed") if tier in levels)
    first = decisive[0]
    return Call(first.assignment, level, first.allele_id,
                first.method if all(c.method == first.method for c in calls) else "reconciled",
                tuple(sorted({r for c in calls for r in c.reasons})), witnesses, alignments,
                tuple(v for c in calls for v in c.coverage))


def reconcile_representations(representations, *, scope="native_only"):
    if scope not in {"native_only", "lifted_only", "combined"}:
        raise ValueError("explicit analysis scope required")
    allowed = {"native"} if scope == "native_only" else {"lifted"} if scope == "lifted_only" else {"native", "lifted"}
    selected = [r for r in representations if r.source in allowed]
    eligible = [r for r in selected if r.authoritative and r.admissible and r.call.assignment != "unavailable"]
    calls = [r.call for r in eligible]
    # An admissible but incompletely assessed placement remains a viable
    # unresolved outcome. Missing/disabled copies are unavailable instead:
    # they do not invalidate an independent available call (design §2).
    if any(not r.complete for r in eligible):
        calls.append(Call(reasons=("incomplete_representation_scope",)))
    call = _reduce(calls, disagreement="cross_representation_disagreement", unresolved="unresolved_representation")
    return {"call": asdict(call), "analysis_scope": scope,
            "complete": bool(eligible) and {r.source for r in selected} == allowed and len(eligible) == len(selected) and all(r.complete for r in selected),
            "representations": [asdict(r) for r in selected]}


def reconcile_hypotheses(hypotheses, *, primary_complete=False, search=None):
    """Unique complete primary ownership is established independently by caller.

    Unexplored primary/coequal outcomes always veto unanimity. Phase 3 must
    supply proof-carrying exclusion before supporting any exception.
    """
    hypotheses = list(hypotheses)
    primaries = [h for h in hypotheses if h.ownership == "primary"]
    if primary_complete and not primaries:
        raise ValueError("complete primary ownership requires primary hypotheses")
    chosen = primaries if primary_complete else hypotheses
    calls = [h.call for h in chosen]
    unexplored = (search or {}).get("unexplored", [])
    incomplete = (any(not h.search_complete for h in chosen)
                  or any(not primary_complete or u.get("ownership") != "secondary" for u in unexplored))
    if (search or {}).get("search_complete") is False and not unexplored:
        incomplete = True  # unspecified omissions are never safe
    if incomplete:
        calls.append(Call(reasons=("incomplete_hypothesis_search",)))
    call = _reduce(calls, disagreement="hypothesis_disagreement", unresolved="incomplete_hypothesis_search" if incomplete else "unresolved_hypothesis")
    return {"call": asdict(call), "hypotheses": [asdict(h) for h in hypotheses],
            "primary_complete": primary_complete, "search": search,
            "alternative_diagnostics": [asdict(h) for h in hypotheses if primary_complete and h.ownership != "primary"],
            "complete": not incomplete and bool(chosen)}


class MembershipIndex:
    """Dataset-qualified row and analysis identities; no global QNAME fan-out."""
    def __init__(self):
        self.rows = {}
        self.molecules = {}
        self.aliases = {}

    def add(self, dataset_id, row_id, molecule: MoleculeId, *, analysis_id=None):
        self.molecules[molecule.key] = asdict(molecule)
        index = self.rows.setdefault(dataset_id, {})
        for identity in {row_id, analysis_id} - {None}:
            if identity in index and index[identity] != molecule.key:
                raise ValueError("row identity maps to multiple molecules")
            index[identity] = molecule.key
        self.aliases.setdefault(dataset_id, {}).setdefault(molecule.raw_name, set()).add(molecule.key)

    def payload(self):
        return {"rows": self.rows, "molecules": self.molecules,
                "legacy_aliases": {d: {n: next(iter(ms)) for n, ms in names.items() if len(ms) == 1}
                                   for d, names in self.aliases.items()}}

    def fan_out(self, dataset_id, calls_by_molecule):
        return {row: calls_by_molecule[m] for row, m in self.rows.get(dataset_id, {}).items() if m in calls_by_molecule}
