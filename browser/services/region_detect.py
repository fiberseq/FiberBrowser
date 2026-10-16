"""Regions found in a dataset's reads: its amplicons, or its best-covered regions.

The Regions panel lists them (an "Amplicons" category for amplicon data, a
"Top regions" one on request), each named after the nearest gene of the
dataset's reference.

How regions are found (``detect_regions``):

- The reads in scope are read once (start and end of each primary alignment),
  at most ``SCAN_READ_CAP`` of them and for at most ``SCAN_BUDGET_S`` seconds.
- Overlapping reads are merged into clusters. Amplicon data is a few clusters
  whose reads share their ends (the start positions spread far less than a
  read is long, the test ``random_window._fit_window_to_reads`` uses) and that
  hold most of the reads: then every cluster with at least ``min_reads`` reads
  is one region (one amplicon = one entry; tiled amplicons that overlap merge
  into one). Otherwise the region list is the best-covered stretches: the
  deepest bins of a coverage profile, each widened to its neighbours at half
  its depth.

Scopes are bounded so a whole-genome dataset never makes the browser read it
all. A whole dataset of more than ``PRECHECK_ABOVE`` reads is looked at from
its index first (services/bam_index_profile.py): a targeted run (most of its
data in a small share of the genome, e.g. two loci of 70 kb reads) gets its
dense stretches as regions (``kind: "targeted"``, ``method: "index"``) without
reading every read; whole-genome data is refused (``status: "whole-genome"``).
Amplicons (a first sample of reads says so) are still read whole, up to
``AUTO_MAX_READS``. Without a local .bai the reads are read (``note`` says so).
A chromosome is scanned only when it holds at most ``CHROM_MAX_READS``; a view
(``start``/``end``) at most ``VIEW_MAX_BP`` wide is always allowed (the read cap
and time budget still apply). ``force`` reads the reads of any scope (slow, on
request). A refused scope answers ``refused: true`` with the reason and a
``status`` (whole-genome, too-many, mismatch), before reading anything; any
narrowing is said in ``note``, never silent.

Labels (``nearest_gene_label``): the gene the region overlaps (a protein-coding
one before a non-coding one, before a small RNA, repeat family, pseudogene or
unnamed gene; then the largest overlap); else "near X (1.2 kb)" when one
flanking gene is much closer, or "between X and Y" (flanking genes are named
genes when the chromosome has any). Transcripts of one name make one gene only
where they overlap or lie close together (``SAME_GENE_GAP_BP``): a multi-copy
name such as Metazoa_SRP is many small genes, not one span across the
chromosome. Without an annotation the label is the locus.
"""
from __future__ import annotations

import bisect
import math
import os
import re
import time
from dataclasses import dataclass, field
from typing import Optional

from services.bam_handles import get_bam_handle
from utils.chrom import get_chrom_variants

# Dataset-wide automatic scan: only when the index says the dataset is this small...
AUTO_MAX_READS = 300_000
# ... and, above this many reads, only when a first sample (PRECHECK_READS reads of
# the contig with most reads) already looks like amplicons: a long-read dataset of
# 300k reads takes many seconds to read whole (IND Hia5: 4,376 reads in 1.1 s).
PRECHECK_ABOVE = 20_000
PRECHECK_READS = 2_000
# A chromosome is scanned only when it holds at most this many mapped reads.
CHROM_MAX_READS = 400_000
# A view of at most this width is always scanned.
VIEW_MAX_BP = 5_000_000
# Reads looked at and seconds spent, whatever the scope.
SCAN_READ_CAP = 300_000
# Records decoded at most (secondary, supplementary and unmapped ones included).
SCAN_RECORD_CAP = 1_000_000
SCAN_BUDGET_S = 20.0
# "Scan anyway": what a forced scan may read and spend.
FORCE_READ_CAP = 3_000_000
FORCE_RECORD_CAP = 10_000_000
FORCE_BUDGET_S = 180.0
# Regions returned at most.
MAX_REGIONS = 500
# Reads closer than this merge into one cluster.
MERGE_GAP_BP = 50
# Amplicon test: the clusters with enough reads hold this share of all reads...
AMPLICON_READ_SHARE = 0.8
# ... and are at most this wide (an amplicon, not a chromosome of tiling reads).
AMPLICON_MAX_WIDTH = 100_000
# Top-region profile: bins per scope, and the share of a peak's depth its region extends to.
TOP_BINS = 2000
TOP_EXTEND = 0.5

from services.byte_cache import shared_cache
_CACHE = shared_cache('indexes')


@dataclass
class _Cluster:
    contig: str
    start: int
    end: int
    starts: list = field(default_factory=list)
    ends: list = field(default_factory=list)

    @property
    def reads(self) -> int:
        return len(self.starts)


def format_distance(bp: int) -> str:
    bp = int(abs(bp))
    if bp < 1000:
        return f"{bp} bp"
    if bp < 1_000_000:
        return f"{bp / 1000:.1f} kb"
    return f"{bp / 1_000_000:.2f} Mb"


def region_genome_key(state) -> str:
    """The reference these coordinates are on: a panel genome's key, the main
    genome's registry id or FASTA file name, else 'none' (the BAM's own contigs)."""
    key = getattr(state, '_genome_key', None) or getattr(state, 'current_genome', None)
    if key:
        return str(key)
    path = getattr(state, 'fasta_path', None)
    return os.path.basename(str(path)) if path else 'none'


# ---------------------------------------------------------------------------
# Nearest gene
# ---------------------------------------------------------------------------

# Transcripts of one name are one gene only where they overlap or lie this close:
# a multi-copy name (Metazoa_SRP, Y_RNA, U6, a tRNA) is many genes, never one span
# from its first copy to its last.
SAME_GENE_GAP_BP = 2_000
# Biotypes named last: small RNAs, repeat families, pseudogenes (tier 2). Protein-coding
# genes (and annotations without biotypes) are named first (tier 0), other genes next (1).
_CODING_BIOTYPES = {"protein_coding", "mrna", "ig_c_gene", "ig_d_gene", "ig_j_gene", "ig_v_gene",
                    "tr_c_gene", "tr_d_gene", "tr_j_gene", "tr_v_gene", "polymorphic_pseudogene"}
_MINOR_BIOTYPES = {"misc_rna", "snrna", "snorna", "mirna", "rrna", "scarna", "scrna", "srna", "vault_rna",
                   "mt_trna", "mt_rrna", "trna", "rrna_pseudogene", "ribozyme", "tec", "artifact",
                   "transposable_element", "repeat_region", "y_rna", "7sk", "rnase_p_rna", "rnase_mrp_rna",
                   "srp_rna", "pre_mirna", "snorna_pseudogene"}
# Names that are only an identifier (an unnamed GENCODE gene's ENSG...).
_ID_NAME = re.compile(r"^(ENS[A-Z]*G\d{6,}|FBgn\d+|WBGene\d+|LOC\d+)(\.\d+)?$")


def gene_tier(name: str, biotype) -> int:
    """0: protein-coding (or no biotype given), 1: other genes (lncRNA, ncRNA...),
    2: small RNAs, repeat families, pseudogenes and unnamed genes (named last)."""
    if _ID_NAME.match(name):
        return 2
    kind = str(biotype or "").strip().lower()
    if not kind or kind == "nan" or kind in _CODING_BIOTYPES:
        return 0
    if kind in _MINOR_BIOTYPES or "pseudogene" in kind:
        return 2
    return 1


class GeneIndex:
    """Gene spans per chromosome, for labelling: a gene is the transcripts of one
    name that overlap or lie within SAME_GENE_GAP_BP of each other (the annotation
    loader keeps no gene_id), with its biotype's tier (gene_tier)."""

    def __init__(self, gtf_data):
        self._by_chrom: dict = {}
        self._tx = None
        try:
            tx = gtf_data["transcripts"] if gtf_data is not None else None
        except Exception:
            tx = None
        if tx is not None and not getattr(tx, "empty", True):
            self._tx = tx

    def _spans(self, chrom: str) -> list:
        """[(start, end, name, tier)] sorted by start."""
        if chrom in self._by_chrom:
            return self._by_chrom[chrom]
        spans: list = []
        if self._tx is not None:
            variants = set(get_chrom_variants(chrom))
            rows = self._tx[self._tx["chrom"].isin(variants)]
            biotypes = rows["biotype"] if "biotype" in rows.columns else [None] * len(rows)
            by_name: dict = {}
            for name, start, end, biotype in zip(rows["gene_name"], rows["start"], rows["end"], biotypes):
                name = str(name)
                if not name or name == "nan":
                    continue
                by_name.setdefault(name, []).append((int(start), int(end), gene_tier(name, biotype)))
            for name, items in by_name.items():
                items.sort()
                cur_s, cur_e, cur_t = items[0]
                for s, e, t in items[1:]:
                    if s <= cur_e + SAME_GENE_GAP_BP:
                        cur_e = max(cur_e, e)
                        cur_t = min(cur_t, t)
                    else:
                        spans.append((cur_s, cur_e, name, cur_t))
                        cur_s, cur_e, cur_t = s, e, t
                spans.append((cur_s, cur_e, name, cur_t))
            spans.sort(key=lambda g: (g[0], g[1]))
        self._by_chrom[chrom] = spans
        return spans

    @property
    def loaded(self) -> bool:
        return self._tx is not None

    def label(self, chrom: str, start: int, end: int) -> dict:
        """``{label, gene, detail}`` for [start, end) on chrom: the gene it overlaps
        (a protein-coding one first, then the largest overlap), else the closest
        genes on either side (repeat-family and unnamed genes only when there is
        nothing else on the chromosome)."""
        if not self.loaded:
            return {"label": f"{chrom}:{start:,}-{end:,}", "gene": None, "detail": "No gene annotation loaded"}
        spans = self._spans(chrom)
        if not spans:
            return {"label": f"{chrom}:{start:,}-{end:,}", "gene": None, "detail": f"No genes on {chrom}"}
        starts = [s for s, _e, _n, _t in spans]
        # Genes overlapping the region (a gene starts before the region ends).
        hi = bisect.bisect_left(starts, end)
        overlapping = []
        for s, e, name, tier in spans[:hi]:
            if e > start:
                overlapping.append((tier, -(min(e, end) - max(s, start)), name))
        if overlapping:
            overlapping.sort()
            names = []
            for _t, _o, n in overlapping:
                if n not in names:
                    names.append(n)
            detail = f"In {names[0]}" + (f" (also {', '.join(names[1:4])}{'…' if len(names) > 4 else ''})" if len(names) > 1 else "")
            return {"label": names[0], "gene": names[0], "detail": detail}
        # Flanking genes: named genes first (a repeat copy or a pseudogene names a region only without them).
        best_tier = min(t for _s, _e, _n, t in spans)
        flank = [g for g in spans if g[3] <= max(1, best_tier)]
        best_left = None   # (distance, name): the closest gene ending before the region
        best_right = None  # the closest gene starting after it
        for s, e, name, _t in flank:
            if e <= start:
                if best_left is None or start - e < best_left[0]:
                    best_left = (start - e, name)
            elif s >= end:
                if best_right is None or s - end < best_right[0]:
                    best_right = (s - end, name)
        if best_left is None and best_right is None:
            return {"label": f"{chrom}:{start:,}-{end:,}", "gene": None, "detail": f"No genes on {chrom}"}
        if best_left is None or (best_right is not None and best_right[0] * 3 <= best_left[0]):
            d, name = best_right
            return {"label": f"near {name} ({format_distance(d)})", "gene": name,
                    "detail": f"Intergenic: {name} {format_distance(d)} away"}
        if best_right is None or best_left[0] * 3 <= best_right[0]:
            d, name = best_left
            return {"label": f"near {name} ({format_distance(d)})", "gene": name,
                    "detail": f"Intergenic: {name} {format_distance(d)} away"}
        (dl, left_name), (dr, right_name) = best_left, best_right
        return {"label": f"between {left_name} and {right_name}", "gene": left_name if dl <= dr else right_name,
                "detail": f"Intergenic: {left_name} {format_distance(dl)}, {right_name} {format_distance(dr)}"}


def nearest_gene_label(state, chrom: str, start: int, end: int) -> dict:
    return GeneIndex(getattr(state, "gtf_data", None)).label(chrom, int(start), int(end))


# ---------------------------------------------------------------------------
# Scanning
# ---------------------------------------------------------------------------

def dataset_fingerprint(dataset) -> Optional[str]:
    """What identifies a dataset's data across sessions and moves: sha256 over each
    file's size and three content samples (library_inspect.content_digest); a
    remote file by its address."""
    import hashlib
    from services.library_inspect import content_digest
    paths = list(getattr(dataset, "paths", None) or [])
    if not paths:
        return None
    digest = hashlib.sha256()
    for path in sorted(str(p) for p in paths):
        part = None
        try:
            if os.path.isfile(path):
                part = content_digest(path, os.path.getsize(path))
        except OSError:
            part = None
        digest.update((part or f"path:{path}").encode("utf-8", "replace"))
        digest.update(b"\n")
    return digest.hexdigest()[:24]


def _reference_mismatch(state, dataset_id: str) -> Optional[str]:
    """Why this dataset can't be read on the reference it is on now (the genome
    check's "error": another assembly, other chromosome names), else None."""
    try:
        from services.genome_check import dataset_genome_summaries
        summary = dataset_genome_summaries(getattr(state, "_genome_base", state)).get(dataset_id)
    except Exception:
        return None
    if not summary or summary.get("severity") != "error":
        return None
    return str(summary.get("message") or "This dataset doesn't fit the loaded reference.")


def _reachable(state, dataset):
    from services.random_window import _search_scope
    scope = _search_scope(state, [dataset])
    return scope.contigs.get(getattr(dataset, "id", None)) or []


def _scan(contigs, deadline: float, chrom: Optional[str] = None, start: Optional[int] = None,
          end: Optional[int] = None, read_cap: int = 0, record_cap: int = 0) -> tuple[dict, int, bool]:
    """{contig: sorted [(start, end)]} of primary reads; reads seen; whether cut short."""
    out: dict = {}
    seen = 0
    records = 0

    def stop() -> tuple[dict, int, bool]:
        for rows_ in out.values():
            rows_.sort()
        return out, seen, True

    for c in contigs:
        if chrom is not None and c.contig != chrom:
            continue
        if time.monotonic() > deadline:
            return stop()
        bam = get_bam_handle(c.path)
        if bam is None:
            continue
        lo = max(0, int(start)) if start is not None else 0
        hi = min(int(end), c.size) if end is not None else c.size
        if hi <= lo:
            continue
        rows = out.setdefault(c.contig, [])
        try:
            for read in bam.fetch(c.contig, lo, hi):
                records += 1
                # Every record counts toward the limits, kept or not (a contig of
                # secondary alignments must not be read to its end).
                if records >= (record_cap or SCAN_RECORD_CAP) or ((records & 1023) == 0 and time.monotonic() > deadline):
                    return stop()
                if read.is_unmapped or read.is_secondary or read.is_supplementary:
                    continue
                rs = int(read.reference_start)
                re_ = int(read.reference_end or rs + 1)
                rows.append((rs, re_))
                seen += 1
                if seen >= (read_cap or SCAN_READ_CAP):
                    return stop()
        except Exception:
            continue
    for rows in out.values():
        rows.sort()
    return out, seen, False


def _clusters(intervals: dict) -> list:
    out = []
    for contig, rows in intervals.items():
        cur = None
        for s, e in rows:
            if cur is not None and s <= cur.end + MERGE_GAP_BP:
                cur.end = max(cur.end, e)
                cur.starts.append(s)
                cur.ends.append(e)
            else:
                cur = _Cluster(contig, s, e, [s], [e])
                out.append(cur)
    return out


def _robust_extent(cluster: _Cluster) -> tuple[int, int]:
    """The cluster's extent without its outer 1% of read ends (stray long reads)."""
    starts = sorted(cluster.starts)
    ends = sorted(cluster.ends)
    trim = len(starts) // 100
    return starts[trim], ends[len(ends) - 1 - trim]


def _amplicon_like(clusters: list, total: int, min_reads: int) -> bool:
    if total < 10:
        return False
    big = [c for c in clusters if c.reads >= min_reads]
    if not big or len(big) > MAX_REGIONS:
        return False
    if sum(c.reads for c in big) < AMPLICON_READ_SHARE * total:
        return False
    shared_ends = 0
    for c in big:
        lo, hi = _robust_extent(c)
        if hi - lo > AMPLICON_MAX_WIDTH:
            return False
        starts = sorted(c.starts)
        lengths = sorted(e - s for s, e in zip(c.starts, c.ends))
        decile = len(starts) // 10
        spread = starts[len(starts) - 1 - decile] - starts[decile]
        if spread < 0.5 * lengths[len(lengths) // 2]:
            shared_ends += c.reads
    # Most reads sit in clusters whose reads share their ends.
    return shared_ends >= AMPLICON_READ_SHARE * sum(c.reads for c in big)


def _top_regions(intervals: dict, scope_lo: dict, scope_hi: dict, max_regions: int) -> list:
    """The deepest stretches of the coverage profile, deepest first: (contig, start, end, reads, depth)."""
    out = []
    for contig, rows in intervals.items():
        if not rows:
            continue
        lo, hi = scope_lo.get(contig, rows[0][0]), scope_hi.get(contig, max(e for _s, e in rows))
        if hi <= lo:
            continue
        bins = max(1, min(TOP_BINS, hi - lo))
        size = (hi - lo) / bins
        diff = [0] * (bins + 1)
        for s, e in rows:
            b0 = max(0, int((s - lo) / size))
            b1 = min(bins, int((e - lo - 1) / size) + 1)
            if b1 > b0:
                diff[b0] += 1
                diff[b1] -= 1
        depth, acc = [0] * bins, 0
        for i in range(bins):
            acc += diff[i]
            depth[i] = acc
        taken = [False] * bins
        order = sorted(range(bins), key=lambda i: -depth[i])
        found = 0  # this chromosome's candidates (bounded per chromosome: a later one can be deeper)
        for i in order:
            if depth[i] <= 0 or found >= max_regions * 4:
                break
            if taken[i]:
                continue
            floor = depth[i] * TOP_EXTEND
            a = i
            while a > 0 and not taken[a - 1] and depth[a - 1] >= floor:
                a -= 1
            b = i
            while b + 1 < bins and not taken[b + 1] and depth[b + 1] >= floor:
                b += 1
            for j in range(a, b + 1):
                taken[j] = True
            rs, re_ = int(lo + a * size), int(lo + (b + 1) * size)
            out.append((contig, rs, re_, depth[i]))
            found += 1
    out.sort(key=lambda r: -r[3])
    out = out[:max_regions]
    # Reads overlapping each region; the region trimmed to where they are (a
    # profile bin can be far wider than an amplicon or a short stretch of reads).
    result = []
    starts_of = {contig: [s for s, _e in rows] for contig, rows in intervals.items()}
    for contig, rs, re_, peak in out:
        rows = intervals[contig]
        hi_i = bisect.bisect_left(starts_of[contig], re_)
        inside = [(s, e) for s, e in rows[:hi_i] if e > rs]
        rs, re_ = _trim_to_reads(inside, rs, re_)
        result.append((contig, rs, re_, len(inside), peak))
    return result


def _trim_to_reads(reads: list, start: int, end: int) -> tuple[int, int]:
    """[start, end) without its flanks where the depth is under a tenth of its peak."""
    if not reads or end - start <= 200:
        return start, end
    bins = min(400, end - start)
    size = (end - start) / bins
    diff = [0] * (bins + 1)
    for s, e in reads:
        b0 = max(0, int((s - start) / size))
        b1 = min(bins, int((e - start - 1) / size) + 1)
        if b1 > b0:
            diff[b0] += 1
            diff[b1] -= 1
    depth, acc = [], 0
    for i in range(bins):
        acc += diff[i]
        depth.append(acc)
    floor = max(depth) * 0.1
    lo = next((i for i, d in enumerate(depth) if d > floor), 0)
    hi = next((i for i in range(bins - 1, -1, -1) if depth[i] > floor), bins - 1)
    return int(start + lo * size), int(math.ceil(start + (hi + 1) * size))


def _index_regions(contigs, max_regions: int):
    """From the dataset's indexes: None without a local .bai; else ``(survey, [(contig, start, end, reads,
    depth)])`` with regions only for a targeted dataset (overlapping refined stretches merged)."""
    from services import bam_index_profile as bip
    handles = {}
    for c in contigs:
        if c.path not in handles:
            handles[c.path] = get_bam_handle(c.path)
    sv = bip.survey(handles, [(c.path, c.contig, c.size) for c in contigs])
    if sv is None or not sv.targeted:
        return sv, []
    found: dict = {}
    for path, contig, tid, lo, hi in sv.stretches:
        refs = bip.bam_index(path)
        idx = refs[tid] if refs and 0 <= tid < len(refs) else None
        bam = handles.get(path)
        if idx is None or bam is None:
            continue
        ratio = bip.block_ratio(path, [v for v in idx.linear if v])
        got = bip.refine(bam, idx, tid, lo, hi, ratio)
        if not got:
            # Reads too long for the sampled margin (their starts lie further out): the dense stretch itself,
            # at 16 kb resolution, rather than no region at all.
            wb = bip.window_bytes(idx, ratio)
            reads = sum(wb.get(w, 0.0) for w in range(lo, hi + 1)) / idx.bytes_per_read(ratio)
            got = (lo * bip.WINDOW_BP, (hi + 1) * bip.WINDOW_BP, 0.0, int(round(reads)))
        found.setdefault(contig, []).append(list(got))
    out = []
    for contig, rows in found.items():
        rows.sort()
        merged = [rows[0]]
        for r in rows[1:]:
            if r[0] <= merged[-1][1]:
                merged[-1] = [merged[-1][0], max(merged[-1][1], r[1]), max(merged[-1][2], r[2]), merged[-1][3] + r[3]]
            else:
                merged.append(r)
        out.extend((contig, int(a), int(b), int(n), float(d)) for a, b, d, n in merged)
    out.sort(key=lambda r: -r[3])
    return sv, out[:max_regions]


def detect_regions(state, dataset_id: str, *, chrom: Optional[str] = None, start: Optional[int] = None,
                   end: Optional[int] = None, min_reads: Optional[int] = None,
                   max_regions: int = MAX_REGIONS, force: bool = False) -> dict:
    """Regions of one dataset's reads (see the module comment)."""
    t0 = time.monotonic()
    deadline = t0 + (FORCE_BUDGET_S if force else SCAN_BUDGET_S)
    dataset = state.get_dataset(dataset_id) if dataset_id else None
    if dataset is None:
        return {"success": False, "error": f"No dataset {dataset_id!r}.", "regions": []}
    if getattr(dataset, "data_type", None) != "bam" or not (dataset.paths or []):
        return {"success": False, "refused": True, "regions": [],
                "reason": "Regions are found in BAM reads; this dataset is not a BAM."}
    from services.random_window import _resolve_state_chrom
    genome = region_genome_key(state)
    base = {"genome": genome, "dataset_id": dataset_id, "fingerprint": dataset_fingerprint(dataset)}
    mismatch = _reference_mismatch(state, dataset_id)
    if mismatch:
        # A dm6 BAM under hg38 shares chrX by name: its "amplicons" would be filed under
        # hg38 and named after hg38 genes. Found once it is on its own reference.
        return {**base, "success": False, "refused": True, "mismatch": True, "status": "mismatch", "regions": [],
                "reason": f"{mismatch} Its regions are found once it is shown on its own reference."}
    contigs = _reachable(state, dataset)
    if not contigs:
        return {**base, "success": False, "refused": True, "status": "mismatch", "regions": [],
                "reason": "None of this dataset's reads are on the loaded reference."}

    if chrom is not None:
        # The file's own name for the chromosome (chr1 / 1).
        variants = set(get_chrom_variants(chrom))
        match = next((c.contig for c in contigs if c.contig == chrom or c.contig in variants), None)
        if match is None:
            return {**base, "success": True, "regions": [], "kind": "top", "amplicon_like": False,
                    "elapsed_ms": round((time.monotonic() - t0) * 1000, 1), "scanned_reads": 0,
                    "reason": f"No reads of this dataset on {chrom}."}
        chrom = match
    mapped = {c.contig: c.weight for c in contigs}
    view = chrom is not None and start is not None and end is not None
    if view:
        start, end = max(0, int(start)), int(end)
        if not force and end - start > VIEW_MAX_BP and mapped.get(chrom, 0) > CHROM_MAX_READS:
            return {**base, "success": False, "refused": True, "status": "too-many", "regions": [],
                    "reason": f"The view is {format_distance(end - start)} wide on a chromosome with "
                              f"{int(mapped[chrom]):,} reads: zoom to {format_distance(VIEW_MAX_BP)} or less."}
    elif chrom is not None:
        if not force and mapped.get(chrom, 0) > CHROM_MAX_READS:
            return {**base, "success": False, "refused": True, "status": "too-many", "regions": [],
                    "reason": f"{chrom} has {int(mapped[chrom]):,} reads, too many to scan here "
                              f"(at most {CHROM_MAX_READS:,}): find regions in a view of "
                              f"{format_distance(VIEW_MAX_BP)} or less instead."}
    note = None
    total = int(sum(mapped.values()))
    key = (tuple(sorted(dataset.paths)), base["fingerprint"], genome, tuple(sorted((c.contig, c.size) for c in contigs)),
           chrom, start if view else None, end if view else None, min_reads, max_regions, force,
           id(getattr(state, "gtf_data", None)))
    cached = _CACHE.get(key)
    if cached is not None:
        return {**cached, **base, "cached": True, "elapsed_ms": round((time.monotonic() - t0) * 1000, 1)}

    if chrom is None and not view and not force and total > PRECHECK_ABOVE:
        # Amplicon data of many reads is still read whole (a first sample says so); anything
        # else is looked at from its index: targeted regions, or whole-genome (refused).
        amplicons = False
        if total <= AUTO_MAX_READS:
            densest = max(contigs, key=lambda c: c.weight)
            sample, sampled, _cut = _scan([densest], deadline, densest.contig, None, None, read_cap=PRECHECK_READS)
            amplicons = _amplicon_like(_clusters(sample), sampled, max(3, int(sampled * 0.002)))
        if not amplicons:
            sv, found = _index_regions(contigs, max_regions)
            if sv is not None and not sv.targeted:
                return {**base, "success": False, "refused": True, "status": "whole-genome", "whole_genome": True,
                        "reads": total, "regions": [], "scope": "dataset",
                        "reason": f"Whole-genome data ({total:,} reads): its regions are not a few loci. "
                                  f"Find regions in the view or on one chromosome.",
                        "elapsed_ms": round((time.monotonic() - t0) * 1000, 1)}
            if sv is not None:
                genes = GeneIndex(getattr(state, "gtf_data", None))
                floor = int(min_reads) if min_reads else max(3, int(total * 0.002))
                regions = []
                for contig, rs, re_, reads, depth in sorted(found, key=lambda r: (r[0], r[1])):
                    if reads < floor:
                        continue
                    shown = _resolve_state_chrom(state, contig)
                    regions.append({"chrom": shown, "start": rs, "end": re_, "reads": reads, "depth": round(depth, 1),
                                    **genes.label(shown, rs, re_)})
                result = {**base, "success": True, "kind": "targeted", "method": "index", "status": "scanned",
                          "amplicon_like": False, "regions": regions, "scanned_reads": 0, "reads": total,
                          "partial": False, "min_reads": floor, "small_clusters": 0, "gene_labels": genes.loaded,
                          "scope": "dataset",
                          "note": f"Found from the BAM index ({total:,} reads, not read one by one); read counts are estimates."}
                _CACHE[key] = result
                return {**result, "elapsed_ms": round((time.monotonic() - t0) * 1000, 1)}
            # No local .bai (a CSI index, a remote file): the reads themselves, as far as the bounds allow.
            if total > AUTO_MAX_READS:
                return {**base, "success": False, "refused": True, "status": "too-many", "reads": total, "regions": [],
                        "scope": "dataset",
                        "reason": f"This dataset has {total:,} reads and no local .bai index to find its regions from: "
                                  f"find regions on one chromosome or in the view (or scan anyway, slowly)."}
            note = "No local .bai index: found by reading the reads."

    if chrom is None and not view and not force and total > AUTO_MAX_READS:
        return {**base, "success": False, "refused": True, "status": "too-many", "reads": total, "regions": [],
                "scope": "dataset",
                "reason": f"This dataset has {total:,} reads, too many to scan whole "
                          f"(at most {AUTO_MAX_READS:,}): find regions on one chromosome or in the view."}
    intervals, seen, partial = _scan(contigs, deadline, chrom, start if view else None, end if view else None,
                                     read_cap=FORCE_READ_CAP if force else 0, record_cap=FORCE_RECORD_CAP if force else 0)
    if force:
        note = f"Scanned anyway: read {seen:,} reads" + (" (stopped at the read or time limit)." if partial else ".")
    elif partial:
        note = f"Stopped at the read or time limit after {seen:,} reads: regions are from those."
    clusters = _clusters(intervals)
    floor = int(min_reads) if min_reads else max(3, int(seen * 0.002))
    amplicon = chrom is None and not view and _amplicon_like(clusters, seen, floor)
    if not amplicon and chrom is None and not view:
        # Few reads that don't look like amplicons (targeted capture, a small BAM): the clusters.
        amplicon_shape = len(clusters) <= MAX_REGIONS and all(c.end - c.start <= AMPLICON_MAX_WIDTH for c in clusters if c.reads >= floor)
    else:
        amplicon_shape = False

    genes = GeneIndex(getattr(state, "gtf_data", None))
    regions = []
    if amplicon or amplicon_shape:
        for c in sorted((c for c in clusters if c.reads >= floor), key=lambda c: (c.contig, c.start))[:max_regions]:
            lo, hi = _robust_extent(c)
            shown = _resolve_state_chrom(state, c.contig)
            regions.append({"chrom": shown, "start": int(lo), "end": int(hi), "reads": c.reads,
                            **genes.label(shown, int(lo), int(hi))})
        kind = "amplicon" if amplicon else "cluster"
    else:
        scope_lo, scope_hi = {}, {}
        if view:
            scope_lo[chrom], scope_hi[chrom] = start, end
        elif chrom is not None:
            size = next((c.size for c in contigs if c.contig == chrom), 0)
            scope_lo[chrom], scope_hi[chrom] = 0, size
        for contig, rs, re_, reads, depth in _top_regions(intervals, scope_lo, scope_hi, max_regions):
            if reads < floor:
                continue  # a stray read or two is not a region
            shown = _resolve_state_chrom(state, contig)
            regions.append({"chrom": shown, "start": rs, "end": re_, "reads": reads, "depth": depth,
                            **genes.label(shown, rs, re_)})
        kind = "top"
    hidden = sum(1 for c in clusters if c.reads < floor) if kind != "top" else 0
    result = {
        **base,
        "success": True,
        "status": "scanned",
        "method": "reads",
        **({"note": note} if note else {}),
        "kind": kind,
        "amplicon_like": amplicon,
        "regions": regions,
        "scanned_reads": seen,
        "partial": partial,
        "min_reads": floor,
        "small_clusters": hidden,
        "gene_labels": genes.loaded,
        "scope": "view" if view else "chrom" if chrom is not None else "dataset",
    }
    if not partial:
        _CACHE[key] = result
    return {**result, "elapsed_ms": round((time.monotonic() - t0) * 1000, 1)}
