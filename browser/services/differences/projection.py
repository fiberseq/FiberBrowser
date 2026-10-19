"""Authoritative, bounded read × map composition, separate from display rows.

Only observed aligned bases are anchors. Consecutive anchors delimit a target
edit when the *entire* intervening source path is accounted for by selected
map blocks/validated gaps and a read CIGAR (never a reference skip). Thus a
source-perfect read crosses map D/I/replacements, and a read deletion of a
map insertion cancels it. No badge, hull, expected assembly bases or alternative
placement supplies observed bases. All coordinates are absolute half-open.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field, replace
import time
import hashlib
import math
import bisect

from services.background_work import checkpoint
from services.reconstruction_budget import ResourceResult
from .alleles import DafContext
from .calls import (Call, Hypothesis, MoleculeId, Representation,
                    reconcile_hypotheses, reconcile_representations, witness_id)
from .identity import content_id
from .likelihood import LikelihoodBudget, LikelihoodPolicy, compete
from .policy import SearchBudget, SearchPolicy

PROJECTION_VERSION = "read-map:v1"
_COMPLEMENT = str.maketrans("ACGTNacgtn", "TGCANtgcan")


def revcomp(sequence):
    return sequence.translate(_COMPLEMENT)[::-1]


@dataclass(frozen=True)
class ProjectionPolicy:
    version: str = PROJECTION_VERSION
    search: SearchPolicy = field(default_factory=SearchPolicy)
    max_records: int = 512
    max_runs: int = 16_384
    max_input_bases: int = 2_000_000
    max_sequence_bp: int = 100_000
    max_response_bytes: int = 16 * 1024 * 1024
    max_targets: int = 128
    max_calls: int = 16_384
    max_cigar_operations: int = 131_072
    max_spool_bytes: int = 64 * 1024 * 1024
    deadline_s: float = 30.
    min_mapq: int = 20
    cohort_alternatives: str = "exclude"
    conflicts_enabled: bool = True
    conflict_min_overlap: int = 500
    conflict_min_fraction: float = .5
    conflict_max_distance: int = 100_000
    geometry_anchor_bp: int = 20
    geometry_anchor_fraction: float = .05
    geometry_span_bp: int = 20
    geometry_span_fraction: float = .20
    map_margin_bp: int = 20_000
    source_window_merge_bp: int = 50_000

    def __post_init__(self):
        if any(type(getattr(self, k)) is not int or getattr(self, k) < 1 for k in
               ("max_records", "max_runs", "max_input_bases", "max_sequence_bp", "max_response_bytes", "max_targets", "max_calls", "max_cigar_operations", "max_spool_bytes")):
            raise ValueError("positive projection limits required")
        if not math.isfinite(self.deadline_s) or self.deadline_s <= 0 or type(self.min_mapq) is not int or not 0 <= self.min_mapq <= 255:
            raise ValueError("invalid projection quality/deadline")
        if self.cohort_alternatives not in {"include", "exclude"}:
            raise ValueError("invalid alternative placement policy")
        if self.conflict_min_overlap < 1 or not 0 <= self.conflict_min_fraction <= 1 or self.conflict_max_distance < 0:
            raise ValueError("invalid compatible-query conflict policy")
        if any(type(v) is not int or v < 0 for v in (self.geometry_anchor_bp, self.geometry_span_bp)) or any(
                not math.isfinite(v) or not 0 <= v <= 1 for v in (self.geometry_anchor_fraction, self.geometry_span_fraction)):
            raise ValueError("invalid geometry tolerances")
        if type(self.map_margin_bp) is not int or not 1000 <= self.map_margin_bp <= 1_000_000 or type(self.source_window_merge_bp) is not int or not 0 <= self.source_window_merge_bp <= 1_000_000:
            raise ValueError("invalid analysis map/fetch margins")


class ProjectionBudget:
    def __init__(self, policy=ProjectionPolicy()):
        self.policy = policy
        self.deadline = time.monotonic() + policy.deadline_s
        self.records = self.bases = self.runs = self.operations = self.spool_bytes = 0

    def check(self):
        checkpoint()
        if time.monotonic() >= self.deadline:
            raise ResourceResult("budget_exceeded", "projection_deadline")

    def charge(self, kind, amount, limit):
        self.check()
        if getattr(self, kind) + amount > limit:
            raise ResourceResult("budget_exceeded", "projection_" + kind + "_cap")
        setattr(self, kind, getattr(self, kind) + amount)


@dataclass(frozen=True)
class SourceAlignment:
    record_id: str
    molecule: MoleculeId
    contig: str
    ref_start: int
    cigar: tuple[tuple[int, int], ...]
    reverse: bool = False
    mapq: int = 60
    sequence: str | None = None
    qualities: tuple[int, ...] = ()
    supplementary: bool = False
    witnesses: tuple[dict, ...] = ()
    record_sha256: str | None = None
    record_occurrence: int = 0
    chemistry: str = "unknown"
    chemistry_provenance: str = "unavailable"

    @classmethod
    def from_bam(cls, read, molecule, *, include_sequence=False, record_occurrence=0):
        from services.sv_events import parse_sa_tag
        # Record lineage is independent of map, representation and local path.
        sha = hashlib.sha256(read.to_string().encode("utf-8")).hexdigest()
        identity = content_id("alignment-record:v1", [molecule.key, sha, record_occurrence])
        witnesses = tuple({**s, "status": "unresolved", "reason": "source_witness_not_projected"}
                          for s in parse_sa_tag(read.get_tag("SA"), read_reverse=read.is_reverse)) if read.has_tag("SA") else ()
        chemistry = read.get_tag("st") if read.has_tag("st") and read.get_tag("st") in {"CT", "GA"} else "unknown"
        return cls(identity, molecule, read.reference_name, int(read.reference_start),
                   tuple(read.cigartuples or ()), bool(read.is_reverse), int(read.mapping_quality),
                   read.query_sequence if include_sequence else None,
                   tuple(read.query_qualities) if include_sequence and read.query_qualities is not None else (),
                   bool(read.is_supplementary), witnesses, sha, record_occurrence,
                   chemistry, "BAM:st" if chemistry != "unknown" else "unavailable")


@dataclass(frozen=True)
class MapGap:
    observation_id: str
    source_start: int
    source_end: int
    ref_start: int
    ref_end: int
    reason: str

    def __post_init__(self):
        if not (0 <= self.source_start <= self.source_end and 0 <= self.ref_start <= self.ref_end):
            raise ValueError("invalid map cut intervals")


@dataclass(frozen=True)
class MapPath:
    path_id: str
    chrom: str
    source: str
    pieces: tuple
    gaps: tuple[MapGap, ...] = ()
    ownership: str = "coequal"
    map_revision: str = "unavailable"
    # Set by the map adapter, independently of any read/allele outcome.
    ownership_validated: bool = False
    map_content_id: str | None = None
    ownership_witnesses: tuple[dict, ...] = ()

    def __post_init__(self):
        if self.ownership not in {"primary", "secondary", "coequal"}:
            raise ValueError("invalid map ownership")
        if not self.pieces:
            raise ValueError("map path needs pieces")
        for p in self.pieces:
            if p.source != self.source or p.strand != self.pieces[0].strand:
                raise ValueError("a map path has one source orientation")
            if p.t_end <= p.t_start or p.t_end - p.t_start != p.q_end - p.q_start or p.q_start < 0 or p.t_start < 0:
                raise ValueError("invalid affine map block")
        for left, right in zip(sorted(self.pieces, key=lambda p: p.t_start), sorted(self.pieces, key=lambda p: p.t_start)[1:]):
            if left.t_end > right.t_start:
                raise ValueError("overlapping map alternatives require separate paths")
            if ((left.strand == "+" and left.q_end > right.q_start) or
                    (left.strand == "-" and right.q_end > left.q_start)):
                raise ValueError("noncollinear map choices require separate paths")


def _walk(alignment, check=checkpoint):
    """CIGAR coordinates in source-reference order, including hard clips."""
    source, query, seq = alignment.ref_start, 0, 0
    aligned, skips, clips = [], [], []
    for i, (op, n) in enumerate(alignment.cigar):
        if not i & 255:
            check()
        if n <= 0 or op not in range(9):
            raise ValueError("invalid source CIGAR")
        if op in (0, 7, 8):
            aligned.append((source, source + n, query, seq))
        if op == 3:
            skips.append((source, source + n))
        if op in (4, 5):
            clips.append((query, query + n, op == 5))
        if op in (0, 2, 3, 7, 8):
            source += n
        if op in (0, 1, 4, 5, 7, 8):
            query += n
        if op in (0, 1, 4, 7, 8):
            seq += n
    if alignment.sequence is not None and len(alignment.sequence) != seq:
        raise ValueError("BAM SEQ/CIGAR length mismatch")
    if alignment.qualities and len(alignment.qualities) != seq:
        raise ValueError("BAM quality/SEQ length mismatch")
    return aligned, skips, clips, source, query, seq


def _boundary(piece, source):
    return (piece.t_start + source - piece.q_start if piece.strand == "+"
            else piece.t_end - (source - piece.q_start))


def _covers(intervals, start, end):
    for a, b in sorted(intervals):
        if a > start:
            break
        start = max(start, b)
        if start >= end:
            return True
    return start >= end


def _transition(path, left, right, skips):
    """Prove every crossed map cut; coordinates alone cannot bridge a hole."""
    a, b = sorted((left["source_exit"], right["source_entry"]))
    if any(x < b and y > a for x, y in skips):
        return False
    if not _covers([(p.q_start, p.q_end) for p in path.pieces] +
                   [(g.source_start, g.source_end) for g in path.gaps], a, b):
        return False
    # Target gaps, including zero-source-width D, require the exact map cut.
    pieces = sorted(path.pieces, key=lambda p: p.t_start)
    for p, q in zip(pieces, pieces[1:]):
        if p.t_end < left["ref_end"] or q.t_start > right["ref_start"]:
            continue
        x, y = ((p.q_end, q.q_start) if p.strand == "+" else (q.q_end, p.q_start))
        if p.t_end == q.t_start and x == y:
            continue
        if not any((g.ref_start, g.ref_end, g.source_start, g.source_end) ==
                   (p.t_end, q.t_start, x, y) for g in path.gaps):
            return False
    return True


def compose_alignment(alignment, path, *, budget=None, walk=None):
    """Return observed base blocks, edits and explicit endpoint/SEQ mappings.

    No full sequence is needed for geometry. Sequence, when requested, always
    comes from BAM SEQ; map sequence is never substituted for unavailable bases.
    """
    budget = budget or ProjectionBudget()
    budget.check()
    aligned, skips, clips, source_end, length, seq_length = walk or _walk(alignment, budget.check)
    minus = path.pieces[0].strand == "-"
    hard_left = alignment.cigar[0][1] if alignment.cigar and alignment.cigar[0][0] == 5 else 0
    runs = []
    if path.source == alignment.contig:
        for p in path.pieces:
            budget.check()
            for i, (s, e, q, seq) in enumerate(aligned):
                if not i & 255:
                    budget.check()
                a, b = max(s, p.q_start), min(e, p.q_end)
                if a >= b:
                    continue
                budget.charge("runs", 1, budget.policy.max_runs)
                raw_q0, raw_q1 = q + a - s, q + b - s
                sq0, sq1 = seq + a - s, seq + b - s
                q0, q1 = (length - raw_q1, length - raw_q0) if minus else (raw_q0, raw_q1)
                t0, t1 = sorted((_boundary(p, a), _boundary(p, b)))
                canonical = ((length - raw_q1, length - raw_q0) if alignment.reverse else (raw_q0, raw_q1))
                runs.append(dict(ref_start=t0, ref_end=t1, q_start=q0, q_end=q1,
                    seq_q=[sq0, sq1], seq_reverse=minus, source_start=a, source_end=b,
                    source_entry=b if minus else a, source_exit=a if minus else b,
                    original_query=list(canonical), record_id=alignment.record_id))
    runs.sort(key=lambda r: (r["ref_start"], r["q_start"]))
    cuts, components, unresolved = [], [], list(alignment.witnesses)
    # Aligned source/query tails outside the selected path stay witnesses.
    # They are not evidence of another target chromosome or a clip conflict.
    covered = []
    for a, b in sorted([(p.q_start, p.q_end) for p in path.pieces] +
                       [(g.source_start, g.source_end) for g in path.gaps if g.source_end > g.source_start]):
        if covered and a <= covered[-1][1]:
            covered[-1][1] = max(covered[-1][1], b)
        else:
            covered.append([a, b])
    ends = [b for _, b in covered]
    for s, e, q, _ in aligned:
        budget.check()
        cursor = s
        for a, b in covered[bisect.bisect_right(ends, s):]:
            if a >= e:
                break
            if a > cursor:
                x, y = q+cursor-s, q+min(a, e)-s
                unresolved.append(dict(reason="source_path_outside_selected_map", record_id=alignment.record_id,
                    source_start=cursor, source_end=min(a, e), original_query=[length-y, length-x] if alignment.reverse else [x, y]))
            cursor = max(cursor, b)
            if cursor >= e:
                break
        if cursor < e:
            x, y = q+cursor-s, q+e-s
            unresolved.append(dict(reason="source_path_outside_selected_map", record_id=alignment.record_id,
                source_start=cursor, source_end=e, original_query=[length-y, length-x] if alignment.reverse else [x, y]))
    component = []
    for run in runs:
        if component:
            left = component[-1]
            continuous = (run["ref_start"] >= left["ref_end"] and run["q_start"] >= left["q_end"]
                          and _transition(path, left, run, skips))
            if not continuous:
                components.append(component)
                component = []
                unresolved.append(dict(reason="incompatible_or_unresolved_path", record_id=alignment.record_id))
            else:
                r0, r1 = left["ref_end"], run["ref_start"]
                q0, q1 = left["q_end"], run["q_start"]
                if r0 != r1 or q0 != q1:
                    if max(r1 - r0, q1 - q0) > budget.policy.max_sequence_bp:
                        raise ResourceResult("budget_exceeded", "projection_sequence_cap")
                    sq0, sq1 = ((run["seq_q"][1], left["seq_q"][0]) if minus else
                                (left["seq_q"][1], run["seq_q"][0]))
                    available = alignment.sequence is not None and 0 <= sq0 <= sq1 <= seq_length
                    observed = alignment.sequence[sq0:sq1] if available else None
                    if observed is not None and minus:
                        observed = revcomp(observed)
                    cuts.append(dict(ref_start=r0, ref_end=r1, alt_bp=q1-q0, q_start=q0, q_end=q1,
                        seq_q=[sq0, sq1], seq_reverse=minus, observed=observed,
                        source_ref_start=min(left["source_exit"], run["source_entry"]),
                        source_ref_end=max(left["source_exit"], run["source_entry"]),
                        map_observation_ids=[g.observation_id for g in path.gaps
                            if left["ref_end"] <= g.ref_start <= g.ref_end <= run["ref_start"]],
                        method="assembly_projection", complete=True, component=len(components)))
        component.append(run)
    if component:
        components.append(component)
    # Partial and insertion-only paths have viable placement but no invented flanks.
    partial = [asdict(g) for g in path.gaps if g.source_start < source_end and g.source_end > alignment.ref_start
               and not any(g.observation_id in c["map_observation_ids"] for c in cuts)]
    mapped_clips = []
    first_aligned = min((x[2] for x in aligned), default=length)
    for a, b, hard in clips:
        left_side = b <= first_aligned
        source_anchor = alignment.ref_start if left_side else source_end
        candidates = {_boundary(p, source_anchor) for p in path.pieces if p.q_start <= source_anchor <= p.q_end}
        # A clip at a deleted boundary with two target endpoints is unresolved.
        if len(candidates) == 1:
            q0, q1 = (length-b, length-a) if minus else (a, b)
            mapped_clips.append(dict(ref=next(iter(candidates)), side="R" if left_side == minus else "L",
                q_start=q0, q_end=q1, hard=hard, origin_record_id=alignment.record_id,
                source_anchor=source_anchor, query_frame="target_oriented_full_molecule"))
        else:
            unresolved.append(dict(reason="clip_anchor_unprojectable", record_id=alignment.record_id,
                source_anchor=source_anchor, original_query=[length-b, length-a] if alignment.reverse else [a, b], hard=hard))
    return dict(record_id=alignment.record_id, path_id=path.path_id, chrom=path.chrom,
        source_contig=alignment.contig, source_start=alignment.ref_start, source_end=source_end,
        source_cigar=[list(x) for x in alignment.cigar], query_length=length,
        query_frame="target_oriented_full_molecule", original_query_frame="canonical_molecule",
        sequence_span=[length-hard_left-seq_length, length-hard_left] if minus else [hard_left, hard_left+seq_length],
        alignment_orientation="reverse" if alignment.reverse != minus else "forward",
        ref_start=min((r["ref_start"] for r in runs), default=None),
        ref_end=max((r["ref_end"] for r in runs), default=None), base_blocks=runs,
        components=components, edits=cuts, clips=mapped_clips, partial_gaps=partial,
        unresolved_witnesses=unresolved, mapq=alignment.mapq, source_reverse=alignment.reverse,
        projection_version=PROJECTION_VERSION)


def _slice_observed(alignment, projected, start, end):
    """Diagnostic slice through one component; both observed flanks required."""
    for component in projected["components"]:
        left = next((r for r in component if r["ref_start"] <= start-1 < r["ref_end"]), None)
        right = next((r for r in component if r["ref_start"] <= end < r["ref_end"]), None)
        if left is None or right is None:
            continue
        q0 = left["q_start"] + start - left["ref_start"]
        q1 = right["q_start"] + end - right["ref_start"]
        if q1 < q0:
            continue
        hard = alignment.cigar[0][1] if alignment.cigar[0][0] == 5 else 0
        minus = left["seq_reverse"]
        a, b = ((projected["query_length"]-q1-hard, projected["query_length"]-q0-hard)
                if minus else (q0-hard, q1-hard))
        if alignment.sequence is None or not 0 <= a <= b <= len(alignment.sequence):
            return None, (), (q0, q1), False
        sequence = alignment.sequence[a:b]
        qualities = alignment.qualities[a:b]
        if minus:
            sequence, qualities = revcomp(sequence), qualities[::-1]
        return sequence, qualities, (q0, q1), True
    return None, (), None, False


def classify_projection(alignment, projected, target, *, context=None, likelihood_policy=None, likelihood_budget=None, min_mapq=20, diagnostic_halo_bp=10_000, geometry_policy=None):
    """One call inside one path. Geometry and sequence calls stay independent."""
    start, end, alt_bp = target["ref_start"], target["ref_end"], target["alt_bp"]
    target_id = target["target_id"]
    policy = geometry_policy or ProjectionPolicy()
    def geometry_matches(e):
        r, a = e["ref_end"]-e["ref_start"], e["alt_bp"]
        size = max(end-start, alt_bp, r, a)
        anchor = max(policy.geometry_anchor_bp, policy.geometry_anchor_fraction*size)
        delta, expected_delta = a-r, alt_bp-(end-start)
        same_direction = not expected_delta or delta*expected_delta > 0
        return (same_direction and abs(e["ref_start"]-start) <= anchor and abs(e["ref_end"]-end) <= anchor
                and abs(r-(end-start)) <= max(policy.geometry_span_bp, policy.geometry_span_fraction*max(r, end-start))
                and abs(a-alt_bp) <= max(policy.geometry_span_bp, policy.geometry_span_fraction*max(a, alt_bp)))
    matching = [e for e in projected["edits"] if geometry_matches(e)]
    flanks = any(any(r["ref_start"] <= start-1 < r["ref_end"] for r in c) and
                 any(r["ref_start"] <= end < r["ref_end"] for r in c) for c in projected["components"])
    relevant = [e for e in projected["edits"] if
                (e["ref_start"] <= end and e["ref_end"] >= start)]
    geometry = Call("target", "confirmed", target_id, "assembly_projection") if matching and flanks else (
        Call("reference", "confirmed", "reference", "assembly_projection") if flanks and not relevant else
        Call(reasons=("competing_composed_edit" if flanks else "missing_observed_flanks",)))
    if alignment.mapq < min_mapq:
        geometry = Call(reasons=("low_projection_mapq",))
    call = geometry
    sequence_assessment = None
    diagnostic_start, diagnostic_end = target.get("diagnostic_start", start), target.get("diagnostic_end", end)
    observed, qualities, interval, complete = _slice_observed(alignment, projected, diagnostic_start, diagnostic_end)
    if target.get("target_type", "geometry") == "exact":
        candidates = dict(target.get("candidates") or {})
        competition_complete = target.get("competition_complete") is True and target_id in candidates and "reference" in candidates
        policy = likelihood_policy or LikelihoodPolicy()
        context = replace(context or DafContext("unknown", "unavailable"),
            reverse_complemented=projected["alignment_orientation"] == "reverse", base_qualities=qualities)
        # A deletion is structurally diagnostic even without BAM SEQ, but a
        # competing empty allele at this boundary is never silently excluded.
        structural = (any((e["ref_start"], e["ref_end"], e["alt_bp"]) == (start, end, 0) for e in matching)
                      and flanks and alt_bp == 0 and end > start and competition_complete
                      and (diagnostic_start, diagnostic_end) == (start, end)
                      and candidates.get(target_id) == "" and all(v is not None and v != "" for k, v in candidates.items() if k != target_id))
        if structural:
            call = Call("target", "confirmed", target_id, "assembly_projection", ("validated_deletion_path",))
            sequence_assessment = dict(complete=True, method="validated_deletion_path", observed_bases=False)
        else:
            result = compete(observed, candidates, target_id=target_id,
                complete=complete and competition_complete, context=context, policy=policy,
                budget=likelihood_budget, geometry_level=geometry.level or "confirmed")
            call = Call(**{**result["call"], "reasons": tuple(result["call"]["reasons"])})
            sequence_assessment = result
        if not flanks or alignment.mapq < min_mapq:
            call = Call(reasons=geometry.reasons or ("missing_observed_flanks",))
        if call.assignment == "reference":
            # Without a reconstructed common window, a displaced plausible
            # repeat/compound edit cannot become a reference exclusion proof.
            for e in projected["edits"]:
                outside = e["ref_start"] < diagnostic_start or e["ref_end"] > diagnostic_end
                size = max(end-start, alt_bp, e["ref_end"]-e["ref_start"], e["alt_bp"])
                plausible = (abs(e["ref_start"]-start) <= diagnostic_halo_bp and
                    abs(e["alt_bp"]-alt_bp) <= max(20, .2*size) and
                    abs(e["ref_end"]-e["ref_start"]-(end-start)) <= max(20, .2*size))
                if outside and plausible:
                    call = Call("ambiguous", "ambiguous", reasons=("diagnostic_window_misses_geometry",))
                    break
    if projected["unresolved_witnesses"]:
        # Missing target correspondence is not an elsewhere conflict. Keep an
        # explicit unresolved conflict assessment rather than fabricate one.
        call = replace(call, reasons=tuple(sorted(set(call.reasons) | {"unresolved_source_witness"})))
    # Alignment IDs describe placements; physical bases of independent
    # native/source alignments share canonical molecule/query identity.
    witness = witness_id(alignment.molecule, content_id("molecule-sequence:v1", alignment.molecule.key),
                         0, projected["query_length"], kind="composed_path")
    coverage = ({"ref_start": start, "ref_end": end, "observed_flanks": 2 if flanks else 0,
                 "query_interval": interval, "complete": complete},)
    call = replace(call, witness_ids=(witness,), alignment_ids=(alignment.record_id,), coverage=coverage)
    geometry = replace(geometry, witness_ids=(witness,), alignment_ids=(alignment.record_id,), coverage=coverage)
    return dict(call=asdict(call), geometry_evidence=asdict(geometry),
                sequence_assessment=sequence_assessment,
                read_bases=observed[:60] if observed is not None else None,
                read_bases_length=len(observed) if observed is not None else None,
                sequence_complete=complete, projection=projected)


def call_molecule(alignments, paths, target, *, policy=ProjectionPolicy(), budget=None,
                  context=None, likelihood_policy=None, likelihood_budget=None):
    """Joint map choices, then within-hypothesis calls, then lifted reduction.

    Records from incompatible query placements never create junctions. Each
    full alignment is an alternative locus explanation; nonoverlapping actual
    records can additionally supply a validated split deletion junction.
    """
    budget = budget or ProjectionBudget(policy)
    search = SearchBudget(policy.search)
    alignments = list({a.record_id: a for a in alignments}.values())
    walks = {a.record_id: _walk(a, budget.check) for a in alignments}
    if context is None:
        primary_contexts = {(a.chemistry, a.chemistry_provenance) for a in alignments if not a.supplementary and a.chemistry != "unknown"}
        available_contexts = primary_contexts or {(a.chemistry, a.chemistry_provenance) for a in alignments if a.chemistry != "unknown"}
        context = DafContext(*next(iter(available_contexts))) if len(available_contexts) == 1 else DafContext("unknown", "unresolved_molecule_chemistry")
    hs, geometry_hs, diagnostics = [], [], []
    primary_complete = False
    # Complete ownership means all admissible source bases in the requested
    # locus belong uniquely to validated primary pieces, independently of calls.
    primary_paths = [p for p in paths if p.ownership == "primary" and p.ownership_validated]
    admissible_paths = [p for p in paths if p.ownership != "secondary" or policy.cohort_alternatives == "include"]
    applicable = [(p, [a for a in alignments if a.contig == p.source and
                   (any(max(a.ref_start, x.q_start) < min(walks[a.record_id][3], x.q_end) for x in p.pieces)
                    or any(a.ref_start < g.source_end and walks[a.record_id][3] > g.source_start for g in p.gaps))])
                  for p in admissible_paths]
    applicable = [(p, aa) for p, aa in applicable if aa and
                  (any(x.t_start <= target["ref_end"] and x.t_end >= target["ref_start"] for x in p.pieces)
                   or any(g.ref_start <= target["ref_end"] and g.ref_end >= target["ref_start"] for g in p.gaps))]
    # Process primary paths first. Display ordering cannot spend their budget.
    applicable.sort(key=lambda v: (v[0].ownership != "primary", v[0].path_id))
    for path, records in applicable:
        budget.check()
        for witness in path.ownership_witnesses:
            if witness["start"] < target["ref_end"]+1 and witness["end"] > target["ref_start"]-1:
                search.unexplored.append(dict(outcome="unexplored", ownership="coequal",
                    reason="conflicting_primary_ownership", witness=witness))
        if not search.admit("hypotheses", ownership=path.ownership):
            continue
        calls, geometry_calls, projected_records, record_details = [], [], [], []
        complete = True
        for alignment in records:
            if not search.admit("path_states", ownership=path.ownership):
                complete = False
                break
            # Actual reciprocal/fetched records supersede their SA descriptions
            # only when this path can place them. Other witnesses stay unresolved.
            resolved = [a for a in records if any(max(a.ref_start, p.q_start) < min(walks[a.record_id][3], p.q_end) for p in path.pieces)]
            alignment = replace(alignment, witnesses=tuple(w for w in alignment.witnesses if not any(
                (w.get("chrom"), w.get("pos"), w.get("strand"), w.get("cigar_ref_len")) ==
                (a.contig, a.ref_start, "-" if a.reverse else "+", walks[a.record_id][3]-a.ref_start) for a in resolved)))
            projected = compose_alignment(alignment, path, budget=budget, walk=walks[alignment.record_id])
            for _ in projected["base_blocks"]:
                if not search.admit("transitions", ownership=path.ownership):
                    complete = False
                    break
            if not complete:
                break
            detail = classify_projection(alignment, projected, target, context=context,
                likelihood_policy=likelihood_policy, likelihood_budget=likelihood_budget, min_mapq=policy.min_mapq,
                diagnostic_halo_bp=policy.search.max_compound_window_bp, geometry_policy=policy)
            projected_records.append(projected)
            record_details.append(detail)
            # Off-locus records are witnesses, not unresolved locus placements.
            if (projected["ref_start"] is not None and projected["ref_start"] <= target["ref_end"] and
                    projected["ref_end"] >= target["ref_start"]) or projected["partial_gaps"]:
                calls.append(Call(**detail["call"]))
                geometry_calls.append(Call(**detail["geometry_evidence"]))
        # Each record is independently classified. Supplementary flanks can
        # coexist only when actual query frames, orientation and quality agree.
        joint = _joint_deletion(projected_records, target, policy.min_mapq)
        if joint is not None and not any(c.assignment in {"target", "reference", "other_allele"} for c in calls):
            participants = set(joint.alignment_ids)
            remainder = [c for c in calls if set(c.alignment_ids) - participants]
            calls = [replace(joint, witness_ids=tuple(sorted({w for c in calls for w in c.witness_ids})),
                             coverage=tuple(v for c in calls for v in c.coverage)), *remainder]
        geometry_joint = _joint_deletion(projected_records, {**target, "target_type": "geometry"}, policy.min_mapq)
        if geometry_joint is not None and not any(c.assignment in {"target", "reference", "other_allele"} for c in geometry_calls):
            participants = set(geometry_joint.alignment_ids)
            geometry_calls = [geometry_joint, *[c for c in geometry_calls if set(c.alignment_ids) - participants]]
        if policy.conflicts_enabled:
            conflict = _query_conflict(record_details, target, policy)
            if conflict:
                calls = [replace(c, level="conflicting", reasons=tuple(sorted(set(c.reasons) | {"compatible_query_elsewhere"})))
                         if c.assignment == "target" else c for c in calls]
                geometry_calls = [replace(c, level="conflicting", reasons=("compatible_query_elsewhere",))
                                  if c.assignment == "target" else c for c in geometry_calls]
                for d in record_details:
                    d["compatible_conflict"] = conflict
        reduced = reconcile_representations([Representation(str(i), "lifted", c) for i, c in enumerate(calls)], scope="lifted_only")
        call = Call(**reduced["call"])
        hypothesis_id = content_id("hypothesis:read-map:v1", [records[0].molecule.key, path.path_id, sorted(a.record_id for a in records)])
        hs.append(Hypothesis(hypothesis_id, call, path.ownership,
            source_alignment_ids=tuple(a.record_id for a in records), selected_map_pieces=tuple(
                content_id("map-piece:v1", list(p)) for p in path.pieces), target_paths=(path.path_id,),
            exclusivity_set=content_id("placements:v1", records[0].molecule.key),
            unresolved_components=tuple(sorted({w["reason"] for r in projected_records for w in r["unresolved_witnesses"]})),
            projection_version=PROJECTION_VERSION, map_version=path.map_revision,
            molecule_id=records[0].molecule.key, record_scope=tuple(a.record_id for a in records),
            ownership_complete=path.ownership_validated, search_complete=complete))
        geometry_reduced = reconcile_representations([Representation(str(i), "lifted", c) for i, c in enumerate(geometry_calls)], scope="lifted_only")
        geometry_hs.append(replace(hs[-1], call=Call(**geometry_reduced["call"])))
        diagnostics.append(dict(hypothesis_id=hypothesis_id, records=record_details))
    # One unique complete primary path covers the target required boundaries.
    # Read partiality affects the call, never which map placement is selected.
    viable_primaries = [p for p, _ in applicable if p in primary_paths]
    if len(viable_primaries) == 1:
        p = viable_primaries[0]
        mapped = [(x.t_start, x.t_end) for x in p.pieces] + [(g.ref_start, g.ref_end) for g in p.gaps]
        primary_complete = (_covers(mapped, max(0, target["ref_start"]-1), target["ref_end"]+1) and not any(
            w["start"] < target["ref_end"]+1 and w["end"] > target["ref_start"]-1 for w in p.ownership_witnesses))
    result = reconcile_hypotheses(hs, primary_complete=primary_complete and any(h.ownership == "primary" for h in hs), search=search.payload())
    result["geometry_call"] = reconcile_hypotheses(geometry_hs, primary_complete=result["primary_complete"], search=search.payload())["call"]
    result["geometry_hypotheses"] = [asdict(h) for h in geometry_hs]
    result["diagnostics"] = diagnostics
    result["projection_version"] = PROJECTION_VERSION
    result["available"] = bool(applicable)
    result["unprojectable_witnesses"] = [w for h in diagnostics for d in h["records"]
        for w in d["projection"]["unresolved_witnesses"] if w.get("reason") in {
            "source_witness_not_projected", "source_path_outside_selected_map", "clip_anchor_unprojectable"}]
    if not applicable:
        result["unprojectable_witnesses"] = [w for a in alignments for w in a.witnesses]
    if not applicable:
        result["call"] = asdict(Call("unavailable", reasons=("no_admissible_target_placement",)))
    if result["alternative_diagnostics"]:
        result["alternative_status"] = "alt_chain_conflict" if any(h["call"]["assignment"] != result["call"]["assignment"] for h in result["alternative_diagnostics"]) else "agreement"
    return result


def _query_conflict(details, target, policy):
    """Only an actual, quality-qualified compatible-hypothesis placement can conflict."""
    for support in details:
        if support["call"]["assignment"] != "target" and support["geometry_evidence"]["assignment"] != "target":
            continue
        p = support["projection"]
        interval = support["call"]["coverage"][0]["query_interval"]
        if not interval:
            continue
        a, b = interval
        if p["alignment_orientation"] == "reverse":
            a, b = p["query_length"]-b, p["query_length"]-a
        if b <= a:
            continue
        for other in details:
            q = other["projection"]
            if q["record_id"] == p["record_id"] or q["mapq"] < policy.min_mapq or q["query_length"] != p["query_length"]:
                continue
            spans = []
            for block in q["base_blocks"]:
                distance = max(0, block["ref_start"]-target["ref_end"], target["ref_start"]-block["ref_end"])
                if distance <= policy.conflict_max_distance:
                    continue
                x, y = block["original_query"]
                if max(x, a) < min(y, b):
                    spans.append((max(x, a), min(y, b)))
            overlap, covered = 0, a
            for x, y in sorted(spans):
                overlap += max(0, y-max(covered, x))
                covered = max(covered, y)
            if overlap >= policy.conflict_min_overlap and overlap/(b-a) >= policy.conflict_min_fraction:
                return dict(reason="compatible_query_elsewhere", record_id=q["record_id"],
                            overlap=overlap, fraction=overlap/(b-a), mapq=q["mapq"], path_id=q["path_id"])
    return None


def _joint_deletion(records, target, min_mapq):
    if target["alt_bp"] or target["ref_end"] <= target["ref_start"]:
        return None
    start, end = target["ref_start"], target["ref_end"]
    for left in records:
        for right in records:
            if left is right or min(left["mapq"], right["mapq"]) < min_mapq:
                continue
            if (left["query_length"] != right["query_length"] or
                left["alignment_orientation"] != right["alignment_orientation"] or
                left["path_id"] != right["path_id"]):
                continue
            for a in left["base_blocks"]:
                for b in right["base_blocks"]:
                    # Frame reflection is explicit in the runs. Negative or
                    # overlapping query gaps cannot prove a deletion junction.
                    if a["ref_end"] == start and b["ref_start"] == end and a["q_end"] == b["q_start"]:
                        if target.get("target_type", "geometry") == "exact" and not (target.get("competition_complete") is True and
                            target.get("candidates", {}).get(target["target_id"]) == "" and all(v is not None and v != "" for k, v in target["candidates"].items() if k != target["target_id"])):
                            continue
                        return Call("target", "confirmed", target["target_id"], "assembly_projection",
                            ("validated_split_deletion_path",), alignment_ids=(left["record_id"], right["record_id"]))
    return None
