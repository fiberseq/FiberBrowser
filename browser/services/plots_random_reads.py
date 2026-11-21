"""Plots: N random reads of each dataset's whole BAM (Where = Random reads), by the stable sampling rule
(services/stable_sample): a read's key is blake2b-64 of (seed, dataset, read name); each contig gets its share of N
in proportion to its mapped reads (index statistics, largest remainder); a contig's sample is its reads with the
smallest keys. Primary mapped reads only (no unmapped, secondary or supplementary), and QC-fail reads (0x200, which
include FiberHMM's DAF strand-swap chimeras) and xc:Z:strand_swap reads are skipped unless asked for.

Two chunked phases, so the client shows progress and can cancel between requests:
- scan: per segment of a contig, the candidate reads (name, key) whose key is below a threshold that keeps about
  three times the contig's share (the client keeps the contig's smallest keys, so the result does not depend on
  segments or chunks);
- reads: per segment, the chosen reads' engine rows (whole reads, absolute coordinates).
"""
from __future__ import annotations

import math
from typing import Dict, List, Tuple

from services.stable_sample import KEY_SPACE, stable_key

SEGMENT_BP = 20_000_000
OVERSAMPLE = 3.0


def contig_stats(paths: List[str]) -> List[Tuple[str, int, int]]:
    """(contig, length, mapped reads) over a dataset's BAMs, in header order."""
    import pysam
    out: Dict[str, List[int]] = {}
    order: List[str] = []
    for p in paths:
        with pysam.AlignmentFile(p, "rb") as bam:
            lengths = dict(zip(bam.references, bam.lengths))
            for st in bam.get_index_statistics():
                if st.contig not in out:
                    out[st.contig] = [lengths.get(st.contig, 0), 0]
                    order.append(st.contig)
                out[st.contig][1] += int(st.mapped)
    return [(c, out[c][0], out[c][1]) for c in order if out[c][1] > 0]


def allocate(n: int, mapped: List[int]) -> List[int]:
    """N split in proportion to mapped reads (largest remainder; ties by contig order)."""
    total = sum(mapped)
    if total <= 0 or n <= 0:
        return [0] * len(mapped)
    n = min(n, total)
    exact = [n * m / total for m in mapped]
    base = [min(m, int(math.floor(e))) for e, m in zip(exact, mapped)]
    rest = n - sum(base)
    order = sorted(range(len(mapped)), key=lambda i: (-(exact[i] - base[i]), i))
    for i in order:
        if rest <= 0:
            break
        if base[i] < mapped[i]:
            base[i] += 1
            rest -= 1
    return base


def plan(datasets: Dict[str, List[str]], n: int) -> List[dict]:
    """The scan jobs (dataset, contig, segment) with each contig's share and candidate threshold."""
    jobs = []
    for ds, paths in datasets.items():
        stats = contig_stats(paths)
        shares = allocate(n, [m for _, _, m in stats])
        for (contig, length, mapped), share in zip(stats, shares):
            if share <= 0:
                continue
            frac = min(1.0, OVERSAMPLE * share / mapped + 32.0 / mapped)
            for s in range(0, max(1, length), SEGMENT_BP):
                jobs.append(dict(dataset=ds, contig=contig, start=s, end=min(length, s + SEGMENT_BP), share=share, mapped=mapped, frac=frac))
    return jobs


def eligible(read, include_qcfail: bool = False, hide_uncalled: bool = True) -> bool:
    """A primary mapped read, not QC-failed or a strand-swap chimera (unless asked), and with footprint calls unless
    Min footprints is "All reads, including uncalled": the one per-record rule (services/bam_tags.record_passes_call_rule),
    so a QC-fail record shown by choice is exempt, as in the read loaders."""
    if read.is_unmapped or read.is_secondary or read.is_supplementary:
        return False
    from services.bam_tags import record_passes_call_rule
    if not record_passes_call_rule(read, hide_uncalled):
        return False
    if not include_qcfail:
        if read.is_qcfail:
            return False
        try:
            if read.has_tag("xc") and str(read.get_tag("xc")) == "strand_swap":
                return False
        except (KeyError, ValueError):
            pass
    return True


def scan_segment(paths: List[str], dataset: str, contig: str, start: int, end: int, frac: float, seed: int,
                 include_qcfail: bool = False, hide_uncalled: bool = True) -> List[Tuple[str, int, int]]:
    """Candidates (name, key, start) of reads starting in [start, end) whose key is below frac."""
    import pysam
    limit = frac * KEY_SPACE
    seen = set()
    out = []
    for p in paths:
        with pysam.AlignmentFile(p, "rb") as bam:
            for read in bam.fetch(contig, start, end):
                if read.reference_start < start or read.reference_start >= end or not eligible(read, include_qcfail, hide_uncalled):
                    continue
                name = read.query_name
                if name in seen:
                    continue
                key = stable_key(seed, dataset, name)
                if key < limit:
                    seen.add(name)
                    out.append((name, key, int(read.reference_start)))
    return out


def select(candidates: List[Tuple[str, int, int]], share: int) -> List[Tuple[str, int, int]]:
    """A contig's sample: its share of candidates with the smallest keys (ties by name)."""
    return sorted(candidates, key=lambda c: (c[1], c[0]))[:max(0, share)]


READ_SPAN_BP = 100_000   # past the last chosen start, so whole reads are loaded


def read_rows(state, query, dataset: str, contig: str, names: List[str], starts: List[int], source: str, occluders: bool) -> List[list]:
    """The chosen reads' engine rows [start, end, source flat, marks, nucleosomes flat, name], absolute coordinates."""
    from services.plots_regions import engine_read
    if not names:
        return []
    lo, hi = max(0, min(starts)), max(starts) + READ_SPAN_BP
    ws = query.build_working_set(state, dataset, chrom=contig, start=lo, end=hi, read_ids=list(names))
    want = set(names)
    out, seen = [], set()
    for r in ws.reads:
        name = str(r.get("id"))
        if name not in want or name in seen:
            continue
        row = engine_read(r, ws.start, source, occluders)
        if row:
            seen.add(name)
            out.append(row + [name])
    return sorted(out, key=lambda r: (r[0], r[5]))
