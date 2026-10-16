"""FIRE BED loading and signal helpers."""
from __future__ import annotations

import os
from typing import Iterable, Optional

import numpy as np

from services.diagnostics import log_if_enabled

TRACK_DIAGNOSTICS_ENV = "FIBERBROWSER_TRACK_DIAGNOSTICS"


def load_fire_data(fire_dir):
    """Load FIRE BED files from a directory."""
    if not fire_dir or not os.path.exists(fire_dir):
        return None

    import pandas as pd

    log_if_enabled(TRACK_DIAGNOSTICS_ENV, f"Loading FIRE data from {fire_dir}...")
    dfs = []
    for f in os.listdir(fire_dir):
        if f.endswith((".bed", ".bed.gz")):
            try:
                # Chromosome names stay strings ("1" must not become the integer 1).
                dfs.append(pd.read_csv(os.path.join(fire_dir, f), sep="\t", header=None, dtype={0: str}))
            except Exception:
                pass

    if not dfs:
        return None

    fire = pd.concat(dfs).reset_index(drop=True)
    fire.columns = ["chrom", "start", "end"] + [f"col{i}" for i in range(3, fire.shape[1])]
    # Keep chromosome names as-is; normalization is handled by chrom_map.

    log_if_enabled(TRACK_DIAGNOSTICS_ENV, f"Loaded {len(fire)} FIRE peaks")
    return fire


def compute_fire_track(
    fire_df,
    chrom,
    start,
    end,
    query_segments: Optional[Iterable[tuple[int, int, int]]] = None,
):
    """Compute FIRE signal and peaks."""
    width = end - start
    if fire_df is None:
        return np.zeros(width), [], []

    fire_track = np.zeros(width)
    segments = list(query_segments) if query_segments is not None else [(start, end, 0)]

    if width > 0:
        diff = np.zeros(width + 1)
        for query_start, query_end, coord_shift in segments:
            mask = (
                (fire_df["chrom"] == chrom)
                & (fire_df["end"] >= query_start)
                & (fire_df["start"] <= query_end)
            )
            subset = fire_df.loc[mask]
            if subset.empty:
                continue

            starts = (
                np.maximum(query_start, subset["start"].to_numpy(dtype=np.int64))
                + coord_shift
                - start
            )
            ends = (
                np.minimum(query_end, subset["end"].to_numpy(dtype=np.int64))
                + coord_shift
                - start
            )
            starts = np.maximum(0, starts)
            ends = np.minimum(width, ends)
            valid = ends > starts

            np.add.at(diff, starts[valid], 1)
            np.add.at(diff, ends[valid], -1)
        fire_track = np.cumsum(diff[:width])

    if fire_track.max() == 0:
        return fire_track, [], []

    from scipy.signal import find_peaks, peak_widths

    peaks, _ = find_peaks(
        fire_track,
        distance=200,
        width=20,
        height=max(fire_track.max() / 5, 1),
    )
    if len(peaks) == 0:
        return fire_track, [], []

    results = peak_widths(fire_track, peaks)
    peak_regions = []
    for l, r in zip(results[2].astype(int), results[3].astype(int)):
        if r - l < 200:
            expand = (200 - (r - l)) // 2
            l, r = max(0, l - expand), min(width, r + expand)
        peak_regions.append([l, r])

    return fire_track, peaks.tolist(), peak_regions
