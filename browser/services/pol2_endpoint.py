"""Endpoint orchestration helpers for Pol II center-of-mass analysis."""
from __future__ import annotations

from services.gene_ids import resolve_selected_transcripts
import time

import numpy as np

from models.requests import Pol2COMRequest
from services.analysis_query import AnalysisReadQuery
from services.filter_diagnostics import log_filtering_diagnostic
from services.transcription_state import resolve_tf_source


def _empty_pol2_result(n_bins: int, viewport_size: int, gene_body_size: int = 0) -> dict:
    return {
        "binary_matrix": [],
        "smoothed_matrix": [],
        "read_ids": [],
        "com_values": [],
        "n_reads": 0,
        "n_bins": n_bins,
        "gene_body_size": gene_body_size,
        "viewport_size": viewport_size,
    }


def _resolve_pol2_genes(state, gene_ids: list[str], chrom: str | None = None) -> list[dict]:
    return [{k: g[k] for k in ("id", "start", "end", "strand")}
            for g in resolve_selected_transcripts(state, gene_ids, chrom)]


def _mark_gene_bins(
    binary_row: list[int],
    *,
    ov_start: int,
    ov_end: int,
    gene_from: int,
    gene_bin_size: float,
    gene_strand: str,
    n_bins: int,
) -> None:
    # Half-open [ov_start, ov_end): the last base covered is ov_end - 1.
    bin_start = int((ov_start - gene_from) / gene_bin_size)
    bin_end = int((ov_end - gene_from - 1) / gene_bin_size)
    if gene_strand == "-":
        bin_start = n_bins - 1 - int((ov_end - gene_from - 1) / gene_bin_size)
        bin_end = n_bins - 1 - int((ov_start - gene_from) / gene_bin_size)
    for bin_index in range(max(0, bin_start), min(n_bins, bin_end + 1)):
        binary_row[bin_index] = 1


def _add_accessibility_bins(
    access_row: list[float],
    *,
    interval_start: int,
    interval_end: int,
    region_start: int,
    region_end: int,
    viewport_bin_size: float,
    n_bins: int,
) -> None:
    viewport_start = max(interval_start, region_start)
    viewport_end = min(interval_end, region_end)
    if viewport_end <= viewport_start:
        return

    bin_start = int((viewport_start - region_start) / viewport_bin_size)
    bin_end = int((viewport_end - region_start) / viewport_bin_size)
    for bin_index in range(max(0, bin_start), min(n_bins, bin_end + 1)):
        bin_from = region_start + bin_index * viewport_bin_size
        bin_to = region_start + (bin_index + 1) * viewport_bin_size
        covered_start = max(viewport_start, bin_from)
        covered_end = min(viewport_end, bin_to)
        if covered_end > covered_start and viewport_bin_size > 0:
            access_row[bin_index] += (covered_end - covered_start) / viewport_bin_size


def _pol2_row_for_read(
    read: dict,
    req: Pol2COMRequest,
    *,
    region_start: int,
    region_end: int,
    n_bins: int,
    genes: list[tuple[int, int, str]] | None = None,
    gene_from: int | None = None,
    gene_to: int | None = None,
    gene_strand: str = "+",
) -> tuple[float, str, list[int], list[float]] | None:
    """A read's Pol II row: each footprint placed within the gene body it lies
    in (as a fraction of that gene, in its own strand's direction), so several
    selected genes form one metagene and the gaps between them count for nothing."""
    if genes is None:
        genes = [(gene_from, gene_to, gene_strand)]
    genes = [(lo, hi, strand) for lo, hi, strand in genes if hi > lo]
    read_id = read["id"]
    intervals = read.get("intervals", [])
    if not intervals or not genes:
        return None

    read_min = region_start + min(interval[0] for interval in intervals)
    read_max = region_start + max(interval[1] for interval in intervals)
    if not any(read_max >= lo and read_min <= hi for lo, hi, _strand in genes):
        return None

    viewport_bin_size = (region_end - region_start) / n_bins
    pol2_midpoints = []
    binary_row = [0] * n_bins
    access_row = [0.0] * n_bins

    for interval_start, interval_end, size, *_rest in resolve_tf_source(read):
        if size <= 0 or not (req.fp_size_min <= size <= req.fp_size_max):
            continue
        abs_start = region_start + interval_start
        abs_end = region_start + interval_end
        for lo, hi, strand in genes:
            ov_start = max(abs_start, lo)
            ov_end = min(abs_end, hi)
            if ov_end <= ov_start:
                continue
            body = hi - lo
            midpoint = (ov_start + ov_end) / 2.0
            frac = (midpoint - lo) / body
            if strand == "-":
                frac = 1.0 - frac
            pol2_midpoints.append(frac)
            _mark_gene_bins(
                binary_row,
                ov_start=ov_start,
                ov_end=ov_end,
                gene_from=lo,
                gene_bin_size=body / n_bins,
                gene_strand=strand,
                n_bins=n_bins,
            )

    # Accessible stretches: the read's FIRE/MSP calls (the "msp" layer, or the
    # top-level "fire" list on BAM reads without layers), else the gaps between
    # footprints (negative sizes in compact intervals) longer than 100 bp.
    # (Positive sizes are footprints: those over 100 bp are nucleosomes.)
    # A present msp layer or fire list is authoritative even when empty: loaders
    # never emit empty ones, so empty means a quality filter removed every call,
    # and falling back to the gaps would restore what the filter took out.
    layers = read.get("layers") or {}
    if layers.get("msp") is not None:
        source = layers["msp"].get("intervals") or []
    elif read.get("fire") is not None:
        source = read["fire"]
    else:
        source = [iv for iv in intervals if len(iv) > 2 and iv[2] < -100]
    accessible = [iv for iv in source if len(iv) >= 2]
    for interval_start, interval_end, *_rest in accessible:
        _add_accessibility_bins(
            access_row,
            interval_start=region_start + interval_start,
            interval_end=region_start + interval_end,
            region_start=region_start,
            region_end=region_end,
            viewport_bin_size=viewport_bin_size,
            n_bins=n_bins,
        )

    if not pol2_midpoints:
        return None
    return sum(pol2_midpoints) / len(pol2_midpoints), read_id, binary_row, access_row


def _smoothed_accessibility_rows(rows: list[tuple], smoothing_sigma: float) -> list[list[float]]:
    if not rows:
        return []

    raw_matrix = np.array([row[3] for row in rows], dtype=float)
    if smoothing_sigma > 0 and raw_matrix.shape[0] > 1:
        from scipy.ndimage import gaussian_filter1d

        smoothed_matrix = gaussian_filter1d(raw_matrix, sigma=smoothing_sigma, axis=0)
    else:
        smoothed_matrix = raw_matrix

    smoothed_max = smoothed_matrix.max()
    if smoothed_max > 0:
        smoothed_matrix = smoothed_matrix / smoothed_max
    return [[min(1.0, float(value)) for value in row] for row in smoothed_matrix]


def pol2_com_for_request(
    state,
    req: Pol2COMRequest,
    *,
    chrom: str,
    start: int,
    end: int,
    spanning: bool = False,
) -> dict:
    """Compute Pol II center-of-mass heatmaps for reads overlapping selected genes."""
    t0 = time.time()
    query = AnalysisReadQuery.from_request(
        state,
        chrom=chrom,
        start=start,
        end=end,
        spanning=spanning,
        dataset_ids=req.dataset_ids,
        sample_seed=req.sample_seed,
    )
    n_bins = max(10, min(500, req.n_bins))
    genes = _resolve_pol2_genes(state, req.gene_ids, query.chrom)
    if not genes:
        return {"results": {}, "sample_seed": query.sample_seed}

    # Each selected gene is its own body (a metagene across several): never
    # one span from the first gene's start to the last one's end.
    gene_bodies = [(min(g["start"], g["end"]), max(g["start"], g["end"]), g["strand"]) for g in genes]
    gene_bodies = [body for body in gene_bodies if body[1] > body[0]]
    gene_body_size = (
        int(round(sum(hi - lo for lo, hi, _ in gene_bodies) / len(gene_bodies))) if gene_bodies else 0
    )
    viewport_size = end - start
    results = {}

    for dataset_id in query.dataset_ids:
        working_set = query.build_working_set(state, dataset_id)
        if not working_set.reads:
            results[dataset_id] = _empty_pol2_result(n_bins, viewport_size, 0)
            continue
        if gene_body_size <= 0:
            results[dataset_id] = _empty_pol2_result(n_bins, viewport_size, 0)
            continue

        rows = []
        for read in working_set.reads:
            row = _pol2_row_for_read(
                read,
                req,
                region_start=start,
                region_end=end,
                n_bins=n_bins,
                genes=gene_bodies,
            )
            if row is not None:
                rows.append(row)

        rows.sort(key=lambda row: row[0])
        if len(rows) > 2000:
            step = len(rows) / 2000
            rows = [rows[int(i * step)] for i in range(2000)]

        results[dataset_id] = {
            "binary_matrix": [row[2] for row in rows],
            "smoothed_matrix": _smoothed_accessibility_rows(rows, req.smoothing_sigma),
            "read_ids": [row[1] for row in rows],
            "com_values": [round(row[0], 4) for row in rows],
            "n_reads": len(rows),
            "n_bins": n_bins,
            "gene_body_size": gene_body_size,
            "viewport_size": viewport_size,
        }

    log_filtering_diagnostic(
        f"Pol2COM completed in {time.time() - t0:.3f}s: "
        f"{sum(result['n_reads'] for result in results.values())} total reads"
    )
    return {"results": results, "sample_seed": query.sample_seed}
