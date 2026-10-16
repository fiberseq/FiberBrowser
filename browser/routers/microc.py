"""Micro-C / Hi-C visualization endpoints."""
from __future__ import annotations

import asyncio
import io
import time
from importlib.util import find_spec
from typing import Optional

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from PIL import Image

from models.requests import APAPeaks
from services.contact_rendering import render_matrix_strip_image
from services.dafc_diagnostics import log_dafc_diagnostic
from services.microc_arcs import (
    build_interaction_arcs,
    merge_interaction_arcs,
    score_interaction_arcs,
)
from services.microc_apa import compute_apa_from_matrix
from services.microc_matrix import (
    apply_distance_expected,
    cooler_has_balance_weights,
    MAX_MATRIX_CELLS,
    MatrixTooLarge,
    fetch_cooler_matrix,
    local_expected_per_distance,
    resolve_cooler_chrom,
    cooler_at_resolution,
)
from services.microc_metrics import compute_bin_accessibility, compute_chrom_expected

# A local expected (when the chromosome's isn't available) is computed over at
# most this many bins of the viewpoint-plus-profile span.
VIRTUAL4C_LOCAL_EXPECTED_MAX_BINS = 5000
from state.dependencies import get_dafc_state, get_state

HAS_COOLER = find_spec("cooler") is not None
_cooler_module = None


def _load_cooler_module():
    global HAS_COOLER, _cooler_module
    if _cooler_module is not None:
        return _cooler_module
    try:
        import cooler as cooler_module
    except ImportError:
        HAS_COOLER = False
        return None
    _cooler_module = cooler_module
    HAS_COOLER = True
    return _cooler_module

router = APIRouter(tags=["microc"])


def _resolve_cooler_chrom(dafc_state, chrom: str) -> Optional[str]:
    """Resolve a chromosome name against the cooler's chromsizes."""
    return resolve_cooler_chrom(dafc_state, chrom)


@router.get("/api/microc/matrix/data")
async def get_microc_matrix_data(
    chrom: str = Query(...),
    start: int = Query(...),
    end: int = Query(...),
    resolution: Optional[int] = Query(None),
    normalization: str = Query('none', description="Normalization: 'none', 'oe' (local), or 'oe_global'"),
    dafc_state=Depends(get_dafc_state),
):
    """Get raw contact matrix data with optional O/E normalization."""
    cooler_module = _load_cooler_module()
    if cooler_module is None or dafc_state.clr is None:
        raise HTTPException(status_code=400, detail="No cooler file loaded")

    actual_chrom = _resolve_cooler_chrom(dafc_state, chrom)
    if actual_chrom is None:
        raise HTTPException(status_code=404, detail=f"Chromosome not found: {chrom}")
    chrom = actual_chrom

    try:
        dafc_state, res = cooler_at_resolution(dafc_state, resolution, cooler_module)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to switch resolution: {e}")

    clr = dafc_state.clr

    try:
        region = f"{chrom}:{start}-{end}"
        matrix = fetch_cooler_matrix(clr, region, balance=False, dtype=float)
    except MatrixTooLarge as e:
        raise HTTPException(status_code=413, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch matrix: {e}")

    n = matrix.shape[0]

    if normalization in ('oe', 'oe_global'):
        expected_per_dist = None

        if normalization == 'oe_global':
            cache_key = (chrom, res, False)  # raw counts, as compute_chrom_expected caches them
            if cache_key in dafc_state.chrom_expected_cache:
                expected_per_dist = dafc_state.chrom_expected_cache[cache_key]
            else:
                expected_per_dist = compute_chrom_expected(chrom, res, allow_compute=True, dafc_state=dafc_state)

        if expected_per_dist is None:
            expected_per_dist = local_expected_per_distance(
                matrix,
                max_dist=n,
                use_nanmean=False,
                positive_only=True,
            )

        matrix = apply_distance_expected(matrix, expected_per_dist, invalid_fill="zero")

    return {
        "matrix": matrix.tolist(),
        "chrom": chrom,
        "start": start,
        "end": end,
        "resolution": res,
        "n_bins": n,
        "normalization": normalization,
    }


@router.get("/api/microc/matrix/strip")
async def get_matrix_strip(
    chrom: str = Query(...),
    start: int = Query(...),
    end: int = Query(...),
    max_distance: int = Query(100000, description="Max interaction distance to show"),
    resolution: Optional[int] = Query(None),
    width: int = Query(800, description="Output image width"),
    height: int = Query(150, description="Output image height"),
    scaling: str = Query('log', description="Value scaling: linear, log, sqrt"),
    colormap: str = Query('fall', description="Colormap: red, fall, hot, viridis, blues"),
    normalization: str = Query('none', description="Matrix normalization: none, balanced, oe"),
    focus_start: Optional[int] = Query(None, description="Focus region start"),
    focus_end: Optional[int] = Query(None, description="Focus region end"),
    dafc_state=Depends(get_dafc_state),
):
    """Return a triangular matrix strip for the viewport region as a PNG image."""
    cooler_module = _load_cooler_module()
    if cooler_module is None or dafc_state.clr is None:
        raise HTTPException(status_code=400, detail="No cooler loaded")

    actual_chrom = _resolve_cooler_chrom(dafc_state, chrom)
    if actual_chrom is None:
        raise HTTPException(status_code=404, detail=f"Chromosome not found: {chrom}")
    chrom = actual_chrom

    try:
        dafc_state, res = cooler_at_resolution(dafc_state, resolution, cooler_module)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to switch resolution: {e}")

    clr = dafc_state.clr

    start_bin = start // res
    end_bin = (end + res - 1) // res
    n_bins = end_bin - start_bin
    # A contact inside the region is at most n_bins apart: a larger
    # max_distance only adds empty rows (and memory).
    max_dist_bins = max(1, min(max_distance // res, max(n_bins, 1)))
    # Check the size before allocating anything (the fetch itself is checked too).
    if n_bins > 0 and n_bins * n_bins > MAX_MATRIX_CELLS:
        raise HTTPException(
            status_code=413,
            detail=(f"Region spans {n_bins:,} bins at {res:,} bp; zoom in or use a coarser resolution"),
        )

    if n_bins <= 0:
        img = Image.new('RGB', (width, height), (255, 255, 255))
        buf = io.BytesIO()
        img.save(buf, format='PNG')
        buf.seek(0)
        return Response(content=buf.read(), media_type="image/png")

    strip = np.zeros((max_dist_bins, n_bins), dtype=np.float32)

    has_focus = focus_start is not None and focus_end is not None
    if has_focus:
        focus_start_bin = max(0, (focus_start - start) // res)
        focus_end_bin = min(n_bins, (focus_end - start + res - 1) // res)
    else:
        focus_start_bin = 0
        focus_end_bin = n_bins

    try:
        region = f"{chrom}:{start}-{end}"

        use_balance = normalization == 'balanced'
        if use_balance and not cooler_has_balance_weights(clr, log_dafc_diagnostic):
            use_balance = False
            log_dafc_diagnostic("[MICROC] No balance weights available, falling back to raw")

        matrix = await asyncio.to_thread(fetch_cooler_matrix, clr, region, balance=use_balance)

        expected_per_dist = None
        if normalization == 'oe_global':
            expected_per_dist = compute_chrom_expected(chrom, res, dafc_state=dafc_state)
            if expected_per_dist is None:
                log_dafc_diagnostic(f"[MICROC] Global O/E not available for {chrom}, falling back to local")
                normalization = 'oe'

        if normalization == 'oe':
            try:
                expected_per_dist = local_expected_per_distance(
                    matrix,
                    max_dist=max_dist_bins + 1,
                )
            except Exception as e:
                log_dafc_diagnostic(f"[MICROC] Error computing O/E expected: {e}")
                expected_per_dist = None

        matrix = np.nan_to_num(matrix, nan=0.0, posinf=0.0, neginf=0.0)

        mat_size = matrix.shape[0]
        rows_idx, cols_idx = np.triu_indices(mat_size, k=1)
        dist_mask = (cols_idx - rows_idx) < max_dist_bins
        rows_idx = rows_idx[dist_mask]
        cols_idx = cols_idx[dist_mask]

        distances = cols_idx - rows_idx
        midpoints = ((rows_idx + cols_idx) / 2.0 * n_bins / mat_size).astype(int)

        valid = (midpoints >= 0) & (midpoints < n_bins) & (distances < max_dist_bins)
        if has_focus:
            valid &= (rows_idx >= focus_start_bin) & (cols_idx < focus_end_bin)

        rows_idx = rows_idx[valid]
        cols_idx = cols_idx[valid]
        distances = distances[valid]
        midpoints = midpoints[valid]

        values = matrix[rows_idx, cols_idx]

        if expected_per_dist is not None:
            exp_vals = expected_per_dist[np.minimum(distances, len(expected_per_dist) - 1)]
            values = values / exp_vals

        np.add.at(strip, (distances, midpoints), values)
    except Exception as e:
        log_dafc_diagnostic(f"[MICROC] Error fetching matrix: {e}")

    img = await asyncio.to_thread(
        render_matrix_strip_image,
        strip,
        width=width,
        height=height,
        scaling=scaling,
        colormap=colormap,
    )

    buf = io.BytesIO()
    img.save(buf, format='PNG')
    buf.seek(0)

    return Response(content=buf.read(), media_type="image/png")


@router.post("/api/microc/precompute_expected")
async def precompute_chrom_expected(
    chrom: str = Query(...),
    resolution: Optional[int] = Query(None),
    dafc_state=Depends(get_dafc_state),
):
    """Precompute and cache chromosome-wide expected values for global O/E."""
    if _load_cooler_module() is None or dafc_state.clr is None:
        return {"success": False, "cached": False, "reason": "No cooler loaded"}

    actual_chrom = _resolve_cooler_chrom(dafc_state, chrom)
    if actual_chrom is None:
        return {"success": False, "cached": False, "reason": f"Chromosome not found: {chrom}"}
    chrom = actual_chrom

    # A resolution the file lacks is served at the loaded one (cooler_at_resolution).
    res = resolution if resolution in (dafc_state.resolutions or ()) else dafc_state.current_resolution
    cache_key = (chrom, res, False)  # raw counts, as compute_chrom_expected caches them

    if cache_key in dafc_state.chrom_expected_cache:
        return {"success": True, "cached": True, "chrom": chrom, "resolution": res}

    if cache_key in dafc_state.chrom_expected_computing:
        return {"success": True, "cached": False, "computing": True, "chrom": chrom, "resolution": res}

    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, lambda: compute_chrom_expected(chrom, res, allow_compute=True, dafc_state=dafc_state))

    return {"success": True, "cached": False, "computing": True, "chrom": chrom, "resolution": res}


@router.get("/api/microc/expected_status")
async def get_expected_cache_status(
    chrom: Optional[str] = Query(None, description="Check status for specific chromosome"),
    resolution: Optional[int] = Query(None, description="Check status for specific resolution"),
    dafc_state=Depends(get_dafc_state),
):
    """Get status of chromosome expected value cache."""
    res = resolution if resolution in (dafc_state.resolutions or ()) else dafc_state.current_resolution

    if chrom:
        cache_key = (chrom, res, False)  # raw counts, as compute_chrom_expected caches them
        is_cached = cache_key in dafc_state.chrom_expected_cache
        is_computing = cache_key in dafc_state.chrom_expected_computing
        return {
            "chrom": chrom,
            "resolution": res,
            "ready": is_cached,
            "computing": is_computing,
            "status": "ready" if is_cached else ("computing" if is_computing else "not_started"),
        }

    cached = list(dafc_state.chrom_expected_cache.keys())
    computing = list(dafc_state.chrom_expected_computing)
    return {
        "cached": [{"chrom": key[0], "resolution": key[1]} for key in cached],
        "computing": [{"chrom": key[0], "resolution": key[1]} for key in computing],
        "n_cached": len(cached),
        "n_computing": len(computing),
    }


@router.get("/api/microc/arcs")
async def get_interaction_arcs(
    chrom: str = Query(...),
    start: int = Query(...),
    end: int = Query(...),
    min_distance: int = Query(5000, description="Min distance to show arcs"),
    max_distance: int = Query(500000, description="Max distance to show arcs"),
    threshold: float = Query(0.1, description="Min normalized strength to show (0-1)"),
    max_arcs: int = Query(100, description="Max arcs to return"),
    resolution: Optional[int] = Query(None),
    normalization: str = Query('none', description="Normalization: 'none' (raw), 'oe' (local O/E), or 'oe_global' (chromosome-wide O/E)"),
    min_count: int = Query(0, description="Minimum raw count to include (0 = use strength threshold)"),
    merge_bin: int = Query(0, description="Cluster arcs within this distance (0 = no clustering)"),
    stable_strength: bool = Query(False, description="Return stable O/E ratios instead of viewport-normalized 0-1 strength"),
    oe_floor: float = Query(0, description="Minimum O/E ratio to display (0 = show all, only for O/E modes)"),
    acc_correct: bool = Query(False, description="Apply accessibility correction from fiber-seq data"),
    acc_log: bool = Query(False, description="Use log-space accessibility correction (experimental)"),
    state=Depends(get_state),
    dafc_state=Depends(get_dafc_state),
):
    """Return significant contact arcs within viewport."""
    cooler_module = _load_cooler_module()
    if cooler_module is None or dafc_state.clr is None:
        return {"arcs": [], "max_distance": max_distance, "normalization": normalization}

    actual_chrom = _resolve_cooler_chrom(dafc_state, chrom)
    if actual_chrom is None:
        return {"arcs": [], "max_distance": max_distance, "normalization": normalization}
    chrom = actual_chrom

    try:
        dafc_state, res = cooler_at_resolution(dafc_state, resolution, cooler_module)
    except Exception as e:
        log_dafc_diagnostic(f"[MICROC] Error switching resolution for arcs: {e}")
        return {"arcs": [], "max_distance": max_distance, "normalization": normalization, "error": str(e)}

    clr = dafc_state.clr

    try:
        region = f"{chrom}:{start}-{end}"
        matrix = fetch_cooler_matrix(clr, region, balance=False)
    except Exception as e:
        log_dafc_diagnostic(f"[MICROC] Error fetching matrix for arcs: {e}")
        return {"arcs": [], "max_distance": max_distance, "normalization": normalization, "error": str(e)}

    min_dist_bins = max(1, min_distance // res)
    max_dist_bins = max_distance // res
    # Cooler returns whole bins: the matrix starts at the bin holding ``start``,
    # so arc positions and accessibility bins use that origin too.
    bin_origin = (start // res) * res
    bin_end = bin_origin + matrix.shape[0] * res

    expected_per_dist = None
    if normalization in ('oe', 'oe_global'):
        if normalization == 'oe_global':
            cache_key = (chrom, res, False)  # raw counts, as compute_chrom_expected caches them
            if cache_key in dafc_state.chrom_expected_cache:
                expected_per_dist = dafc_state.chrom_expected_cache[cache_key]
            else:
                expected_per_dist = compute_chrom_expected(chrom, res, dafc_state=dafc_state)

            if expected_per_dist is None:
                log_dafc_diagnostic("[MICROC] Global O/E unavailable, falling back to local")
                normalization = 'oe'

        if expected_per_dist is None:
            expected_per_dist = local_expected_per_distance(
                matrix,
                max_dist=max_dist_bins + 1,
                start_dist=min_dist_bins,
                use_nanmean=False,
                positive_only=True,
            )

    bin_accessibility = None
    mean_accessibility = None
    if acc_correct and normalization in ('oe', 'oe_global'):
        try:
            bin_accessibility = compute_bin_accessibility(chrom, bin_origin, bin_end, res, state=state)
            mean_accessibility = bin_accessibility.mean()
            log_dafc_diagnostic(
                f"[MICROC] Accessibility correction enabled: {len(bin_accessibility)} bins, "
                f"mean={mean_accessibility:.3f}, min={bin_accessibility.min():.3f}, "
                f"max={bin_accessibility.max():.3f}"
            )
        except Exception as e:
            log_dafc_diagnostic(f"[MICROC] Failed to compute accessibility, skipping correction: {e}")
            bin_accessibility = None

    arcs = build_interaction_arcs(
        matrix,
        start=bin_origin,
        resolution=res,
        min_dist_bins=min_dist_bins,
        max_dist_bins=max_dist_bins,
        expected_per_dist=expected_per_dist,
        bin_accessibility=bin_accessibility,
        mean_accessibility=mean_accessibility,
        acc_log=acc_log,
    )
    arcs = merge_interaction_arcs(arcs, merge_bin)
    arcs = score_interaction_arcs(
        arcs,
        normalization=normalization,
        oe_floor=oe_floor,
        min_count=min_count,
        stable_strength=stable_strength,
        threshold=threshold,
        max_arcs=max_arcs,
    )

    return {
        "arcs": arcs,
        "max_distance": max_distance,
        "normalization": normalization,
        "merged": merge_bin > 0,
        "stable": stable_strength,
    }


@router.get("/api/microc/virtual4c")
async def get_virtual_4c(
    chrom: str = Query(...),
    viewpoint_start: int = Query(...),
    viewpoint_end: int = Query(...),
    profile_start: int = Query(...),
    profile_end: int = Query(...),
    resolution: Optional[int] = Query(None),
    normalization: str = Query('none', description="Normalization: 'none' (raw) or 'oe' (observed/expected)"),
    dafc_state=Depends(get_dafc_state),
):
    """Return a 1D contact profile from a viewpoint region."""
    cooler_module = _load_cooler_module()
    if cooler_module is None or dafc_state.clr is None:
        return {"profile": [], "resolution": 0, "viewpoint": {}, "normalization": normalization}

    actual_chrom = _resolve_cooler_chrom(dafc_state, chrom)
    if actual_chrom is None:
        return {"profile": [], "resolution": 0, "viewpoint": {}, "normalization": normalization}
    chrom = actual_chrom

    try:
        dafc_state, res = cooler_at_resolution(dafc_state, resolution, cooler_module)
    except Exception as e:
        log_dafc_diagnostic(f"[VIRTUAL4C] Error switching resolution: {e}")
        return {"profile": [], "resolution": 0, "viewpoint": {}, "normalization": normalization, "error": str(e)}

    clr = dafc_state.clr
    fetch_error = None
    applied_normalization = normalization
    normalization_warning = None

    try:
        viewpoint = f"{chrom}:{viewpoint_start}-{viewpoint_end}"
        profile_region = f"{chrom}:{profile_start}-{profile_end}"

        matrix = fetch_cooler_matrix(clr, viewpoint, profile_region, balance=False)
        profile = matrix.sum(axis=0)

        if normalization == 'oe':
            try:
                # The expected must cover every viewpoint-to-profile distance:
                # the chromosome's own (cached, else computed off the event
                # loop), else a local one over the span holding both.
                cache_key = (chrom, res, False)  # raw counts, as compute_chrom_expected caches them
                expected_per_dist = dafc_state.chrom_expected_cache.get(cache_key)
                if expected_per_dist is None:
                    loop = asyncio.get_running_loop()
                    expected_per_dist = await loop.run_in_executor(
                        None, lambda: compute_chrom_expected(chrom, res, allow_compute=True, dafc_state=dafc_state))
                if expected_per_dist is None:
                    span_start = min(viewpoint_start, profile_start)
                    span_end = max(viewpoint_end, profile_end)
                    if (span_end - span_start) // max(res, 1) <= VIRTUAL4C_LOCAL_EXPECTED_MAX_BINS:
                        full_matrix = fetch_cooler_matrix(clr, f"{chrom}:{span_start}-{span_end}", balance=False)
                        expected_per_dist = local_expected_per_distance(
                            full_matrix,
                            max_dist=full_matrix.shape[0],
                            use_nanmean=False,
                            positive_only=True,
                        )
                if expected_per_dist is None:
                    raise ValueError('expected contacts are not available for these distances')

                # Observed is summed over the viewpoint's bins, so the expected
                # is too: per viewpoint bin, at its own distance to each profile
                # bin (on the cooler's bin grid).
                oe_profile = virtual4c_oe(
                    matrix, expected_per_dist,
                    viewpoint_first_bin=viewpoint_start // res,
                    profile_first_bin=profile_start // res,
                )

                profile = oe_profile.tolist()
            except Exception as e:
                log_dafc_diagnostic(f"[VIRTUAL4C] O/E computation failed: {e}, falling back to raw")
                profile = profile.tolist() if hasattr(profile, 'tolist') else list(profile)
                applied_normalization = 'none'
                normalization_warning = 'Expected contacts are not available for this viewpoint; the profile shows raw counts.'
        else:
            profile = profile.tolist() if hasattr(profile, 'tolist') else list(profile)

    except Exception as e:
        log_dafc_diagnostic(f"[VIRTUAL4C] Error fetching matrix: {e}")
        fetch_error = str(e)
        profile = []

    result = {
        "profile": profile,
        "resolution": res,
        "viewpoint": {"start": viewpoint_start, "end": viewpoint_end},
        "normalization": applied_normalization,
    }
    if normalization_warning:
        result["warning"] = normalization_warning
    if fetch_error:
        result["error"] = fetch_error
    return result


def virtual4c_oe(matrix, expected_per_dist, *, viewpoint_first_bin: int, profile_first_bin: int) -> np.ndarray:
    """O/E of a virtual-4C profile: summed observed contacts / summed expected
    contacts, over the viewpoint's bins (rows) for each profile bin (column)."""
    matrix = np.asarray(matrix, dtype=np.float64)
    expected = np.asarray(expected_per_dist, dtype=np.float64)
    rows, cols = matrix.shape
    dist = np.abs((viewpoint_first_bin + np.arange(rows))[:, None] - (profile_first_bin + np.arange(cols))[None, :])
    # A distance the expected doesn't cover has no expected value (never the
    # trailing floor entry): its profile bin gets no O/E.
    covered = dist < len(expected)
    exp = np.where(covered, expected[np.clip(dist, 0, max(len(expected) - 1, 0))], 0.0)
    observed = np.nansum(matrix, axis=0)
    total_expected = exp.sum(axis=0)
    complete = covered.all(axis=0)
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(complete & (total_expected > 0), observed / total_expected, 0.0)


@router.post("/api/microc/apa")
async def compute_apa(
    request: APAPeaks,
    chrom: str = Query(...),
    window: int = Query(10000, description="Window size around each peak pair (bp)"),
    resolution: Optional[int] = Query(None),
    normalization: str = Query('oe', description="Normalization: 'none' (raw) or 'oe' (observed/expected)"),
    dafc_state=Depends(get_dafc_state),
):
    """Compute Aggregate Peak Analysis (APA) for selected peaks."""
    start_time = time.time()

    cooler_module = _load_cooler_module()
    if cooler_module is None or dafc_state.clr is None:
        return {"matrix": [], "apa_score": 0, "n_pairs": 0, "window": window, "resolution": 0}

    actual_chrom = _resolve_cooler_chrom(dafc_state, chrom)
    if actual_chrom is None:
        return {"matrix": [], "apa_score": 0, "n_pairs": 0, "window": window, "resolution": 0}
    chrom = actual_chrom

    peaks = request.peaks
    if len(peaks) < 2:
        return {
            "matrix": [],
            "apa_score": 0,
            "n_pairs": 0,
            "window": window,
            "resolution": 0,
            "error": "Need at least 2 peaks",
        }

    try:
        dafc_state, res = cooler_at_resolution(dafc_state, resolution, cooler_module)
    except Exception as e:
        log_dafc_diagnostic(f"[APA] Error switching resolution: {e}")
        requested_res = resolution or dafc_state.current_resolution
        return {"matrix": [], "apa_score": 0, "n_pairs": 0, "window": window, "resolution": requested_res, "error": str(e)}

    clr = dafc_state.clr

    try:
        chrom_extent = clr.extent(chrom)
        chrom_nbins = chrom_extent[1] - chrom_extent[0]
    except KeyError:
        return {
            "matrix": [],
            "apa_score": 0,
            "n_pairs": 0,
            "window": window,
            "resolution": res,
            "error": f"Chromosome {chrom} not found",
        }

    # Each peak pair's window is read on its own: densifying the chromosome
    # (250 Mb at 1 kb ~ 500 GB) is never needed.
    from services.microc_apa import CoolerWindows
    try:
        chrom_length = int(clr.chromsizes[chrom])
    except Exception:
        chrom_length = None
    full_matrix = CoolerWindows(clr, chrom, res, chrom_nbins, balance=False, chrom_length=chrom_length)

    expected_per_dist = None
    applied_normalization = normalization
    normalization_warning = None
    if normalization == 'oe':
        cache_key = (chrom, res, False)  # raw counts, as compute_chrom_expected caches them
        if cache_key in dafc_state.chrom_expected_cache:
            expected_per_dist = dafc_state.chrom_expected_cache[cache_key]
        else:
            # A cold cache is computed here (off the event loop), as the matrix
            # O/E endpoints do; without it the result would be raw counts.
            loop = asyncio.get_running_loop()
            expected_per_dist = await loop.run_in_executor(
                None, lambda: compute_chrom_expected(chrom, res, allow_compute=True, dafc_state=dafc_state))
        if expected_per_dist is None:
            # Still unavailable (being computed by another request, or the map
            # changed): say so rather than label raw counts O/E.
            applied_normalization = 'none'
            normalization_warning = 'Expected contacts are not available yet; APA shows raw counts. Try again shortly for O/E.'

    try:
        apa = compute_apa_from_matrix(
            full_matrix,
            peaks,
            resolution=res,
            window=window,
            chrom_nbins=chrom_nbins,
            expected_per_dist=expected_per_dist,
        )
    except Exception as e:
        return {"matrix": [], "apa_score": 0, "n_pairs": 0, "window": window, "resolution": res, "error": f"Failed to fetch matrix: {e}"}
    elapsed = time.time() - start_time

    beyond = int(apa.get("pairs_beyond_expected") or 0)
    if beyond:
        # Expected contacts stop at a maximum distance; farther pairs can't be O/E.
        note = f'{beyond} peak pair(s) farther apart than the expected curve covers were left out.'
        normalization_warning = f'{normalization_warning} {note}' if normalization_warning else note
    if apa["n_pairs"] == 0:
        return {"matrix": [], "apa_score": 0, "n_pairs": 0, "window": window, "resolution": res,
                "error": "No valid peak pairs found", "pairs_beyond_expected": beyond,
                **({"warning": normalization_warning} if normalization_warning else {})}

    log_dafc_diagnostic(f"[APA] Computed {apa['n_pairs']} pairs in {elapsed:.2f}s")

    return {
        "matrix": apa["matrix"].tolist(),
        "apa_score": apa["apa_score"],
        "center_value": apa["center_value"],
        "corner_mean": apa["corner_mean"],
        "n_pairs": apa["n_pairs"],
        "window": window,
        "resolution": res,
        "matrix_size": apa["matrix_size"],
        "normalization": applied_normalization,
        "pairs_beyond_expected": beyond,
        **({"warning": normalization_warning} if normalization_warning else {}),
        "elapsed_ms": int(elapsed * 1000),
    }
