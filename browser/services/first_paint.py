"""First paint for deep read views: decode only the reads the display draws.

``/api/reads/compact_all`` draws at most ``max_reads`` reads per dataset, chosen
by ``select_compact_all_display_reads``: the reads whose footprint body covers
most of the view (ties: the first drawn footprint, then source order). A cold
view used to decode every read in it before it could choose (a deep PacBio
locus: thousands of reads per dataset, several seconds each).

A read's footprint body lies inside its alignments, so the share of the view
that its alignments cover bounds the share its body covers. The first response:

1. reads each record's name and alignment extent, without parsing tags;
2. decodes, through the ordinary loader, the reads with the highest bound:
   a few more than ``max_reads``, plus the pinned reads;
3. checks that no undecoded read could be drawn: each one's bound must be
   below the coverage of the last read drawn from the decoded ones. If one is
   not, it decodes those reads too and checks again. The payload then chooses
   the drawn reads with the full path's own function
   (``select_compact_all_display_reads``).

The chosen reads, and their order, are then exactly the full path's. Nothing
decoded here is cached as a view's reads: the decode runs under an explicit
read scope, which never fills the broad cache, and with ``read_ids``, which
never fills the working-set cache. The response says it is partial
(``first_paint``); the browser then asks for the whole view on the background
pool (``background=true``), which runs the unchanged full path.
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import Optional

# Below this many reads per ``max_reads`` the full view decodes quickly enough.
MIN_DEPTH_FACTOR = 1.5
# Extra reads decoded beyond ``max_reads`` in the first round.
MARGIN_FRACTION = 0.1
MIN_MARGIN = 64
MAX_ROUNDS = 3
#: a round that would bring the decoded reads to this share of the view decodes the whole view once instead
#: (provisional)
FULL_DECODE_FRACTION = 0.75


@dataclass
class FirstPaintSet:
    """The reads decoded for a first response, and what is known of the rest."""
    working_set: object
    total_overlapping: int
    total_spanning: int
    decoded_names: int
    rounds: int
    timings: dict = field(default_factory=dict)
    #: every read in view was decoded (no full set follows)
    complete: bool = False

    def info(self, shown: int) -> dict:
        return {
            "partial": not self.complete,
            "shown": int(shown),
            "decoded": int(self.decoded_names),
            # Molecules with an alignment in view the read policy shows (duplicate / QC-fail toggles), before the
            # other read filters (the full set's count may be lower).
            "total_estimate": int(self.total_overlapping),
            "rounds": int(self.rounds),
        }


def ineligible_reason(state, dataset, *, chrom: str, start: int, end: int, spanning: bool, max_reads: int,
                      downsample: Optional[int], coverage_sample: bool, direct: bool) -> Optional[str]:
    """Why a first response cannot be partial for this dataset (None: it can)."""
    if dataset is None or getattr(dataset, "data_type", None) != "bam":
        return "not a BAM dataset"
    paths = list(getattr(dataset, "paths", None) or ())
    if not paths or any("://" in str(path) for path in paths):
        return "remote source"
    from services.lift.capability import is_lifted
    if is_lifted(dataset):
        return "live lift"
    if getattr(state, "performance", {}).get("effective") == "low":
        return "low memory"
    if direct:
        return "direct read load"
    if not max_reads or max_reads <= 0:
        return "every read requested"
    if downsample is not None and downsample > 0:
        return "random downsample"
    if spanning or not coverage_sample:
        return "not a coverage sample"
    if getattr(dataset, "molecule_groups", None):
        return "molecule groups"
    if int(getattr(state, "max_working_reads", 0) or 0) > 0:
        return "working-read cap"
    from services.circular_genome import circular_chrom_size, is_circular_chrom
    if circular_chrom_size(state, chrom) or is_circular_chrom(state, chrom):
        return "circular contig"
    # a contig the dataset's own BAM headers mark circular (@SQ TP:circular): origin-wrapping records are read
    # at [start + LN, end + LN), which the first paint's extents do not look at
    from utils.chrom import normalize_chrom_name
    want = normalize_chrom_name(chrom)
    if any(normalize_chrom_name(c) == want for c in (getattr(dataset, "circular_contigs", None) or {})):
        return "circular contig"
    from services.consensus_workflow import active as consensus_active
    if consensus_active(state, dataset.id, chrom, start, end):
        return "consensus overlay"
    from services.read_sampling import estimate_dataset_reads
    estimate = estimate_dataset_reads(state, dataset, chrom, start, end)
    if estimate is None or estimate < MIN_DEPTH_FACTOR * max_reads:
        return "shallow view"
    return None


def view_is_cached(state, query, dataset_id: str, **build_options) -> bool:
    """Whether the view's working set builds from the caches, without reading the BAM."""
    from services.working_sets import WorkingSetNotCached, working_set_probe
    token = working_set_probe.set(True)
    try:
        query.build_working_set(state, dataset_id, **build_options)
        return True
    except WorkingSetNotCached:
        return False
    finally:
        working_set_probe.reset(token)


def alignment_extents(state, dataset, chrom: str, start: int, end: int, *, include_duplicates=None,
                      include_qcfail=None) -> dict:
    """Per read name: [lowest start, highest end, first seen] over its mapped, non-secondary
    records that overlap the view, every file of the dataset in order. No tag is parsed.
    Duplicate (0x400) and QC-fail (0x200) records the read track hides are left out, as the loader leaves them
    out (``include_*``: the request's toggles; None: as the request asks, services/bam_tags.record_passes_read_policy)."""
    from services.background_work import checkpoint
    from services.bam_tags import record_passes_read_policy
    if include_duplicates is None:
        from services.signal_evidence import request_include_duplicates
        include_duplicates = request_include_duplicates()
    if include_qcfail is None:
        from services.signal_evidence import request_include_qcfail
        include_qcfail = request_include_qcfail()
    from services.bam_handles import get_bam_handle, transient_bam_handle
    from services.plasmid_reconcile import contig_links
    from utils.chrom import resolve_reference_name
    from contextlib import nullcontext
    threads = int(getattr(state, "performance", {}).get("bam_threads", 1) or 1)
    extents: dict = {}
    order = 0
    for path in dataset.paths:
        scope = transient_bam_handle(path, threads=threads) if threads > 1 else nullcontext(get_bam_handle(path))
        with scope as bam:
            if bam is None:
                raise OSError(f"Could not open {path}")
            try:
                links = contig_links(state, path=path)
            except Exception:  # noqa: BLE001 - as the loader: no links
                links = None
            actual = resolve_reference_name(chrom, bam.references, getattr(state, "chrom_map", None) or {}, links=links)
            if actual is None:
                continue
            for i, record in enumerate(bam.fetch(actual, start, end)):
                if not i & 1023:
                    checkpoint()
                if record.is_unmapped or record.is_secondary:
                    continue
                if not record_passes_read_policy(record, include_duplicates, include_qcfail):
                    continue
                lo = record.reference_start
                hi = record.reference_end
                if hi is None:
                    hi = end  # no CIGAR extent: bound by the whole view
                entry = extents.get(record.query_name)
                if entry is None:
                    extents[record.query_name] = [lo, hi, order]
                    order += 1
                else:
                    if lo < entry[0]:
                        entry[0] = lo
                    if hi > entry[1]:
                        entry[1] = hi
    return extents


def _bound(extent, start: int, width: int) -> int:
    """The most of [0, width) a body inside ``extent`` can cover (bp)."""
    return max(0, min(width, extent[1] - start) - max(0, extent[0] - start))


def _row_name(row, extents) -> Optional[str]:
    from services.read_selection import base_read_id
    rid = str(row.get("id", ""))
    if rid in extents:
        return rid
    base = base_read_id(rid)
    return base if base in extents else None


def plan_first_paint(state, query, dataset_id: str, *, chrom: str, start: int, end: int, max_reads: int,
                     build_options: dict, fill_gap_size: Optional[int] = None,
                     pins=(), on_partial=None, workers: int = 0, include_duplicates=None,
                     include_qcfail=None) -> Optional[FirstPaintSet]:
    """Decode the reads a cold view's display draws (module docstring). None: decode the whole view.

    ``build_options``: the working-set options the full path uses;
    ``workers``: decode the drawn reads on this many worker processes (0 or 1: in this thread);
    ``include_duplicates`` / ``include_qcfail``: the request's read-policy toggles (candidates and estimates leave
    the reads they hide out; None: as the request asks);
    ``on_partial()``: called once the drawn reads are decoded and the response will be partial (starts the
    full set: started earlier, its decode would slow this one)."""
    from services.read_metrics import fill_small_gaps_in_read
    from services.read_sampling import decode_read_scope
    from services.read_selection import body_overlap
    from services.working_sets import log_working_set_diagnostic
    dataset = state.get_dataset(dataset_id)
    width = end - start
    timings: dict = {}
    t0 = time.perf_counter()
    extents = alignment_extents(state, dataset, chrom, start, end, include_duplicates=include_duplicates,
                                include_qcfail=include_qcfail)
    timings["first_paint_extents_ms"] = (time.perf_counter() - t0) * 1000
    if len(extents) < MIN_DEPTH_FACTOR * max_reads:
        return None
    ranked = sorted(extents, key=lambda name: (-_bound(extents[name], start, width), extents[name][2]))
    take = min(len(ranked), max_reads + max(MIN_MARGIN, int(max_reads * MARGIN_FRACTION)))
    pinned = {str(p) for p in pins} | {re.sub(r"_\d+$", "", str(p)) for p in pins}
    names = set(ranked[:take]) | pinned
    if take > max_reads:
        # Decided before decoding anything: every read whose bound reaches the max_reads-th largest bound may cover
        # as much as the drawn reads (coverage never exceeds the bound, so the cutoff after round 1 is at most that
        # bound); when those ties already make up FULL_DECODE_FRACTION of the view, round 2 would decode (nearly)
        # all of it, so the whole view is decoded once instead of round 1 first.
        kth = _bound(extents[ranked[max_reads - 1]], start, width)
        tied = sum(1 for name in ranked if _bound(extents[name], start, width) >= kth)
        if len(names | set(ranked[:tied])) >= FULL_DECODE_FRACTION * len(ranked):
            return None
    decode_ms = 0.0
    working_set = None
    complete = False
    for round_number in range(1, MAX_ROUNDS + 1):
        t1 = time.perf_counter()
        from services.read_route_helpers import first_paint_on_workers
        token = decode_read_scope.set(dict(only_ids=frozenset(names), exact_ids=True))
        on_workers = first_paint_on_workers.set(int(workers or 0))
        try:
            working_set = query.build_working_set(state, dataset_id, read_ids=sorted(names), force_reload=True,
                                                  **build_options)
        finally:
            first_paint_on_workers.reset(on_workers)
            decode_read_scope.reset(token)
        decode_ms += (time.perf_counter() - t1) * 1000
        reads = list(working_set.reads)
        if fill_gap_size and fill_gap_size > 0:
            reads = [fill_small_gaps_in_read(read, fill_gap_size) for read in reads]
        undecoded = [name for name in ranked if name not in names]
        if not undecoded:
            complete = True
            break  # every read in view is decoded: this is the full set (no full set follows)
        coverage = []
        for read in reads:
            name = _row_name(read, extents)
            overlap = body_overlap(read, 0, width)
            if name is None or overlap > _bound(extents[name], start, width):
                # A body outside its alignments: the bound does not hold here. Decode the whole view.
                log_working_set_diagnostic(f"  First paint: {dataset_id} read {read.get('id')} outside its bound")
                return None
            coverage.append(overlap)
        if len(reads) > max_reads:
            cutoff = sorted(coverage, reverse=True)[max_reads - 1]
            # (``ranked`` is in descending bound order.)
            more = [name for name in undecoded if _bound(extents[name], start, width) >= cutoff]
            if not more:
                break
        else:
            # Fewer decoded reads than drawn ones (filtered reads): decode the next ones.
            more = undecoded[:max(MIN_MARGIN, max_reads - len(reads) + MIN_MARGIN)]
        if round_number == MAX_ROUNDS:
            return None
        if len(names) + len(more) >= FULL_DECODE_FRACTION * len(ranked):
            # The next round would decode (nearly) every read in view (ties at the cutoff, as where more reads than
            # drawn span a narrow view): a first paint saves little and the full set would decode them again, so
            # the whole view is decoded once.
            return None
        names |= set(more)
    if on_partial is not None and not complete:
        on_partial()
    timings["first_paint_decode_ms"] = decode_ms
    timings["first_paint_rounds"] = round_number
    timings["first_paint_decoded"] = len(names)
    spanning = sum(1 for lo, hi, _ in extents.values() if lo <= start and hi >= end)
    log_working_set_diagnostic(
        f"  First paint: {dataset_id} decoded {len(names)} of {len(extents)} reads in {round_number} round(s)")
    return FirstPaintSet(working_set=working_set, total_overlapping=len(extents), total_spanning=spanning,
                         decoded_names=len(names), rounds=round_number, timings=timings, complete=complete)
