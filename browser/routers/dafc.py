"""DAF-C / Contact Map endpoints.

Extracted from server.py. Contains DAF-C helpers plus /api/dafc/* endpoints.
"""
from __future__ import annotations

import io
import os
import asyncio
import numpy as np
from importlib.util import find_spec
from typing import Optional
from fastapi import APIRouter, Query, Depends, Response

from state.dependencies import get_state, get_dafc_state
from models.domain import ChromInfo, ContactSelection
from utils.validation import is_s3_url, validate_s3_url
from services.dafc_reads import (
    detect_contact_mode,
    find_ligated_reads,
    query_reads_for_dafc,
)
from services.contact_rendering import (
    render_contact_matrix_image,
)
from services.dafc_diagnostics import log_dafc_diagnostic
from services.local_paths import normalize_local_path, path_access_error
from services.microc_matrix import (
    apply_distance_expected,
    cooler_has_balance_weights,
    MatrixTooLarge,
    fetch_cooler_matrix,
    local_expected_per_distance,
    resolve_cooler_chrom,
    cooler_at_resolution,
)
from services.microc_metrics import compute_chrom_expected

HAS_COOLER = find_spec("cooler") is not None and find_spec("h5py") is not None
_cooler_module = None
_h5py_module = None


def _load_cooler_modules():
    global HAS_COOLER, _cooler_module, _h5py_module
    if _cooler_module is not None and _h5py_module is not None:
        return _cooler_module, _h5py_module
    try:
        import cooler as cooler_module
        import h5py as h5py_module
    except ImportError:
        HAS_COOLER = False
        return None, None
    _cooler_module = cooler_module
    _h5py_module = h5py_module
    HAS_COOLER = True
    return _cooler_module, _h5py_module


def _has_s3_support() -> bool:
    try:
        from s3_utils import s3_manager as s3_mgr
    except ImportError:
        return False
    return bool(s3_mgr.is_available)


def _get_bigbed_handle(filepath):
    """Lazy import of the cached BigBed handle service."""
    from services.bigbed_handles import get_bigbed_handle

    return get_bigbed_handle(filepath)


router = APIRouter(tags=["dafc"])


def _resolve_cooler_chrom(dafc_state, chrom: str) -> Optional[str]:
    """Resolve a chromosome name against the cooler's chromsizes, trying variants."""
    return resolve_cooler_chrom(dafc_state, chrom)


# ============================================================================
# DAF-C API ENDPOINTS
# ============================================================================

@router.post("/api/dafc/load")
async def dafc_load(cool_file: str = Query(...), bigbed_file: str = Query(None),
                        dafc_state=Depends(get_dafc_state)):
    """Load a cool/mcool file and optional BigBed for DAF-C visualization.

    Supports both local files and S3 URLs (s3://bucket/path).
    s3:// maps are read by range through boto3's URL (services/cooler_open.py).
    """
    original_cool_file = cool_file
    original_bigbed_file = bigbed_file
    from services.lab.paths import confine
    confine(cool_file, urls=True)  # a lab server's data roots
    confine(bigbed_file, urls=True)
    if cool_file and not is_s3_url(cool_file):
        cool_file = normalize_local_path(cool_file)
    if bigbed_file and not is_s3_url(bigbed_file):
        bigbed_file = normalize_local_path(bigbed_file)

    cooler_module, h5py_module = _load_cooler_modules()
    if not HAS_COOLER or cooler_module is None or h5py_module is None:
        from fastapi import HTTPException
        raise HTTPException(status_code=500, detail="cooler not installed")

    # Validate cool file path
    is_s3_cool = is_s3_url(cool_file)
    if not is_s3_cool and not os.path.exists(cool_file):
        from fastapi import HTTPException
        detail = path_access_error(cool_file, original_path=original_cool_file, expected="file") or f"File not found: {cool_file}"
        raise HTTPException(status_code=404, detail=detail)

    if is_s3_cool:
        # Validate S3 access
        if _has_s3_support():
            validation = validate_s3_url(cool_file)
            if not validation['valid']:
                from fastapi import HTTPException
                raise HTTPException(status_code=404, detail=f"S3 file not accessible: {validation.get('error', 'Unknown error')}")
        else:
            from fastapi import HTTPException
            raise HTTPException(status_code=400, detail="S3 support not available. Install boto3: pip install boto3")

    is_mcool = cool_file.endswith('.mcool')

    # Everything is opened into locals first and installed together only once
    # both the map and its BigBed have loaded: a failed load leaves the
    # previous map, reads and caches as they were.
    from services.cooler_open import mcool_resolutions, open_cooler
    try:
        if is_mcool:
            # s3:// maps are read by range through boto3's URL (services/cooler_open.py)
            new_resolutions = mcool_resolutions(cool_file, h5py_module)
            # Use finest (smallest bin size) resolution by default for best detail
            # The server will switch resolutions as needed per-request
            new_res = new_resolutions[0]
            new_clr = open_cooler(cooler_module, cool_file, new_res, h5py_module)
        else:
            new_clr = open_cooler(cooler_module, cool_file, None, h5py_module)
            new_resolutions = [int(new_clr.binsize)]
            new_res = new_resolutions[0]

        new_chroms = [
            ChromInfo(name=name, size=int(size))
            for name, size in new_clr.chromsizes.items()
        ]
    except Exception as e:
        from fastapi import HTTPException
        from services.remote_sources.opening import redact
        raise HTTPException(status_code=500, detail=f"Failed to load cool file: {redact(str(e))}")

    # Load BigBed if provided
    new_bb = None
    if bigbed_file:
        is_s3_bb = is_s3_url(bigbed_file)
        if not is_s3_bb and not os.path.exists(bigbed_file):
            from fastapi import HTTPException
            detail = path_access_error(bigbed_file, original_path=original_bigbed_file, expected="file") or f"BigBed not found: {bigbed_file}"
            raise HTTPException(status_code=404, detail=detail)

        if is_s3_bb and _has_s3_support():
            # Validate S3 BigBed
            validation = validate_s3_url(bigbed_file)
            if not validation['valid']:
                from fastapi import HTTPException
                raise HTTPException(status_code=404, detail=f"S3 BigBed not accessible: {validation.get('error', 'Unknown error')}")

        try:
            # Use get_bigbed_handle which handles S3 pre-signed URLs
            new_bb = _get_bigbed_handle(bigbed_file)
            if new_bb is None:
                raise Exception("Failed to open BigBed file")
        except Exception as e:
            from fastapi import HTTPException
            raise HTTPException(status_code=500, detail=f"Failed to load BigBed: {e}")

    # Install the new map, its reads and fresh caches together.
    previous_bb = dafc_state.bb
    dafc_state.clr = new_clr
    dafc_state.resolutions = new_resolutions
    dafc_state.current_resolution = new_res
    dafc_state.cool_file = cool_file
    dafc_state.chroms = new_chroms
    dafc_state.bigbed_file = bigbed_file or None
    dafc_state.bb = new_bb
    if previous_bb is not None and previous_bb is not new_bb:
        previous_bb.close()

    # A fresh expected cache for this map (from previous file): new objects, so a
    # computation still running for the old map sees the swap and drops its result.
    from services.byte_cache import shared_cache
    dafc_state.chrom_expected_cache = shared_cache('profiles')
    dafc_state.chrom_expected_computing = set()

    # Start background precomputation of expected values for all chromosomes
    # This makes O/E global normalization fast when switching chromosomes
    import asyncio
    from concurrent.futures import ThreadPoolExecutor

    def precompute_all_chroms(resolution: int, chroms: list):
        """Background task to precompute expected values for all chromosomes."""
        for chrom_info in chroms:
            chrom = chrom_info.name
            try:
                compute_chrom_expected(chrom, resolution, allow_compute=True, dafc_state=dafc_state)
            except Exception as e:
                log_dafc_diagnostic(f"[MICROC] Background precompute failed for {chrom}: {e}")

    # Run in background thread (won't block the response)
    loop = asyncio.get_event_loop()
    chrom_list = list(dafc_state.chroms)  # Make a copy
    loop.run_in_executor(None, precompute_all_chroms, dafc_state.current_resolution, chrom_list)

    return {
        "success": True,
        "chroms": [c.model_dump() for c in dafc_state.chroms],
        "resolutions": dafc_state.resolutions,
        "current_resolution": dafc_state.current_resolution,
        "has_bigbed": dafc_state.bb is not None
    }


@router.get("/api/dafc/status")
async def dafc_status(state=Depends(get_state), dafc_state=Depends(get_dafc_state)):
    """Get DAF-C loading status."""
    # Check if we have a read data source (BigBed or BAM from main browser)
    has_read_source = dafc_state.bb is not None
    read_source_type = "bigbed" if dafc_state.bb else None
    
    if not has_read_source and state is not None and state.datasets:
        first_dataset_id = state.first_dataset_id() if hasattr(state, "first_dataset_id") else (
            state.dataset_order[0] if state.dataset_order else None
        )
        first_dataset = state.datasets.get(first_dataset_id) if first_dataset_id else None
        if first_dataset:
            has_read_source = True
            read_source_type = first_dataset.data_type
    
    return {
        "loaded": dafc_state.clr is not None,
        "cool_file": dafc_state.cool_file,
        "bigbed_file": dafc_state.bigbed_file,
        "resolutions": dafc_state.resolutions,
        "current_resolution": dafc_state.current_resolution,
        "chroms": [c.model_dump() for c in dafc_state.chroms] if dafc_state.chroms else [],
        "has_bigbed": dafc_state.bb is not None,
        "has_read_source": has_read_source,
        "read_source_type": read_source_type,
        "n_linked_sessions": len(dafc_state.linked_sessions),
    }


@router.get("/api/dafc/matrix/data")
async def dafc_matrix_data(
    chrom: str,
    start: int = Query(0),
    end: int = Query(None),
    resolution: int = Query(None),
    x_start: Optional[int] = Query(None),
    x_end: Optional[int] = Query(None),
    y_start: Optional[int] = Query(None),
    y_end: Optional[int] = Query(None),
    normalization: str = Query('none', description="Normalization: none, balanced, oe, oe_global"),
    dafc_state=Depends(get_dafc_state),
):
    """Return the numeric matrix underlying the contact-map viewport.

    Rows correspond to Y and columns to X, matching the rendered matrix endpoint.
    Display-only scaling, clipping, and colormapping are intentionally not applied.
    """
    from fastapi import HTTPException

    if dafc_state.clr is None:
        raise HTTPException(status_code=400, detail="No cool file loaded")
    cooler_module, _ = _load_cooler_modules()
    if cooler_module is None:
        raise HTTPException(status_code=500, detail="cooler not installed")

    dafc_state, res = cooler_at_resolution(dafc_state, resolution, cooler_module)
    actual_chrom = _resolve_cooler_chrom(dafc_state, chrom)
    if actual_chrom is None:
        raise HTTPException(status_code=404, detail=f"Chromosome not found: {chrom}")

    chrom_size = int(dafc_state.clr.chromsizes[actual_chrom])
    if end is None:
        end = chrom_size
    has_split_regions = all(value is not None for value in (x_start, x_end, y_start, y_end))
    if has_split_regions:
        export_x_start, export_x_end = int(x_start), int(x_end)
        export_y_start, export_y_end = int(y_start), int(y_end)
    else:
        export_x_start = export_y_start = start
        export_x_end = export_y_end = end

    use_balance = normalization == 'balanced'
    balance_applied = use_balance
    if use_balance and not cooler_has_balance_weights(dafc_state.clr, log_dafc_diagnostic):
        use_balance = False
        balance_applied = False

    try:
        region_x = f"{actual_chrom}:{export_x_start}-{export_x_end}"
        region_y = f"{actual_chrom}:{export_y_start}-{export_y_end}"
        matrix = await asyncio.to_thread(
            fetch_cooler_matrix,
            dafc_state.clr,
            region_y,
            region_x,
            balance=use_balance,
        )
    except MatrixTooLarge as exc:
        raise HTTPException(status_code=413, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to fetch matrix: {exc}")

    effective_normalization = normalization
    if normalization in ('oe', 'oe_global') and matrix.size > 0:
        # Rows are Y, columns X: an off-diagonal block needs its true genomic distances.
        origins = dict(row_origin=export_y_start // res, col_origin=export_x_start // res)
        expected_per_dist = None
        if normalization == 'oe_global':
            expected_per_dist = compute_chrom_expected(actual_chrom, res, dafc_state=dafc_state)
            if expected_per_dist is None:
                effective_normalization = 'oe'
        if effective_normalization == 'oe':
            expected_per_dist = local_expected_per_distance(matrix, max_dist=None, **origins)
        if expected_per_dist is not None:
            matrix = apply_distance_expected(matrix, expected_per_dist, invalid_fill="matrix", **origins)

    matrix = np.nan_to_num(matrix, nan=0.0, posinf=0.0, neginf=0.0)
    return {
        "matrix": matrix.tolist(),
        "chrom": actual_chrom,
        "x_start": export_x_start,
        "x_end": export_x_end,
        "y_start": export_y_start,
        "y_end": export_y_end,
        "resolution": res,
        "n_rows": int(matrix.shape[0]),
        "n_columns": int(matrix.shape[1]),
        "normalization": effective_normalization,
        "balance_applied": balance_applied,
    }


@router.get("/api/dafc/matrix/image")
async def dafc_matrix_image(
    chrom: str,
    start: int = Query(0),
    end: int = Query(None),
    resolution: int = Query(None),
    x_start: Optional[int] = Query(None),
    x_end: Optional[int] = Query(None),
    y_start: Optional[int] = Query(None),
    y_end: Optional[int] = Query(None),
    scaling: str = Query('log', description="Value scaling: linear, log, sqrt"),
    colormap: str = Query('fall', description="Colormap: red, fall, hot, viridis, blues"),
    normalization: str = Query('none', description="Normalization: none, balanced, oe, oe_global"),
    vmin: Optional[float] = Query(None, description="Min value clamp (after scaling)"),
    vmax: Optional[float] = Query(None, description="Max value clamp (after scaling)"),
    dafc_state=Depends(get_dafc_state),
):
    """Get contact matrix as PNG image.

    When x_start/x_end/y_start/y_end are provided, fetches an off-diagonal
    submatrix (X region vs Y region). Otherwise fetches the diagonal (start-end vs start-end).
    """
    from fastapi import HTTPException

    if dafc_state.clr is None:
        raise HTTPException(status_code=400, detail="No cool file loaded")
    cooler_module, _ = _load_cooler_modules()
    if cooler_module is None:
        raise HTTPException(status_code=500, detail="cooler not installed")

    # Switch resolution if needed
    # res is the resolution the matrix is actually binned at (the loaded one
    # when the file lacks the requested one): O/E distances use it.
    dafc_state, res = cooler_at_resolution(dafc_state, resolution, cooler_module)

    # Resolve chromosome name (handles chr1 vs 1 etc.)
    actual_chrom = _resolve_cooler_chrom(dafc_state, chrom)
    if actual_chrom is None:
        raise HTTPException(status_code=404, detail=f"Chromosome not found: {chrom}")

    chrom_size = int(dafc_state.clr.chromsizes[actual_chrom])
    if end is None:
        end = chrom_size

    # Determine whether to use balanced matrix
    use_balance = normalization == 'balanced'
    if use_balance and not cooler_has_balance_weights(dafc_state.clr, log_dafc_diagnostic):
        use_balance = False
        log_dafc_diagnostic(f"[MICROC] No balance weights available in cooler, falling back to raw")

    # Fetch matrix — off-diagonal if X/Y params provided, else diagonal
    try:
        if x_start is not None and x_end is not None and y_start is not None and y_end is not None:
            region_x = f"{actual_chrom}:{x_start}-{x_end}"
            region_y = f"{actual_chrom}:{y_start}-{y_end}"
            # fetch(row_region, col_region): rows=Y (vertical), cols=X (horizontal)
            matrix = await asyncio.to_thread(
                fetch_cooler_matrix,
                dafc_state.clr,
                region_y,
                region_x,
                balance=use_balance,
            )
        else:
            region = f"{actual_chrom}:{start}-{end}"
            matrix = await asyncio.to_thread(
                fetch_cooler_matrix,
                dafc_state.clr,
                region,
                balance=use_balance,
            )
    except MatrixTooLarge as e:
        raise HTTPException(status_code=413, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch matrix: {e}")

    # Apply O/E normalization if requested
    # NaN values preserved through O/E so blacklisted bins don't contaminate expected
    if normalization in ('oe', 'oe_global') and matrix.size > 0:
        # Rows are Y, columns X: an off-diagonal block needs its true genomic distances.
        split = all(v is not None for v in (x_start, x_end, y_start, y_end))
        origins = dict(row_origin=int(y_start) // res, col_origin=int(x_start) // res) if split else {}
        expected_per_dist = None
        if normalization == 'oe_global':
            expected_per_dist = compute_chrom_expected(actual_chrom, res, dafc_state=dafc_state)
            if expected_per_dist is None:
                normalization = 'oe'  # fall back to local

        if normalization == 'oe':
            max_dist = None if split else max(matrix.shape)
            expected_per_dist = local_expected_per_distance(matrix, max_dist=max_dist, **origins)

        if expected_per_dist is not None:
            matrix = apply_distance_expected(matrix, expected_per_dist, invalid_fill="matrix", **origins)

    # Replace NaN after O/E computation
    matrix = np.nan_to_num(matrix, nan=0.0, posinf=0.0, neginf=0.0)

    # Render to image
    img = await asyncio.to_thread(
        render_contact_matrix_image,
        matrix,
        scaling=scaling,
        colormap=colormap,
        vmin=vmin,
        vmax=vmax,
    )

    buf = io.BytesIO()
    img.save(buf, format='PNG')
    buf.seek(0)

    return Response(content=buf.read(), media_type="image/png")

@router.get("/api/dafc/select")
async def dafc_select(
    chrom: str,
    x_start: int,
    x_end: int,
    y_start: int,
    y_end: int,
    state=Depends(get_state),
    dafc_state=Depends(get_dafc_state),
):
    """Query a selected region for contacts and ligated reads."""
    from fastapi import HTTPException

    if dafc_state.clr is None:
        raise HTTPException(status_code=400, detail="No cool file loaded")

    # Resolve chromosome name
    actual_chrom = _resolve_cooler_chrom(dafc_state, chrom)
    if actual_chrom is None:
        raise HTTPException(status_code=404, detail=f"Chromosome not found: {chrom}")
    chrom = actual_chrom

    # Get matrix slice for contact count
    try:
        region_x = f"{chrom}:{x_start}-{x_end}"
        region_y = f"{chrom}:{y_start}-{y_end}"
        matrix = fetch_cooler_matrix(dafc_state.clr, region_y, region_x, balance=False)
        contacts = int(np.sum(matrix))
    except Exception as e:
        log_dafc_diagnostic(f"[MICROC] Error fetching contact count matrix: {e}")
        contacts = 0

    # Get reads from both regions for mode detection
    x_entries = query_reads_for_dafc(chrom, x_start, x_end, state=state, dafc_state=dafc_state)
    y_entries = query_reads_for_dafc(chrom, y_start, y_end, state=state, dafc_state=dafc_state)

    # Detect contact mode (DAF-C vs Micro-C)
    contact_mode = detect_contact_mode(x_entries, y_entries)

    # Find ligated reads (works with BAM or BigBed)
    ligated = find_ligated_reads(
        chrom,
        x_start, x_end, y_start, y_end,
        state=state,
        dafc_state=dafc_state,
    )

    return ContactSelection(
        chrom=chrom,
        x_start=x_start,
        x_end=x_end,
        y_start=y_start,
        y_end=y_end,
        contacts=contacts,
        n_ligated_reads=len(ligated),
        read_ids=[r['read_id'] for r in ligated[:200]],  # Limit for response size
        contact_mode=contact_mode.value,  # "dafc" or "microc"
    )
