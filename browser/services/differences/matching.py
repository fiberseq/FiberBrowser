"""Bounded local haplotype comparison, independent of display kinds and votes.

Inputs are immutable observations in one reference frame. Alternate strings
must be complete and target-oriented. Missing sequence never means empty.
Only ordered adjacent edits on an explicitly compatible path are composed.
"""
from __future__ import annotations

from bisect import bisect_left, bisect_right
from dataclasses import asdict, dataclass, field
from itertools import zip_longest
import json
import time

from services.background_work import checkpoint
from services.reconstruction_budget import DEFAULT_LIMITS, ResourceResult
from .identity import content_id, exact_local_allele_id
from .model import EquivalenceLink, Phase, Span

NORMALIZATION_VERSION = "haplotype:v2"
MATCHING_VERSION = "local-match:v3"
_LOCAL = {"insertion", "deletion", "replacement", "snv", "mnv", "inversion"}


@dataclass(frozen=True)
class MatchingPolicy:
    version: str = MATCHING_VERSION
    anchor_bp: int = 20
    anchor_fraction: float = .05
    span_bp: int = 20
    span_fraction: float = .20
    broad_anchor_bp: int = 50
    broad_anchor_fraction: float = .20
    max_members: int = 32
    max_window_bp: int = 10_000
    max_sequence_bp: int = 100_000
    max_observations: int = 4096
    max_representations: int = 4096
    max_pairs: int = 16384
    max_links: int = 4096
    max_response_bytes: int = 16 * 1024 ** 2
    deadline_s: float = 30.

    def __post_init__(self):
        for key, value in asdict(self).items():
            if key != "version" and (not isinstance(value, (int, float)) or value <= 0):
                raise ValueError("positive matching limits required")
        for key in ("max_members", "max_window_bp", "max_sequence_bp", "max_observations",
                    "max_representations", "max_pairs", "max_links", "max_response_bytes", "anchor_bp", "span_bp", "broad_anchor_bp"):
            if type(getattr(self, key)) is not int:
                raise ValueError("integer matching limits required")


@dataclass(frozen=True)
class Edit:
    observation_id: str
    reference_id: str
    contig: str
    start: int
    end: int
    alt_bp: int
    source: str
    alt: str | None = None
    kind: str = "replacement"
    phase: Phase = field(default_factory=Phase)
    path_id: str | None = None
    hypothesis_id: str | None = None
    equivalent_anchors: tuple[int, int] | None = None
    sequence_complete: bool = False
    operation_order: int | None = None
    inversion_exact: bool = False
    retained_bridge_bp: int = 0

    def __post_init__(self):
        if (not all((self.observation_id, self.reference_id, self.contig))
                or self.source not in {"assembly", "reads"} or not 0 <= self.start <= self.end or self.alt_bp < 0):
            raise ValueError("invalid local observation")
        if self.sequence_complete and (self.alt is None or len(self.alt) != self.alt_bp):
            raise ValueError("complete alternate must have its full length")
        if self.equivalent_anchors and not self.equivalent_anchors[0] <= self.start <= self.equivalent_anchors[1]:
            raise ValueError("invalid proven anchor interval")

    @property
    def ref_bp(self):
        return self.end - self.start


@dataclass(frozen=True)
class ReferenceWindow:
    reference_id: str
    contig: str
    start: int
    sequence: str
    contig_length: int | None = None

    def __post_init__(self):
        if self.start < 0 or not self.reference_id or not self.contig:
            raise ValueError("invalid reference window")
        if self.contig_length is not None and self.end > self.contig_length:
            raise ValueError("reference window exceeds chromosome")

    @property
    def end(self):
        return self.start + len(self.sequence)


@dataclass(frozen=True)
class CanonicalAllele:
    start: int
    ref: str
    alt: str
    equivalent_anchors: tuple[int, int]
    normalization_complete: bool
    exact_allele_id: str | None


@dataclass(frozen=True)
class CompoundAllele:
    representation_id: str
    observation_ids: tuple[str, ...]
    phase: Phase
    path_id: str
    hypothesis_id: str | None
    reference_window: Span
    retained_bridges: tuple[Span, ...]
    orientations: tuple[str, ...]
    recipe: str = 'ordered_replace_with_reference_bridges'


def compound_allele(members):
    if len(members) < 2 or not members[0].path_id:
        raise ValueError('compound requires an ordered compatible path')
    first, last = members[0], members[-1]
    return CompoundAllele(content_id('compound:v2', [e.observation_id for e in members]),
        tuple(e.observation_id for e in members), first.phase, first.path_id, first.hypothesis_id,
        Span(first.contig, first.start, last.end),
        tuple(Span(first.contig, a.end, b.start) for a, b in zip(members, members[1:]) if a.end < b.start),
        tuple('-' if e.kind == 'inversion' else '+' for e in members))


def canonicalize(window, changed, *, checkpoint_fn=checkpoint):
    """Trim common flanks, then prove/rotate all pure-indel placements.

    General replacements are compared as full changed haplotypes. Two encodings
    of the same changed string consequently have the same minimized allele.
    A repeat running out of the supplied halo cannot acquire a global hash.
    """
    checkpoint_fn()
    reference, alternate = window.sequence.upper(), changed.upper()
    for sequence in (reference, alternate):
        for offset in range(0, len(sequence), 256):
            checkpoint_fn()
            if any(b not in "ACGT" for b in sequence[offset:offset + 256]):
                raise ValueError("unambiguous full haplotypes required")
    pos = window.start
    suffix = 0
    while suffix < min(len(reference), len(alternate)) and reference[-suffix - 1] == alternate[-suffix - 1]:
        if not suffix & 255:
            checkpoint_fn()
        suffix += 1
    if suffix:
        reference, alternate = reference[:-suffix], alternate[:-suffix]
    prefix = 0
    while prefix < min(len(reference), len(alternate)) and reference[prefix] == alternate[prefix]:
        if not prefix & 255:
            checkpoint_fn()
        prefix += 1
    reference, alternate, pos = reference[prefix:], alternate[prefix:], pos + prefix
    lo = hi = pos
    complete = True
    if bool(reference) != bool(alternate):
        allele = alternate or reference
        while pos > window.start and window.sequence[pos - window.start - 1].upper() == allele[-1]:
            if not pos & 255:
                checkpoint_fn()
            allele = allele[-1] + allele[:-1]
            pos -= 1
        lo = hi = pos
        rotated = allele
        while hi + len(reference) < window.end and window.sequence[hi + len(reference) - window.start].upper() == rotated[0]:
            if not hi & 255:
                checkpoint_fn()
            rotated = rotated[1:] + rotated[0]
            hi += 1
        complete = ((lo > window.start or window.start == 0)
                    and (hi + len(reference) < window.end or window.end == window.contig_length))
        if alternate:
            alternate = allele
        else:
            reference = allele
    checkpoint_fn()
    exact = (exact_local_allele_id(window.reference_id, window.contig, pos, reference, alternate,
                                  normalization=NORMALIZATION_VERSION) if complete and (reference or alternate) else None)
    return CanonicalAllele(pos, reference, alternate, (lo, hi), complete, exact)


def phase_relation(left, right):
    """Labels without a shared sample/phase set do not prove compatibility."""
    if not left.haplotype or not right.haplotype:
        return "unphased_union"
    if (left.sample_id and left.phase_set_id and left.sample_id == right.sample_id
            and left.phase_set_id == right.phase_set_id):
        return "compatible" if left.haplotype == right.haplotype else "incompatible"
    return "incomparable"


def candidate_relation(left, right, policy=MatchingPolicy()):
    if left.reference_id != right.reference_id or left.contig != right.contig:
        return None
    if left.kind not in _LOCAL or right.kind not in _LOCAL:
        return None
    if phase_relation(left.phase, right.phase) == "incompatible":
        return None
    # Retained bridges are unchanged sequence, not inserted/deleted material.
    # This only nominates a pair; full reconstruction still includes bridges.
    r, a = left.ref_bp - left.retained_bridge_bp, left.alt_bp - left.retained_bridge_bp
    s, b = right.ref_bp - right.retained_bridge_bp, right.alt_bp - right.retained_bridge_bp
    maximum = max(r, a, s, b)
    if not maximum or not max(r, a) or not max(s, b):
        return None  # reference reconstruction is not a difference allele
    tolerance = max(policy.anchor_bp, policy.anchor_fraction * maximum)
    llo, lhi = left.equivalent_anchors or (left.start, left.start)
    rlo, rhi = right.equivalent_anchors or (right.start, right.start)
    anchors = lambda tol: (llo <= rhi + tol and rlo <= lhi + tol
                           and llo + r <= rhi + s + tol and rlo + s <= lhi + r + tol)
    spans = (abs(r - s) <= max(policy.span_bp, policy.span_fraction * max(r, s))
             and abs(a - b) <= max(policy.span_bp, policy.span_fraction * max(a, b)))
    near_pure = ((a - r) * (b - s) >= 0
                 and all(abs(x - y) <= max(policy.span_bp, policy.span_fraction * maximum)
                         for x, y in ((a - r, b - s), (max(r, a), max(s, b)), (min(r, a), min(s, b)))))
    if anchors(tolerance) and (spans or near_pure):
        return "narrow" if spans else "near_pure"
    if (spans or near_pure) and anchors(max(policy.broad_anchor_bp, policy.broad_anchor_fraction * maximum)):
        return "approximate_search"
    return None


def reconstruct(edits, window, policy=MatchingPolicy(), *, checkpoint_fn=checkpoint):
    """Compose a single compatible ordered path, retaining reference bridges."""
    edits = tuple(sorted(edits, key=lambda e: (e.start, e.end, e.operation_order if e.operation_order is not None else -1, e.observation_id)))
    if not edits or len(edits) > policy.max_members:
        raise ResourceResult("budget_exceeded", "compound_members")
    checkpoint_fn()
    if len(edits) > 1 and edits[-1].end - edits[0].start > policy.max_window_bp:
        raise ResourceResult("budget_exceeded", "compound_window")
    if len(window.sequence) > policy.max_sequence_bp:
        raise ResourceResult("budget_exceeded", "reference_bases")
    if len(edits) > 1:
        if not edits[0].path_id or any((e.path_id, e.hypothesis_id, e.phase) !=
                                     (edits[0].path_id, edits[0].hypothesis_id, edits[0].phase) for e in edits):
            raise ValueError("unassessed_representation: incompatible paths or phase")
        for a, b in zip(edits, edits[1:]):
            if _ambiguous_order(a, b):
                raise ValueError("unassessed_representation: ambiguous edit order")
    size = len(window.sequence) + sum(e.alt_bp - e.ref_bp for e in edits)
    if size > policy.max_sequence_bp:
        raise ResourceResult("budget_exceeded", "reconstructed_bases")
    cursor, parts = window.start, []
    for e in edits:
        checkpoint_fn()
        if (e.reference_id, e.contig) != (window.reference_id, window.contig) or not cursor <= e.start <= e.end <= window.end:
            raise ValueError("unassessed_representation: overlap or missing reference halo")
        if e.kind not in _LOCAL:
            raise ValueError("unassessed_representation: unsupported topology")
        alt = e.alt
        if e.kind == "inversion" and alt is None and e.inversion_exact:
            alt = window.sequence[e.start - window.start:e.end - window.start].translate(str.maketrans("ACGTacgt", "TGCAtgca"))[::-1]
        elif not e.sequence_complete:
            raise ValueError("sequence_unavailable")
        if alt is None or len(alt) != e.alt_bp:
            raise ValueError("sequence_unavailable")
        parts.extend((window.sequence[cursor - window.start:e.start - window.start], alt))
        cursor = e.end
    parts.append(window.sequence[cursor - window.start:])
    changed = "".join(parts).upper()
    return changed, canonicalize(window, changed, checkpoint_fn=checkpoint_fn)


class _Search:
    def __init__(self, policy):
        self.policy, self.deadline = policy, time.monotonic() + policy.deadline_s
        self.counts = dict(representations=0, pairs=0, links=0)
        self.reasons = set()
        self.links, self.compounds, self.compared = [], {}, set()

    def check(self):
        checkpoint()
        if time.monotonic() >= self.deadline:
            raise ResourceResult("budget_exceeded", "deadline")

    def admit(self, kind):
        self.check()
        if self.counts[kind] >= getattr(self.policy, "max_" + kind):
            self.reasons.add(kind + "_cap")
            return False
        self.counts[kind] += 1
        return True


def _edit_order(e):
    return e.start, e.end, e.operation_order if e.operation_order is not None else -1, e.observation_id


def _ambiguous_order(a, b):
    return (a.start == a.end == b.start == b.end and
            (a.operation_order is None or b.operation_order is None or a.operation_order == b.operation_order))


def _compounds(edits, search):
    groups = {}
    for e in edits:
        if e.path_id:
            key = (e.reference_id, e.contig, e.path_id, e.hypothesis_id, e.phase)
            groups.setdefault(key, []).append(e)
    for group in groups.values():
        for i in range(len(group)):
            for j in range(i + 1, min(len(group), i + search.policy.max_members)):
                search.check()
                if group[j].start < group[j - 1].end:
                    search.reasons.add("overlapping_path_edits")
                    break
                if group[j].end - group[i].start > search.policy.max_window_bp:
                    break
                if _ambiguous_order(group[j - 1], group[j]):
                    search.reasons.add("unassessed_representation: ambiguous edit order")
                    break
                yield tuple(group[i:j + 1])
            if (i + search.policy.max_members < len(group)
                    and group[i + search.policy.max_members].end - group[i].start <= search.policy.max_window_bp):
                search.reasons.add("compound_members_cap")


def _representations(left, right, search):
    """Reserve singletons on both sides before fairly admitting compounds."""
    lhs, rhs = [], []
    ordered = sorted(left, key=_edit_order), sorted(right, key=_edit_order)
    for pair in zip_longest(*ordered):
        for e, out in zip(pair, (lhs, rhs)):
            if e is not None:
                if not search.admit("representations"):
                    return lhs, rhs
                out.append((e,))
    for pair in zip_longest(*(_compounds(es, search) for es in ordered)):
        for members, out in zip(pair, (lhs, rhs)):
            if members is not None:
                if not search.admit("representations"):
                    return lhs, rhs
                out.append(members)
    return lhs, rhs


def _shape(edits):
    first, last = edits[0], edits[-1]
    alt_bp = last.end - first.start + sum(e.alt_bp - e.ref_bp for e in edits)
    return Edit(content_id("representation:v1", [e.observation_id for e in edits]), first.reference_id,
                first.contig, first.start, last.end, alt_bp, first.source, phase=first.phase,
                equivalent_anchors=first.equivalent_anchors if len(edits) == 1 else None,
                retained_bridge_bp=sum(b.start - a.end for a, b in zip(edits, edits[1:])),
                kind=first.kind if len(edits) == 1 else "replacement")


def match_edits(left, right, *, window_provider=None, policy=MatchingPolicy()):
    """Typed many-to-many links. No read count is ever copied by this matcher.

    window_provider(reference_id, contig, start, end) returns a bounded full
    ReferenceWindow including normalization halo, or None. Its cache belongs to
    the caller's immutable reference/sequence revision. Search caps are explicit.
    """
    left, right = list(left), list(right)
    search = _Search(policy)
    try:
        return _match_edits(left, right, window_provider, policy, search)
    except ResourceResult as exc:
        search.reasons.add(exc.reason)
        return _matching_result(left, right, search)


def _match_edits(left, right, window_provider, policy, search):
    if len(left) + len(right) > policy.max_observations:
        return {"links": [], "search_complete": False, "reasons": ["observations_cap"], "policy": asdict(policy)}
    if sum(len(e.alt or '') for e in left + right) > DEFAULT_LIMITS.max_input_bases:
        return {"links": [], "search_complete": False, "reasons": ["input_bases_cap"], "policy": asdict(policy)}
    if len({e.observation_id for e in left + right}) != len(left + right):
        raise ValueError("matching requires unique observation IDs")
    lhs, rhs = _representations(left, right, search)
    def normalized_shape(es):
        search.check()
        shape = _shape(es)
        if shape.kind not in _LOCAL:
            search.reasons.add("unassessed_representation")
            return shape
        if window_provider:
            window = window_provider(shape.reference_id, shape.contig, shape.start, shape.end)
            search.check()
            if window:
                try:
                    _, canonical = reconstruct(es, window, policy, checkpoint_fn=search.check)
                    if not canonical.normalization_complete:
                        search.reasons.add("normalization_halo_incomplete")
                    return Edit(shape.observation_id, shape.reference_id, shape.contig, canonical.start,
                                canonical.start + len(canonical.ref), len(canonical.alt), shape.source,
                                kind="replacement", phase=shape.phase,
                                equivalent_anchors=canonical.equivalent_anchors)
                except (ValueError, ResourceResult) as exc:
                    if isinstance(exc, ResourceResult) and exc.reason == "deadline":
                        raise
                    search.reasons.add(exc.reason if isinstance(exc, ResourceResult) else str(exc))
                    if isinstance(exc, ValueError) and str(exc).startswith("unassessed_representation:"):
                        return None
        return shape
    indexed = []
    for es in rhs:
        shape = normalized_shape(es)
        if shape is not None:
            indexed.append((shape, es))
    indexed.sort(key=lambda x: (x[0].start, x[0].observation_id))
    starts = [s.start for s, _ in indexed]
    max_span = max((max(s.ref_bp, s.alt_bp) for s, _ in indexed), default=0)
    max_anchor = max((max(abs(s.start - v) for v in s.equivalent_anchors) for s, _ in indexed if s.equivalent_anchors), default=0)
    links, compared, response_bytes, compounds = search.links, search.compared, 4096, search.compounds
    for members in lhs:
        shape = normalized_shape(members)
        if shape is None:
            continue
        radius = candidate_radius(policy, max(max_span, shape.ref_bp, shape.alt_bp))
        lo, hi = shape.equivalent_anchors or (shape.start, shape.start)
        for other, other_members in indexed[bisect_left(starts, lo - radius - max_anchor):bisect_right(starts, hi + radius + max_anchor)]:
            if not search.admit("pairs"):
                break
            if phase_relation(shape.phase, other.phase) == "incompatible":
                continue
            candidate = candidate_relation(shape, other, policy)
            if not candidate:
                continue
            endpoints = (tuple(e.observation_id for e in members), tuple(e.observation_id for e in other_members))
            relation, reasons, recipe, scores, span = "candidate", [candidate], {}, {}, None
            if window_provider:
                window = window_provider(shape.reference_id, shape.contig,
                                         min(members[0].start, other_members[0].start),
                                         max(members[-1].end, other_members[-1].end))
                search.check()
                if window is not None:
                    try:
                        a, ca = reconstruct(members, window, policy, checkpoint_fn=search.check)
                        b, cb = reconstruct(other_members, window, policy, checkpoint_fn=search.check)
                        relation = "exact" if a == b else "candidate"
                        reasons.append("full_haplotype_equality" if a == b else "distinct_haplotypes")
                        span = Span(window.contig, window.start, window.end)
                        recipe = {"left": list(endpoints[0]), "right": list(endpoints[1]),
                                  "operation": "ordered_replace_with_reference_bridges",
                                  "reference_id": window.reference_id,
                                  "left_allele_id": ca.exact_allele_id, "right_allele_id": cb.exact_allele_id,
                                  "normalization_complete": ca.normalization_complete and cb.normalization_complete,
                                  "changed_digest": content_id("haplotype:v1", a) if a == b else None}
                        scores = {"full_sequence_equal": a == b, "compared_bp": max(len(a), len(b))}
                    except (ValueError, ResourceResult) as exc:
                        if isinstance(exc, ResourceResult) and exc.reason == "deadline":
                            raise
                        reasons.append(exc.reason if isinstance(exc, ResourceResult) else str(exc))
                        search.reasons.add(reasons[-1])
                        if isinstance(exc, ValueError) and str(exc).startswith("unassessed_representation:"):
                            continue
                else:
                    reasons.append("sequence_unavailable")
            else:
                reasons.append("sequence_unavailable")
            if not search.admit("links"):
                break
            link = asdict(EquivalenceLink(endpoints, relation,
                member_roles={identity: "whole" if len(endpoint) == 1 else "component"
                              for endpoint in endpoints for identity in endpoint}, recipe=recipe, window=span,
                policy_versions={"matching": policy.version, "normalization": NORMALIZATION_VERSION},
                phase_relation=phase_relation(shape.phase, other.phase), scores=scores, reasons=tuple(reasons)))
            response_bytes += len(json.dumps(link).encode())
            if response_bytes > min(policy.max_response_bytes, DEFAULT_LIMITS.max_response_bytes):
                search.reasons.add("response_bytes_cap")
                break
            compared.update(endpoints[0] + endpoints[1])
            links.append(link)
            for representation in (members, other_members):
                if len(representation) > 1:
                    compound = compound_allele(representation)
                    compounds[compound.representation_id] = asdict(compound)
        if search.reasons & {"pairs_cap", "links_cap", "deadline", "response_bytes_cap"}:
            break
    return _matching_result(left, right, search)


def candidate_radius(policy, maximum):
    """Upper bound covering every enabled anchor nomination rule."""
    return max(policy.anchor_bp, policy.anchor_fraction * maximum,
               policy.broad_anchor_bp, policy.broad_anchor_fraction * maximum)


def _matching_result(left, right, search):
    policy = search.policy
    result = {"links": search.links, "compounds": list(search.compounds.values()),
            "search_complete": not search.reasons, "reasons": sorted(search.reasons),
            "unassessed_observations": sorted({e.observation_id for e in left + right} - search.compared),
            "explored": search.counts, "policy": asdict(policy)}
    if len(json.dumps(result).encode()) > min(policy.max_response_bytes, DEFAULT_LIMITS.max_response_bytes):
        return {'links': [], 'compounds': [], 'search_complete': False, 'reasons': ['response_bytes_cap'],
                'unassessed_count': len(left) + len(right), 'policy': asdict(policy)}
    return result


def edit_from_difference(payload, *, full_alternate=None, path_id=None, hypothesis_id=None, operation_order=None):
    """Adapter from the shared Difference payload, never treating its preview
    as complete. A lazy producer must explicitly supply the full alternate.
    """
    geometry = payload['geometry']
    span = geometry['reference']
    observations = payload['observation_ids']
    if len(observations) != 1:
        raise ValueError("adapt individual observations before composing a locus group")
    return Edit(observations[0], payload['reference_id'], span['contig'], span['start'], span['end'],
                geometry['alt_bp'], payload['source'], full_alternate, kind=geometry['kind'],
                phase=Phase(**payload.get('phase', {})), path_id=path_id, hypothesis_id=hypothesis_id,
                equivalent_anchors=geometry.get('equivalent_anchors'), sequence_complete=full_alternate is not None,
                operation_order=operation_order)


@dataclass(frozen=True)
class ComparisonScope:
    assemblies: tuple[str, ...] = ()
    haplotypes: tuple[str, ...] = ()
    discovery_complete: bool = False
    correspondence_complete: bool = False
    sequence_complete: bool = False
    representations_complete: bool = False
    search_complete: bool = False
    bubbles_resolved: bool = False
    reasons: tuple[str, ...] = ()


def novelty(links, scope):
    """Absence of a candidate is not proof of assembly-relative novelty."""
    if not scope.assemblies:
        return {"status": "reads_only", "reasons": [], "scope": asdict(scope)}
    reasons = set(scope.reasons)
    if not scope.haplotypes:
        reasons.add("haplotype_scope_unavailable")
    for field in ("discovery_complete", "correspondence_complete", "sequence_complete",
                  "representations_complete", "search_complete", "bubbles_resolved"):
        if not getattr(scope, field):
            reasons.add(field.removesuffix("_complete") + "_unassessed")
    if any(link["relation"] in {"exact", "approximate"} for link in links):
        status = "assembly_equivalent" if any(l["relation"] == "exact" for l in links) else "assembly_supported_approximate"
    elif reasons or links:
        status = "unassessed"
        if links:
            reasons.add("candidate_equivalence_unresolved")
    else:
        status = "novel_relative_to_assembly"
    return {"status": status, "reasons": sorted(reasons), "scope": asdict(scope)}
