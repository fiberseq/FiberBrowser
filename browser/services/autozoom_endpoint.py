"""Endpoint orchestration helpers for read-boundary autozoom."""
from __future__ import annotations

import time

import numpy as np

from models.requests import AutozoomRequest
from services.bam_boundaries import get_read_boundaries_from_bam
from services.filter_diagnostics import log_filtering_diagnostic
from services.plasmid_reconcile import contig_links
from services.query_params import resolve_dataset_ids


def autozoom_from_boundaries(
    boundaries: list[tuple[int, int]],
    req: AutozoomRequest,
    *,
    chrom: str,
    start: int,
    end: int,
    search_start: int,
    search_end: int,
) -> dict:
    """Pick an autozoom window from precomputed read boundaries."""
    if not boundaries:
        return {"success": False, "message": "No reads found in search region"}

    current_width = end - start
    starts = np.array([boundary[0] for boundary in boundaries], dtype=np.int64)
    ends = np.array([boundary[1] for boundary in boundaries], dtype=np.int64)
    n_reads = len(starts)

    bin_size = req.cluster_window
    starts_clipped = np.clip(starts, search_start, search_end)
    start_bins = (starts_clipped - search_start) // bin_size
    n_bins = (search_end - search_start) // bin_size + 1
    start_counts = np.bincount(start_bins.astype(int), minlength=n_bins)

    ends_clipped = np.clip(ends, search_start, search_end)
    end_bins = (ends_clipped - search_start) // bin_size
    end_counts = np.bincount(end_bins.astype(int), minlength=n_bins)

    best_start_bin = np.argmax(start_counts)
    left_primer = search_start + best_start_bin * bin_size + bin_size // 2
    left_count = start_counts[best_start_bin]

    min_right_bin = (left_primer - search_start) // bin_size + 1
    end_counts_masked = end_counts.copy()
    end_counts_masked[:min_right_bin] = 0
    # (With no read ending right of the left primer, argmax would pick bin 0,
    # left of it.)
    if min_right_bin < len(end_counts) and end_counts_masked.max() > 0:
        best_end_bin = np.argmax(end_counts_masked)
        right_primer = search_start + best_end_bin * bin_size + bin_size // 2
        right_count = end_counts[best_end_bin]
    else:
        right_primer = search_end
        right_count = 0

    log_filtering_diagnostic(
        f"  Primer detection: left={left_primer} ({left_count} reads), "
        f"right={right_primer} ({right_count} reads)"
    )

    cluster_threshold = 0.20
    has_left_cluster = left_count > n_reads * cluster_threshold
    has_right_cluster = right_count > n_reads * cluster_threshold
    if has_left_cluster and has_right_cluster:
        best_left = left_primer + req.primer_clip
        best_right = right_primer - req.primer_clip
        log_filtering_diagnostic(f"  Detected primer sites, clipping inward by {req.primer_clip}bp")
    else:
        log_filtering_diagnostic(
            f"  No clear primer sites (threshold={cluster_threshold*100:.0f}%), preserving viewport width"
        )
        best_left = start
        best_right = end

    if best_right - best_left < 500:
        midpoint = (best_left + best_right) // 2
        best_left = midpoint - 250
        best_right = midpoint + 250

    spanning_mask = (starts <= best_left) & (ends >= best_right)
    best_count = int(np.sum(spanning_mask))

    if best_count < req.min_reads:
        log_filtering_diagnostic(
            f"  Primer-based window only has {best_count} reads, trying exhaustive search..."
        )
        min_width = max(100, current_width // 4)
        max_width = current_width * 2
        unique_starts = np.unique(starts)
        unique_ends = np.unique(ends)

        max_edges = 100
        if len(unique_starts) > max_edges:
            indices = np.linspace(0, len(unique_starts) - 1, max_edges, dtype=int)
            unique_starts = unique_starts[indices]
        if len(unique_ends) > max_edges:
            indices = np.linspace(0, len(unique_ends) - 1, max_edges, dtype=int)
            unique_ends = unique_ends[indices]

        unique_starts = unique_starts[
            (unique_starts >= search_start) & (unique_starts <= search_end - min_width)
        ]
        unique_ends = unique_ends[
            (unique_ends >= search_start + min_width) & (unique_ends <= search_end)
        ]

        if len(unique_starts) > 0 and len(unique_ends) > 0:
            for candidate_left in unique_starts:
                valid_ends = ends[starts <= candidate_left]
                if len(valid_ends) == 0:
                    continue
                sorted_valid_ends = np.sort(valid_ends)
                for candidate_right in unique_ends:
                    width = candidate_right - candidate_left
                    if width < min_width or width > max_width:
                        continue
                    index = np.searchsorted(sorted_valid_ends, candidate_right, side="left")
                    count = len(sorted_valid_ends) - index
                    if count > best_count:
                        best_count = count
                        best_left, best_right = candidate_left, candidate_right

    if best_count >= req.min_reads:
        return {
            "success": True,
            "chrom": chrom,
            "start": int(best_left),
            "end": int(best_right),
            "spanning_reads": int(best_count),
            "original_start": start,
            "original_end": end,
            "left_primer": int(left_primer),
            "right_primer": int(right_primer),
            "primer_clip": req.primer_clip,
        }

    return {
        "success": False,
        "message": f"No window found with at least {req.min_reads} spanning reads",
        "best_count": int(best_count),
        "left_primer": int(left_primer),
        "right_primer": int(right_primer),
    }


def autozoom_for_request(
    state,
    req: AutozoomRequest,
    *,
    chrom: str,
    start: int,
    end: int,
) -> dict:
    """Find the optimal window within +/- distance that maximizes spanning reads."""
    t0 = time.time()
    chrom = state.translate_chrom(chrom)
    dataset_ids = resolve_dataset_ids(state, dataset_ids=req.dataset_ids)
    from services.lift.capability import require_for_ids
    require_for_ids(state, dataset_ids, "autozoom")
    if not dataset_ids:
        return {"success": False, "message": "No datasets available"}

    search_start = max(0, start - req.distance)
    search_end = end + req.distance
    log_filtering_diagnostic(
        f"Autozoom: searching {chrom}:{search_start}-{search_end} (distance={req.distance})"
    )

    boundaries = []
    for dataset_id in dataset_ids:
        dataset = state.get_dataset(dataset_id)
        if not dataset or dataset.data_type != "bam":
            continue
        # This dataset's plasmid links (a map shown for a contig of another name).
        links = contig_links(state, dataset_id=dataset_id)
        # Every BAM of a merged dataset: the view shows reads from all of them.
        for bam_path in dataset.paths or []:
            boundaries.extend(
                get_read_boundaries_from_bam(
                    bam_path,
                    chrom,
                    search_start,
                    search_end,
                    max_reads=10000,
                    chrom_map=getattr(state, "chrom_map", None),
                    **({"contig_links": links} if links else {}),
                )
            )

    if not boundaries:
        return {"success": False, "message": "No reads found in search region"}

    log_filtering_diagnostic(f"  Found {len(boundaries)} reads in {time.time() - t0:.3f}s")
    response = autozoom_from_boundaries(
        boundaries,
        req,
        chrom=chrom,
        start=start,
        end=end,
        search_start=search_start,
        search_end=search_end,
    )
    if response.get("success"):
        log_filtering_diagnostic(
            f"  Best window: {response['start']}-{response['end']} with "
            f"{response['spanning_reads']} spanning reads ({time.time() - t0:.3f}s)"
        )
    return response
