"""Endpoint scoping and cache helpers for co-accessibility routes."""
from __future__ import annotations

import hashlib
import io
import json
import threading
import time
from services.byte_cache import shared_cache
from dataclasses import dataclass
from typing import Optional

import numpy as np
from fastapi import HTTPException

from services.analysis_query import AnalysisReadQuery
from services.coaccessibility import (
    build_accessibility_matrix as _build_accessibility_matrix,
    compute_normalized_matrix as _compute_normalized_matrix,
    pick_bin_size as _pick_bin_size,
)
from services.query_params import parse_optional_csv_list
from services.working_sets import make_quality_key
from services.compact_read_loader import short_terminal_footprint_bp_for
from services.read_quality_filters import active_quality_filters


_COACC_MATRIX_CACHE_TTL = 15.0
_coacc_matrix_cache = shared_cache('profiles')
_coacc_matrix_inflight: dict[tuple, threading.Event] = {}
_coacc_matrix_cache_lock = threading.Lock()


@dataclass(frozen=True)
class CoaccRequestScope:
    query: AnalysisReadQuery
    bin_size: int

    @property
    def chrom(self) -> str:
        return self.query.chrom

    @property
    def start(self) -> int:
        return self.query.start

    @property
    def end(self) -> int:
        return self.query.end

    @property
    def region_width(self) -> int:
        return self.query.region_width

    @property
    def sample_seed(self) -> str:
        return self.query.sample_seed


def _parse_read_ids(read_ids: Optional[str]) -> Optional[list[str]]:
    """Parse comma-separated read IDs string into list (or None)."""
    return parse_optional_csv_list(read_ids)


def _parse_read_ids_by_dataset(raw: Optional[str]) -> Optional[dict[str, list[str]]]:
    """Parse JSON-encoded dataset-scoped read IDs from query params."""
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="read_ids_by_dataset must be JSON") from exc
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=400, detail="read_ids_by_dataset must be a JSON object")

    scoped: dict[str, list[str]] = {}
    for dataset_id, values in parsed.items():
        if values is None:
            continue
        if isinstance(values, str):
            values = [values]
        if not isinstance(values, list):
            raise HTTPException(
                status_code=400,
                detail="read_ids_by_dataset values must be lists of read IDs",
            )
        scoped[str(dataset_id)] = [str(value) for value in values if str(value)]
    return scoped or None


def _ids_signature(values: list[str] | tuple[str, ...]) -> tuple[int, str]:
    digest = hashlib.blake2b(digest_size=12)
    for value in values:
        digest.update(str(value).encode())
        digest.update(b"\0")
    return len(values), digest.hexdigest()


def _dataset_signature(state, dataset_ids: list[str]) -> tuple:
    parts = []
    for dataset_id in dataset_ids:
        dataset = state.get_dataset(dataset_id) if hasattr(state, "get_dataset") else None
        parts.append((
            dataset_id,
            getattr(dataset, "path", None),
            tuple(getattr(dataset, "paths", []) or []),
            tuple(sorted((getattr(dataset, "available_layers", {}) or {}).items())),
            tuple(sorted((getattr(dataset, "derived_layers", {}) or {}).keys())),
        ))
    return tuple(parts)


def _coacc_matrix_cache_key(
    state,
    scope: CoaccRequestScope,
    normalization: str,
    min_coverage: int,
    signal_type: str,
    layer: Optional[str],
) -> tuple:
    from services.signal_evidence import signal_filter_key
    from services.background_work import dataset_identity
    query = scope.query
    read_id_parts = tuple(
        (dataset_id, _ids_signature(tuple(ids)))
        for dataset_id, ids in sorted(query.read_ids_by_dataset.items())
    )
    return (
        id(state),
        _dataset_signature(state, query.dataset_ids),
        dataset_identity(state, query.dataset_ids),
        signal_filter_key(state),
        int(getattr(state, 'max_working_reads', 0) or 0),
        query.chrom,
        query.start,
        query.end,
        tuple(query.dataset_ids),
        bool(query.spanning),
        query.sample_seed,
        read_id_parts,
        None if query.singleton_read_ids is None else _ids_signature(tuple(query.singleton_read_ids)),
        query.max_reads,
        query.min_footprints,
        bool(query.include_methylation),
        bool(query.include_layers),
        tuple(query.requested_layers),
        # How legacy nucleosome/TF layers are inferred changes the reads' layers.
        bool(query.infer_legacy_layers),
        int(query.legacy_nuc_min_size),
        # Read-end footprints dropped at load time.
        short_terminal_footprint_bp_for(state),
        tuple(sorted(query.strand_by_dataset.items())),
        make_quality_key(active_quality_filters(state)),
        int(scope.bin_size),
        str(normalization),
        int(min_coverage),
        str(signal_type),
        str(layer or ""),
    )


def _get_cached_normalized_matrix(
    state,
    scope: CoaccRequestScope,
    normalization: str,
    min_coverage: int,
    signal_type: str = "accessibility",
    layer: Optional[str] = None,
):
    """Short-lived cache for duplicate co-accessibility panel requests."""
    key = _coacc_matrix_cache_key(state, scope, normalization, min_coverage, signal_type, layer)
    while True:
        now = time.time()
        with _coacc_matrix_cache_lock:
            cached = _coacc_matrix_cache.get(key)
            if cached and now - cached[0] <= _COACC_MATRIX_CACHE_TTL:
                _coacc_matrix_cache.move_to_end(key)
                return cached[1]
            if cached:
                del _coacc_matrix_cache[key]

            inflight = _coacc_matrix_inflight.get(key)
            if inflight is None:
                inflight = threading.Event()
                _coacc_matrix_inflight[key] = inflight
                break

        # Another request is already computing this exact matrix. Wait for it
        # to populate the cache, then loop back through the normal cache path.
        inflight.wait()

    try:
        result = _compute_normalized_matrix(
            state,
            scope.query,
            scope.bin_size,
            normalization,
            min_coverage,
            signal_type=signal_type,
            layer=layer,
        )
    except Exception:
        with _coacc_matrix_cache_lock:
            if _coacc_matrix_inflight.pop(key, None) is inflight:
                inflight.set()
        raise

    with _coacc_matrix_cache_lock:
        if key == _coacc_matrix_cache_key(state, scope, normalization, min_coverage, signal_type, layer):
            _coacc_matrix_cache[key] = (time.time(), result)
            _coacc_matrix_cache.move_to_end(key)
        if _coacc_matrix_inflight.pop(key, None) is inflight:
            inflight.set()
    return result


# Largest co-accessibility matrix side: each matrix is bins x bins float32
# (2,000 bins = 16 MB), and a request builds a few of them plus reads x bins.
MAX_COACC_BINS = 2000


def _coacc_scope(
    state,
    *,
    chrom: str,
    start: int,
    end: int,
    bin_size: int = 0,
    dataset_ids: Optional[str] = None,
    read_ids: Optional[str] = None,
    read_ids_by_dataset: Optional[str] = None,
    layer: Optional[str] = None,
    sample_seed: Optional[str] = None,
) -> CoaccRequestScope:
    requested_layers = None if layer == "all_fp" else ([layer] if layer else None)
    query = AnalysisReadQuery.from_request(
        state,
        chrom=chrom,
        start=start,
        end=end,
        dataset_ids=dataset_ids,
        read_ids=_parse_read_ids(read_ids),
        read_ids_by_dataset=_parse_read_ids_by_dataset(read_ids_by_dataset),
        sample_seed=sample_seed,
        include_methylation=False,
        include_layers=layer is not None,
        requested_layers=requested_layers,
    )
    from services.lift.capability import require_for_ids
    require_for_ids(state, query.dataset_ids, "coaccessibility")
    width = max(0, int(query.region_width))
    if bin_size > 0:
        actual_bin_size = int(bin_size)
        if width // actual_bin_size > MAX_COACC_BINS:
            # Matrices are bins x bins (several at once): a 1 bp bin over 1 Mb
            # would need terabytes. Refuse instead of allocating.
            raise HTTPException(
                status_code=413,
                detail=(f"{width // actual_bin_size:,} bins is more than the {MAX_COACC_BINS:,} co-accessibility "
                        f"allows; use a bin size of at least {-(-width // MAX_COACC_BINS):,} bp or a smaller region"),
            )
    else:
        # The automatic size targets ~150 bins; on a very wide region it is
        # raised so the matrix stays within the budget.
        actual_bin_size = max(_pick_bin_size(width), -(-width // MAX_COACC_BINS) if width else 1)
    return CoaccRequestScope(query=query, bin_size=actual_bin_size)


def _rounded_matrix_list(matrix: np.ndarray) -> list[list[float | None]]:
    return [[None if np.isnan(value) else round(float(value), 6) for value in row] for row in matrix]


def _marginal_accessibility(raw: np.ndarray, accessibility: Optional[np.ndarray] = None) -> list[float | None]:
    """Each bin's mean accessibility E[a_i] over the reads covering it.

    raw's diagonal is E[a_i^2], the same only for 0/1 signal (a bin 50%
    accessible in every read would read 0.25). Bins raw masks for low coverage
    stay masked.
    """
    diag = np.diag(raw).astype(np.float64)
    if accessibility is not None and accessibility.ndim == 2 and accessibility.shape[1] == diag.shape[0]:
        covered = ~np.isnan(accessibility)
        counts = covered.sum(axis=0)
        sums = np.where(covered, accessibility, 0.0).sum(axis=0)
        with np.errstate(divide="ignore", invalid="ignore"):
            marginal = np.where(counts > 0, sums / np.maximum(counts, 1), np.nan)
        marginal[np.isnan(diag)] = np.nan
    else:
        marginal = diag
    return [None if np.isnan(value) else round(float(value), 4) for value in marginal]


def get_coacc_metadata_payload(
    state,
    scope: CoaccRequestScope,
    normalization: str,
    min_coverage: int,
    *,
    signal_type: str = "accessibility",
    layer: Optional[str] = None,
) -> dict:
    if scope.region_width <= 0:
        return {"n_bins": 0, "bin_size": 0, "n_reads": 0}

    _, accessibility, n_reads, raw, coverage = _get_cached_normalized_matrix(
        state,
        scope,
        normalization,
        min_coverage,
        signal_type=signal_type,
        layer=layer,
    )
    n_bins = raw.shape[0]
    valid_coverage = coverage[~np.isnan(raw)]
    masked = np.isnan(raw)
    total_cells = raw.size
    masked_count = int(masked.sum())

    return {
        "n_bins": int(n_bins),
        "bin_size": int(scope.bin_size),
        "n_reads": int(n_reads),
        "coverage_median": int(np.median(valid_coverage)) if len(valid_coverage) > 0 else 0,
        "coverage_min": int(np.min(valid_coverage)) if len(valid_coverage) > 0 else 0,
        "coverage_max": int(np.max(valid_coverage)) if len(valid_coverage) > 0 else 0,
        "masked_fraction": round(float(masked_count / total_cells), 4) if total_cells > 0 else 0,
        "marginal_accessibility": _marginal_accessibility(raw, accessibility),
        "normalization": normalization,
        "sample_seed": scope.sample_seed,
    }


def get_coacc_matrix_data_payload(
    state,
    scope: CoaccRequestScope,
    normalization: str,
    min_coverage: int,
    *,
    signal_type: str = "accessibility",
    layer: Optional[str] = None,
) -> dict:
    if scope.region_width <= 0:
        return {"matrix": [], "coverage": [], "n_bins": 0, "n_reads": 0}

    matrix, accessibility, n_reads, raw, coverage = _get_cached_normalized_matrix(
        state,
        scope,
        normalization,
        min_coverage,
        signal_type=signal_type,
        layer=layer,
    )
    n_bins = matrix.shape[0]
    return {
        "matrix": _rounded_matrix_list(matrix),
        "coverage": _rounded_matrix_list(coverage),
        "chrom": scope.chrom,
        "start": scope.start,
        "end": scope.end,
        "bin_size": int(scope.bin_size),
        "n_bins": int(n_bins),
        "n_reads": int(n_reads),
        "normalization": normalization,
        "marginal_accessibility": _marginal_accessibility(raw, accessibility),
        "sample_seed": scope.sample_seed,
    }


def get_coacc_slice_payload(
    state,
    scope: CoaccRequestScope,
    position: int,
    normalization: str,
    min_coverage: int,
    *,
    signal_type: str = "accessibility",
    layer: Optional[str] = None,
) -> dict:
    empty = {
        "profile": [],
        "coverage": [],
        "bin_size": 0,
        "n_bins": 0,
        "viewpoint_bin": 0,
        "viewpoint_start": 0,
        "viewpoint_end": 0,
    }
    if scope.region_width <= 0 or position < scope.start or position >= scope.end:
        return empty

    matrix, _, n_reads, _, coverage = _get_cached_normalized_matrix(
        state,
        scope,
        normalization,
        min_coverage,
        signal_type=signal_type,
        layer=layer,
    )
    n_bins = matrix.shape[0]
    if n_bins == 0 or coverage.shape[0] == 0:
        return empty  # a region narrower than one bin
    bin_idx = min((position - scope.start) // scope.bin_size, n_bins - 1)
    profile_row = matrix[bin_idx, :]
    coverage_row = coverage[bin_idx, :]

    return {
        "profile": [None if np.isnan(value) else round(float(value), 6) for value in profile_row],
        "coverage": [int(value) for value in coverage_row],
        "bin_size": int(scope.bin_size),
        "n_bins": int(n_bins),
        "n_reads": int(n_reads),
        "viewpoint_bin": int(bin_idx),
        "viewpoint_start": int(scope.start + bin_idx * scope.bin_size),
        "viewpoint_end": int(scope.start + (bin_idx + 1) * scope.bin_size),
        "sample_seed": scope.sample_seed,
    }


def get_coacc_arcs_payload(
    state,
    scope: CoaccRequestScope,
    normalization: str,
    min_coverage: int,
    *,
    threshold: float = 1.5,
    max_arcs: int = 200,
    min_distance: int = 2,
    signal_type: str = "accessibility",
    layer: Optional[str] = None,
) -> dict:
    if scope.region_width <= 0:
        return {"arcs": [], "bin_size": 0, "n_arcs": 0}

    matrix, _, _, _, coverage = _get_cached_normalized_matrix(
        state,
        scope,
        normalization,
        min_coverage,
        signal_type=signal_type,
        layer=layer,
    )
    n_bins = matrix.shape[0]

    arcs = []
    for i in range(n_bins):
        for j in range(i + min_distance, n_bins):
            value = matrix[i, j]
            if np.isnan(value) or value < threshold:
                continue
            cov = int(coverage[i, j])
            mid_i = scope.start + i * scope.bin_size + scope.bin_size // 2
            mid_j = scope.start + j * scope.bin_size + scope.bin_size // 2
            arcs.append({
                "start": mid_i,
                "end": mid_j,
                "strength": round(float(value), 4),
                "coverage": cov,
            })

    arcs.sort(key=lambda arc: arc["strength"], reverse=True)
    arcs = arcs[:max_arcs]
    return {
        "arcs": arcs,
        "bin_size": int(scope.bin_size),
        "n_arcs": len(arcs),
        "sample_seed": scope.sample_seed,
    }


def get_coacc_matrix_image_bytes(
    state,
    scope: CoaccRequestScope,
    normalization: str,
    min_coverage: int,
    *,
    render_contact_matrix_image,
    scaling: str = "linear",
    colormap: str = "fall",
    vmin: Optional[float] = None,
    vmax: Optional[float] = None,
    signal_type: str = "accessibility",
    layer: Optional[str] = None,
) -> bytes:
    if scope.region_width <= 0:
        return b""

    matrix, _, _, _, _ = _get_cached_normalized_matrix(
        state,
        scope,
        normalization,
        min_coverage,
        signal_type=signal_type,
        layer=layer,
    )
    img = render_contact_matrix_image(
        matrix,
        scaling=scaling,
        colormap=colormap,
        vmin=vmin,
        vmax=vmax,
    )
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return buf.read()


def get_coacc_strip_image_bytes(
    state,
    scope: CoaccRequestScope,
    normalization: str,
    min_coverage: int,
    *,
    apply_colormap,
    width: int = 800,
    height: int = 120,
    scaling: str = "linear",
    colormap: str = "fall",
    signal_type: str = "accessibility",
    layer: Optional[str] = None,
) -> bytes:
    from PIL import Image

    def empty_png() -> bytes:
        img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        buf.seek(0)
        return buf.read()

    if scope.region_width <= 0:
        return b""

    matrix, _, _, _, _ = _get_cached_normalized_matrix(
        state,
        scope,
        normalization,
        min_coverage,
        signal_type=signal_type,
        layer=layer,
    )
    n_bins = matrix.shape[0]
    if n_bins < 2:
        return empty_png()

    # Accumulate from zero (NaN + x stays NaN); empty pixels become NaN below.
    strip = np.zeros((height, width), dtype=np.float32)
    counts = np.zeros((height, width), dtype=np.int32)

    rows_idx, cols_idx = np.triu_indices(n_bins, k=1)
    distances = cols_idx - rows_idx
    midpoints_frac = (rows_idx + cols_idx) / 2.0

    px_coords = (midpoints_frac * width / n_bins).astype(int)
    max_dist = n_bins - 1
    py_coords = height - 1 - ((distances - 1) * (height - 1) / max(max_dist - 1, 1)).astype(int)

    valid = (px_coords >= 0) & (px_coords < width) & (py_coords >= 0) & (py_coords < height)
    rows_v = rows_idx[valid]
    cols_v = cols_idx[valid]
    px_v = px_coords[valid]
    py_v = py_coords[valid]

    values = matrix[rows_v, cols_v]
    valid_vals = ~np.isnan(values)
    np.add.at(strip, (py_v[valid_vals], px_v[valid_vals]), values[valid_vals])
    np.add.at(counts, (py_v[valid_vals], px_v[valid_vals]), 1)

    mask = counts > 0
    strip[mask] /= counts[mask]
    strip[~mask] = np.nan

    valid_values = strip[~np.isnan(strip)]
    if len(valid_values) == 0:
        return empty_png()

    plot = strip.copy()
    if scaling == "log":
        plot = np.where(np.isnan(plot), np.nan, np.log1p(np.maximum(plot, 0)))
    elif scaling == "sqrt":
        plot = np.where(np.isnan(plot), np.nan, np.sqrt(np.maximum(plot, 0)))

    valid_plot = plot[~np.isnan(plot)]
    lo, hi = float(np.min(valid_plot)), float(np.max(valid_plot))
    if hi <= lo:
        hi = lo + 1.0
    normalized = np.clip((plot - lo) / (hi - lo), 0.0, 1.0)
    normalized[np.isnan(plot)] = 0.0

    rgb = apply_colormap(normalized, colormap)
    rgba = np.zeros((height, width, 4), dtype=np.uint8)
    rgba[:, :, :3] = rgb
    rgba[:, :, 3] = np.where(np.isnan(strip), 0, 255).astype(np.uint8)

    img = Image.fromarray(rgba, "RGBA")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return buf.read()
