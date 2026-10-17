"""Live lift: settings, map registry, piece selection, fetch plan, budgets,
the lifted source load and the primary-metadata lookup (DESIGN_LIVE_LIFT.md
§2.5, §3.2, §3.3, §3.5).

Coordinates are 0-based, half-open. Pieces carry *forward* source coordinates
(``graphlift_map.Piece``); ``compose`` maps decoded reads through them.
"""
from __future__ import annotations

import bisect
import dataclasses
import hashlib
import json
import os
import threading
from collections import OrderedDict, namedtuple
from contextlib import contextmanager
from typing import Iterable, Optional

from services.lift.graphlift_map import LiftMap

# ── Settings ────────────────────────────────────────────────────────────────

HAPLOTYPE_MODES = ("split", "pooled")
SUPPLEMENTARY_DISPLAY = ("own_rows", "hide")          # "fold" is P3
COHORT_SUPPLEMENTARIES = ("all_records", "follow_display", "primary_only")
COHORT_ALTERNATIVES = ("exclude", "include")
JOINT_DEDUP = ("off", "by_molecule")
POOLED_DEPTH = ("raw", "correspondence_normalised")
_BP_RANGES = {"g_split": (1_000, 1_000_000), "window_merge": (0, 1_000_000), "rejoin_bp": (0, 50)}


class LiftSettingsError(ValueError):
    pass


@dataclasses.dataclass(frozen=True)
class LiftSettings:
    """A lifted dataset's advanced settings (§2.5). Every field is part of
    ``lift_key``; defaults are the design's."""
    haplotype_mode: str = "split"
    g_split: int = 10_000
    window_merge: int = 50_000
    rejoin_bp: int = 5
    alternatives: bool = False
    cohort_alternatives: str = "exclude"
    supplementary_display: str = "own_rows"
    cohort_supplementaries: str = "all_records"
    fold_molecule: bool = False
    fold_orientation_rows: bool = False
    joint_dedup: str = "off"
    coverage_hatching: bool = True
    pooled_depth: str = "raw"
    primary_lookup: bool = True
    # Shared-molecule provenance (§2.5, v3.1): ``((source BAM path, label), ...)``;
    # a BAM without a label is its own group (dataset id plus library index).
    molecule_groups: tuple = ()

    def __post_init__(self):
        groups = self.molecule_groups
        if isinstance(groups, dict):
            groups = tuple(groups.items())
        try:
            groups = tuple(sorted((str(path), str(label)) for path, label in groups))
        except (TypeError, ValueError):
            raise LiftSettingsError("molecule_groups must be (path, label) pairs") from None
        object.__setattr__(self, "molecule_groups", groups)
        for name, choices in (("haplotype_mode", HAPLOTYPE_MODES), ("supplementary_display", SUPPLEMENTARY_DISPLAY),
                              ("cohort_supplementaries", COHORT_SUPPLEMENTARIES),
                              ("cohort_alternatives", COHORT_ALTERNATIVES), ("joint_dedup", JOINT_DEDUP),
                              ("pooled_depth", POOLED_DEPTH)):
            if getattr(self, name) not in choices:
                raise LiftSettingsError(f"{name} must be one of {', '.join(choices)}")
        for name, (lo, hi) in _BP_RANGES.items():
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int) or not lo <= value <= hi:
                raise LiftSettingsError(f"{name} must be an integer in [{lo}, {hi}]")

    @classmethod
    def from_dict(cls, values: Optional[dict]) -> "LiftSettings":
        values = dict(values or {})
        unknown = set(values) - {f.name for f in dataclasses.fields(cls)}
        if unknown:
            raise LiftSettingsError(f"unknown live-lift settings: {', '.join(sorted(unknown))}")
        return cls(**values)

    def as_dict(self) -> dict:
        out = dataclasses.asdict(self)
        out["molecule_groups"] = [list(pair) for pair in self.molecule_groups]
        return out

    # Loading follows the union of display and cohort needs (§2.5 v3.1); each
    # path filters the flagged rows with its own setting later (P2).
    @property
    def load_supplementaries(self) -> bool:
        return self.supplementary_display != "hide" or self.cohort_supplementaries != "primary_only"

    @property
    def select_alternatives(self) -> bool:
        return self.alternatives or self.cohort_alternatives == "include"

    def molecule_group_map(self, bam_paths, dataset_id: str) -> dict:
        """``{path: label}`` for every source BAM (unlabelled: ``<dataset>#<index>``)."""
        labels = dict(self.molecule_groups)
        return {path: labels.get(path) or f"{dataset_id}#{i}" for i, path in enumerate(bam_paths)}


# ── Map registry and lift_key ──────────────────────────────────────────────

class LiftMapHandle:
    """An opened sidecar: the reader, its fingerprint and haplotype tables."""

    def __init__(self, manifest_path: str):
        self.path = os.path.abspath(manifest_path)
        with open(self.path, "rb") as fh:
            raw = fh.read()
        self.map = LiftMap(json.loads(raw), os.path.dirname(self.path))
        self.manifest = self.map.m
        files = []
        for target in sorted(self.manifest.get("target_files", {})):
            for name in self.manifest["target_files"][target]:
                try:
                    st = os.stat(os.path.join(self.map.dir, name))
                    files.append((name, st.st_size, st.st_mtime_ns))
                except OSError:
                    files.append((name, None, None))
        digest = hashlib.sha256(raw)
        digest.update(json.dumps(files).encode())
        self.fingerprint = digest.hexdigest()
        # Source contig -> haplotype, from the chains (one haplotype per source).
        self.source_haplotype = {}
        for chain in self.map.chains:
            self.source_haplotype.setdefault(self.manifest["sources"][chain["source"]]["name"], chain["haplotype"])
        self.haplotypes = sorted({c["haplotype"] for c in self.map.chains})
        self.haplotype_labels = _haplotype_labels(self.manifest)
        self.chain_rank = {ci: (-int(c.get("score", c.get("aligned", 0)) or 0), c.get("key", "")) for ci, c in
                           enumerate(self.map.chains)}
        self.lock = threading.Lock()

    def target_size(self, chrom: str) -> Optional[int]:
        ti = self.map.targets.get(chrom)
        return None if ti is None else self.manifest["targets"][ti].get("size")


def _haplotype_labels(manifest) -> dict:
    """``{haplotype: 'MAT'|'PAT'|haplotype}``: from the ``_MATERNAL``/``_PATERNAL``
    suffix its source contigs carry (HPRC ``HG002#1``/``HG002#2`` builds name
    the Q100 contigs that way), else from the haplotype key itself."""
    votes: dict = {}
    for chain in manifest["chains"]:
        name = manifest["sources"][chain["source"]]["name"]
        label = "MAT" if name.endswith("_MATERNAL") else "PAT" if name.endswith("_PATERNAL") else None
        if label:
            votes.setdefault(chain["haplotype"], set()).add(label)
    out = {}
    for hap in {c["haplotype"] for c in manifest["chains"]}:
        labels = votes.get(hap, set())
        if len(labels) == 1:
            out[hap] = labels.pop()
        elif "_MAT" in hap.upper():
            out[hap] = "MAT"
        elif "_PAT" in hap.upper():
            out[hap] = "PAT"
        else:
            out[hap] = hap
    return out


_MAPS: "OrderedDict[tuple, LiftMapHandle]" = OrderedDict()
_MAPS_LOCK = threading.Lock()
_MAX_MAPS = 4


def open_lift_map(manifest_path: str) -> LiftMapHandle:
    """The shared handle of a sidecar manifest (reopened when the file changes)."""
    path = os.path.abspath(manifest_path)
    st = os.stat(path)
    key = (path, st.st_size, st.st_mtime_ns)
    with _MAPS_LOCK:
        handle = _MAPS.get(key)
        if handle is not None:
            _MAPS.move_to_end(key)
            return handle
    handle = LiftMapHandle(path)
    with _MAPS_LOCK:
        _MAPS[key] = handle
        while len(_MAPS) > _MAX_MAPS:
            _MAPS.popitem(last=False)
    return handle


def lift_key(handle: LiftMapHandle, haplotypes: Iterable[str], settings: LiftSettings) -> str:
    """``lift_key`` (§3.9): map fingerprint (manifest plus every target file's
    size and mtime), the selected haplotypes and every advanced setting."""
    payload = {"map": handle.fingerprint, "haplotypes": sorted(haplotypes), "settings": settings.as_dict()}
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:32]


# ── Selection ───────────────────────────────────────────────────────────────

MARGIN_MIN = 20_000
BIN_BP = 1_000_000
MAX_ALTERNATIVE_CHAINS = 16

LiftPiece = namedtuple("LiftPiece", "chain t_start t_end q_start q_end strand primary hap source")


@dataclasses.dataclass
class PieceSelection:
    chrom: str
    start: int            # the queried target range (view plus margin)
    end: int
    view_start: int
    view_end: int
    pieces: list          # LiftPiece, sorted by (t_start, chain)
    alternatives_capped: int = 0


def margin_for(view_bp: int, settings: LiftSettings) -> int:
    """Selection margin ``max(view, 20 kb, g_split)``; never reduced."""
    return max(int(view_bp), MARGIN_MIN, int(settings.g_split))


def clip_piece(p, a: int, b: int):
    """``p`` restricted to target ``[a, b)``, its source span adjusted (on ``-``
    trimming the target start lowers the source end), or None."""
    s, e = max(p.t_start, a), min(p.t_end, b)
    if e <= s:
        return None
    d0, d1 = s - p.t_start, p.t_end - e
    if p.strand == "+":
        return p._replace(t_start=s, t_end=e, q_start=p.q_start + d0, q_end=p.q_end - d1)
    return p._replace(t_start=s, t_end=e, q_start=p.q_start + d1, q_end=p.q_end - d0)


def _merge_contiguous(pieces: list) -> list:
    """Rejoin pieces a bin edge cut: same chain and flags, adjacent in both
    target and source."""
    out = []
    for p in sorted(pieces, key=lambda x: (x.chain, x.t_start)):
        if out:
            q = out[-1]
            if (q.chain == p.chain and q.primary == p.primary and q.strand == p.strand and q.t_end == p.t_start
                    and ((p.strand == "+" and q.q_end == p.q_start) or (p.strand == "-" and p.q_end == q.q_start))):
                out[-1] = q._replace(t_end=p.t_end, q_start=min(q.q_start, p.q_start), q_end=max(q.q_end, p.q_end))
                continue
        out.append(p)
    return out


_BIN_CACHE: "OrderedDict[tuple, list]" = OrderedDict()
_BIN_CACHE_LOCK = threading.Lock()
_BIN_CACHE_MAX = 512


def _as_lift_pieces(handle: LiftMapHandle, pieces) -> list:
    chains, sources = handle.map.chains, handle.manifest["sources"]
    return [LiftPiece(p.chain, p.t_start, p.t_end, p.q_start, p.q_end, p.strand, bool(p.primary),
                      chains[p.chain]["haplotype"], sources[chains[p.chain]["source"]]["name"]) for p in pieces]


def _bin_pieces(handle: LiftMapHandle, key: str, chrom: str, b: int) -> list:
    """Every piece (all haplotypes, primary and alternative) of one complete
    1 Mb target bin, cached under ``(lift_key, chrom, bin)``."""
    ck = (key, chrom, b)
    with _BIN_CACHE_LOCK:
        hit = _BIN_CACHE.get(ck)
        if hit is not None:
            _BIN_CACHE.move_to_end(ck)
            return hit
    with handle.lock:  # the reader loads a target's file lazily
        raw = handle.map.target_to_source(chrom, b * BIN_BP, (b + 1) * BIN_BP)
    pieces = _as_lift_pieces(handle, raw)
    with _BIN_CACHE_LOCK:
        _BIN_CACHE[ck] = pieces
        while len(_BIN_CACHE) > _BIN_CACHE_MAX:
            _BIN_CACHE.popitem(last=False)
    return pieces


def clear_selection_cache() -> None:
    with _BIN_CACHE_LOCK:
        _BIN_CACHE.clear()


def select_pieces(handle: LiftMapHandle, chrom: str, start: int, end: int, *, haplotypes: Iterable[str],
                  settings: LiftSettings, key: str, use_cache: bool = True) -> PieceSelection:
    """The pieces a target view needs (§3.2): ``target_to_source`` over the
    view plus ``margin_for`` on each side, the selected haplotypes, primary
    pieces, and when display or cohort needs them (``select_alternatives``)
    the 16 best alternative chains (by score, then key), flagged. ``use_cache=False`` queries the range directly (the cache's
    equivalence check)."""
    from services.background_work import checkpoint

    start, end = int(start), int(end)
    m = margin_for(end - start, settings)
    size = handle.target_size(chrom)
    qs, qe = max(0, start - m), (end + m if size is None else min(int(size), end + m))
    haps = set(haplotypes)
    if use_cache:
        raw = []
        for b in range(qs // BIN_BP, (max(qe, qs + 1) - 1) // BIN_BP + 1):
            checkpoint()
            for p in _bin_pieces(handle, key, chrom, b):
                c = clip_piece(p, qs, qe)
                if c is not None:
                    raw.append(c)
    else:
        with handle.lock:
            raw = _as_lift_pieces(handle, handle.map.target_to_source(chrom, qs, qe))
    raw = _merge_contiguous([p for p in raw if p.hap in haps])
    pieces = [p for p in raw if p.primary]
    capped = 0
    if settings.select_alternatives:
        alt_chains = sorted({p.chain for p in raw if not p.primary}, key=lambda ci: handle.chain_rank[ci])
        keep = set(alt_chains[:MAX_ALTERNATIVE_CHAINS])
        capped = max(0, len(alt_chains) - MAX_ALTERNATIVE_CHAINS)
        pieces += [p for p in raw if not p.primary and p.chain in keep]
    pieces.sort(key=lambda p: (p.t_start, p.chain, not p.primary))
    return PieceSelection(chrom, qs, qe, start, end, pieces, capped)


# ── Fetch plan and budgets ──────────────────────────────────────────────────

MAX_WINDOWS = 64
MIN_SOURCE_BP_BUDGET = 400_000
SOURCE_BP_PER_VIEW = 8
MAX_RECORDS = 200_000
MAX_DECODED_BYTES = 256 * 1024 * 1024


class LiftRefused(Exception):
    """A lifted request that cannot be served whole (HTTP ``status``)."""

    def __init__(self, message: str, status: int = 413):
        super().__init__(message)
        self.status = status


@dataclasses.dataclass
class ContigFetch:
    contig: str
    region_start: int
    region_end: int
    windows: list          # [(start, end)], sorted and disjoint
    pieces: list           # the selection's pieces on this contig, sorted by q_start

    def target_extents(self, ref_start: int, ref_end: int) -> list:
        """A source extent's target extents: one hull per projected chain
        (sampling counts a skipped record there without a CIGAR walk)."""
        hulls: dict = {}
        k = bisect.bisect_right([p.q_start for p in self.pieces], ref_end)
        for p in self.pieces[:k]:
            s, e = max(p.q_start, ref_start), min(p.q_end, ref_end)
            if e <= s:
                continue
            if p.strand == "+":
                t0, t1 = p.t_start + (s - p.q_start), p.t_start + (e - p.q_start)
            else:
                t0, t1 = p.t_end - (e - p.q_start), p.t_end - (s - p.q_start)
            h = hulls.get(p.chain)
            hulls[p.chain] = (t0, t1) if h is None else (min(h[0], t0), max(h[1], t1))
        return sorted(hulls.values())


@dataclasses.dataclass
class FetchPlan:
    selection: PieceSelection
    contigs: list          # ContigFetch
    source_bp: int
    budget_bp: int

    def pieces_by_contig(self) -> dict:
        return {c.contig: c.pieces for c in self.contigs}


def plan_fetch(selection: PieceSelection, settings: LiftSettings) -> FetchPlan:
    """Source windows for a selection (§3.2): per source contig, pieces in
    source order; consecutive pieces of one chain merge whatever the gap,
    others when the source gap is at most ``window_merge``. Refuses (413) more
    than 64 windows or more source bp than ``max(8 x view, 400 kb)``."""
    by_contig: dict = {}
    for p in selection.pieces:
        by_contig.setdefault(p.source, []).append(p)
    contigs, total, n_windows = [], 0, 0
    for contig in sorted(by_contig):
        pieces = sorted(by_contig[contig], key=lambda p: (p.q_start, p.q_end))
        windows, last_chain = [], None
        for p in pieces:
            if windows and (p.chain == last_chain or p.q_start - windows[-1][1] <= settings.window_merge):
                windows[-1][1] = max(windows[-1][1], p.q_end)
            else:
                windows.append([p.q_start, p.q_end])
            last_chain = p.chain
        merged = []
        for a, b in windows:  # an earlier window may already reach past this one
            if merged and a <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], b)
            else:
                merged.append([a, b])
        total += sum(b - a for a, b in merged)
        n_windows += len(merged)
        contigs.append(ContigFetch(contig, merged[0][0], merged[-1][1], [tuple(w) for w in merged], pieces))
    view_bp = max(1, selection.view_end - selection.view_start)
    budget = max(SOURCE_BP_PER_VIEW * view_bp, MIN_SOURCE_BP_BUDGET)
    if n_windows > MAX_WINDOWS:
        raise LiftRefused(f"Live lift: this view needs {n_windows} source windows (at most {MAX_WINDOWS}); zoom in.")
    if total > budget:
        raise LiftRefused(f"Live lift: this view needs {total:,} source bp (budget {budget:,}); zoom in.")
    return FetchPlan(selection, contigs, total, budget)


class LoadBudget:
    """The record and decoded-payload budgets of one lifted load (§3.2):
    exceeding either stops the load; the result is then ``truncated``."""

    def __init__(self, max_records: int = MAX_RECORDS, max_bytes: int = MAX_DECODED_BYTES):
        self.max_records, self.max_bytes = int(max_records), int(max_bytes)
        self.records = 0
        self.bytes = 0
        self.truncated = False

    def examine(self) -> bool:
        if self.records >= self.max_records or self.bytes >= self.max_bytes:
            self.truncated = True
            return False
        self.records += 1
        return True

    def account(self, read: dict) -> None:
        self.bytes += decoded_size_estimate(read)


def decoded_size_estimate(read: dict) -> int:
    """Approximate bytes a decoded compact read holds (its coordinates and
    marks at ~32 bytes each, plus a fixed row overhead); cheap, no recursion
    into payload objects."""
    n = 0
    for key in ("intervals", "fire", "methyl_m6a", "methyl_m5c", "deam", "possible_deam_ct", "possible_deam_ga",
                "cigar", "sv", "_fiberbrowser_aligned_runs"):
        value = read.get(key)
        if value:
            n += len(value)
    for layer in (read.get("layers") or {}).values():
        if isinstance(layer, dict):
            n += 2 * len(layer.get("intervals") or ())
    return 512 + 32 * n


def estimate_lifted_reads(bam_paths: Iterable[str], plan: FetchPlan, **kwargs) -> Optional[float]:
    """Reads expected in a lifted view: the BAM-index estimate summed over the
    planned source windows (None when any is unknown)."""
    from services.read_sampling import estimate_reads

    total = 0.0
    for path in bam_paths:
        for c in plan.contigs:
            for a, b in c.windows:
                n = estimate_reads(path, c.contig, a, b, **kwargs)
                if n is None:
                    return None
                total += n
    return total


# ── Lifted source load ──────────────────────────────────────────────────────

@contextmanager
def lifted_decode():
    """Nothing streamed or packed while source records decode: rows are
    published only after lifting (§3.3)."""
    from services.packed_reads import packed_decode
    from services.read_stream import decoded_read_sink

    sink, packed = decoded_read_sink.set(None), packed_decode.set(False)
    try:
        yield
    finally:
        packed_decode.reset(packed)
        decoded_read_sink.reset(sink)


# Loader options a lifted load fixes (§3.3); callers may not override them.
_FIXED_LOADER_OPTIONS = dict(spanning_only=False, infer_legacy_layers=False, include_lift_meta=True,
                             circular=False)


@dataclasses.dataclass
class LiftedLoad:
    rows: list
    selection: PieceSelection
    plan: FetchPlan
    counts: dict            # truncated, estimated_reads, hard-clipped supplementaries, lookups, ...
    truncated: bool
    key: str
    region_start: int       # rows are relative to this (the selection range)
    region_end: int


def decode_source_records(bam_paths: Iterable[str], plan: FetchPlan, *, loader_options: Optional[dict] = None,
                          budget: Optional[LoadBudget] = None, counts: Optional[dict] = None,
                          sampled: bool = False, bam_handle_getter=None, include_supplementary: bool = True) -> list:
    """Decode the plan's source windows with the compact-read loader in source
    coordinates. Each read gets ``_fiberbrowser_source_base`` (its intervals'
    origin) and ``source_path``."""
    from services.compact_read_loader import build_compact_reads_from_bam
    from services.read_edge_cache import EdgeFetchUnsupported

    options = dict(loader_options or {})
    options.update(_FIXED_LOADER_OPTIONS, include_supplementary=bool(include_supplementary))
    if bam_handle_getter is not None:
        options["bam_handle_getter"] = bam_handle_getter
    out = []
    with lifted_decode():
        for path in bam_paths:
            for c in plan.contigs:
                try:
                    reads = build_compact_reads_from_bam(
                        path, c.contig, c.region_start, c.region_end, fetch_regions=c.windows,
                        lift_counts=counts, load_budget=budget,
                        sample_bounds=c.target_extents if sampled else None, **options)
                except EdgeFetchUnsupported:
                    raise LiftRefused(f"Live lift: source contig {c.contig} is circular (not supported).",
                                      status=409) from None
                for read in reads:
                    read["_fiberbrowser_source_base"] = c.region_start
                    read["source_path"] = path
                    out.append(read)
    return out


def load_lifted_rows(handle: LiftMapHandle, bam_paths: Iterable[str], chrom: str, start: int, end: int, *,
                     haplotypes: Iterable[str], settings: LiftSettings, dataset_id: str,
                     loader_options: Optional[dict] = None, budget: Optional[LoadBudget] = None,
                     bam_handle_getter=None, use_cache: bool = True) -> LiftedLoad:
    """Every lifted row of target view ``[start, end)`` plus its selection
    margin: selection -> plan -> source decode -> primary metadata -> lift.
    Rows are relative to, and clipped to, the selection range
    ``[load.region_start, load.region_end)`` (view plus margin). The P1 entry point (§3.3 v3.1): **no** spanning, id, strand,
    haplotype, display or cap filter is applied; supplementary and alternative
    rows come flagged whenever display or cohort settings need them. The only
    filtering is the source loader's own duplicate, signal and record filters
    (``loader_options`` must not ask for read ids or spanning)."""
    from services.lift.compose import lift_compact_reads

    bam_paths = list(bam_paths)
    haplotypes = list(haplotypes)
    key = lift_key(handle, haplotypes, settings)
    selection = select_pieces(handle, chrom, start, end, haplotypes=haplotypes, settings=settings, key=key,
                              use_cache=use_cache)
    plan = plan_fetch(selection, settings)
    budget = budget or LoadBudget()
    counts: dict = {}
    if all("://" not in str(p) for p in bam_paths):
        counts["estimated_reads"] = estimate_lifted_reads(bam_paths, plan)
    decoded = decode_source_records(bam_paths, plan, loader_options=loader_options, budget=budget, counts=counts,
                                    bam_handle_getter=bam_handle_getter,
                                    include_supplementary=settings.load_supplementaries)
    molecules = resolve_primary_metadata(handle, decoded, settings=settings, counts=counts,
                                         bam_handle_getter=bam_handle_getter)
    rows = lift_compact_reads(decoded, plan, handle=handle, region_start=selection.start,
                              region_end=selection.end, settings=settings,
                              key=key, dataset_id=dataset_id, molecules=molecules, counts=counts,
                              loader_options=loader_options,
                              molecule_groups=settings.molecule_group_map(bam_paths, dataset_id))
    counts["records_decoded"] = len(decoded)
    counts["truncated"] = bool(budget.truncated)
    return LiftedLoad(rows, selection, plan, counts, budget.truncated, key, selection.start, selection.end)


# ── Primary metadata (§3.5) ─────────────────────────────────────────────────

MAX_PRIMARY_LOOKUPS = 32
_PRIMARY_CACHE: "OrderedDict[tuple, Optional[dict]]" = OrderedDict()
_PRIMARY_CACHE_LOCK = threading.Lock()
_PRIMARY_CACHE_MAX = 50_000


def molecule_key(read: dict) -> tuple:
    return (read.get("library_id") or read.get("source_path") or "", read.get("id"))


def parse_sa(sa: Optional[str]) -> list:
    """``[(contig, pos0, strand, cigar)]`` of an SA tag."""
    out = []
    for entry in (sa or "").split(";"):
        parts = entry.split(",")
        if len(parts) >= 4:
            try:
                out.append((parts[0], int(parts[1]) - 1, parts[2], parts[3]))
            except ValueError:
                continue
    return out


def lookup_primary(bam, qname: str, sa: Optional[str]) -> Optional[dict]:
    """The primary record of a supplementary, found through its SA loci (point
    fetches): ``{contig, strand?}`` or None when absent or ambiguous."""
    from services.read_strand import record_strand_fields

    found = {}
    references = set(bam.references)
    for contig, pos, _strand, _cigar in parse_sa(sa):
        if contig not in references:
            continue
        for rec in bam.fetch(contig, pos, pos + 1):
            if rec.query_name != qname or rec.is_supplementary or rec.is_secondary or rec.is_unmapped:
                continue
            if rec.reference_start != pos:
                continue
            meta = {"contig": rec.reference_name, **record_strand_fields(rec)}
            found[(rec.reference_name, rec.reference_start)] = meta
    if len(found) != 1:
        return None
    return next(iter(found.values()))


def resolve_primary_metadata(handle: LiftMapHandle, reads: list, *, settings: LiftSettings, counts: dict,
                             bam_handle_getter=None) -> dict:
    """``{molecule_key: {hap, strand, source}}`` from each molecule's primary
    record (§3.5): fetched, else (``primary_lookup``) found through SA point
    fetches (at most 32 per request, cached by molecule in source
    coordinates); otherwise the record's own contig and strand
    (``source: 'record'``, counted)."""
    out: dict = {}
    pending: dict = {}
    for read in reads:
        key = molecule_key(read)
        prim = read.get("_fiberbrowser_primary") or {}
        if not prim.get("is_supplementary"):
            contig = (read.get("_fiberbrowser_lift_record") or {}).get("contig")
            out[key] = {"hap": handle.source_haplotype.get(contig), "strand": read.get("strand"), "source": "primary"}
        else:
            pending.setdefault(key, read)
    lookups = 0
    for key, read in pending.items():
        if key in out:
            continue
        meta = None
        if settings.primary_lookup:
            ck = (handle.fingerprint, key)
            with _PRIMARY_CACHE_LOCK:
                cached = ck in _PRIMARY_CACHE
                meta = _PRIMARY_CACHE.get(ck)
            if not cached and lookups < MAX_PRIMARY_LOOKUPS:
                lookups += 1
                try:
                    if bam_handle_getter is None:
                        from services.bam_handles import get_bam_handle as bam_handle_getter
                    bam = bam_handle_getter(read.get("source_path"))
                    meta = lookup_primary(bam, read.get("id"), (read.get("_fiberbrowser_primary") or {}).get("sa"))
                except Exception:  # noqa: BLE001 - a failed lookup falls back to the record
                    meta = None
                with _PRIMARY_CACHE_LOCK:
                    _PRIMARY_CACHE[ck] = meta
                    while len(_PRIMARY_CACHE) > _PRIMARY_CACHE_MAX:
                        _PRIMARY_CACHE.popitem(last=False)
            elif not cached:
                counts["primary_lookup_capped"] = counts.get("primary_lookup_capped", 0) + 1
        if meta is not None and handle.source_haplotype.get(meta["contig"]) is not None:
            out[key] = {"hap": handle.source_haplotype[meta["contig"]], "strand": meta.get("strand"),
                        "source": "primary"}
            counts["primary_found_by_lookup"] = counts.get("primary_found_by_lookup", 0) + 1
        else:
            contig = (read.get("_fiberbrowser_lift_record") or {}).get("contig")
            out[key] = {"hap": handle.source_haplotype.get(contig), "strand": read.get("strand"), "source": "record"}
            counts["hap_from_record"] = counts.get("hap_from_record", 0) + 1
    return out


def clear_primary_cache() -> None:
    with _PRIMARY_CACHE_LOCK:
        _PRIMARY_CACHE.clear()
